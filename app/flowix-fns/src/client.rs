//! WebSocket transport for the FNS protocol.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::protocol::{action, ClientInfo, Envelope};

/// Default per-frame timeout. Sync pages can be large, so this is generous.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Default client type used when a caller does not specify one.
pub const CLIENT_TYPE: &str = "flowix";

#[derive(Debug, thiserror::Error)]
pub enum FnsError {
    #[error("websocket error: {0}")]
    WebSocket(Box<tokio_tungstenite::tungstenite::Error>),
    #[error("invalid url: {0}")]
    Url(#[from] url::ParseError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("connection closed by server")]
    Closed,
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("server error {code}: {message}")]
    Server { code: i32, message: String },
    #[error("timed out waiting for {0}")]
    Timeout(&'static str),
    #[error("sync conflict on {path}")]
    Conflict {
        path: String,
        payload: Box<crate::protocol::ConflictPayload>,
    },
}

pub type Result<T> = std::result::Result<T, FnsError>;

impl From<tokio_tungstenite::tungstenite::Error> for FnsError {
    fn from(value: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(Box::new(value))
    }
}

/// Build the WebSocket endpoint for an API base URL such as
/// `https://fns.example.com`.
///
/// `client_type` must match the scope bound to the token (`c:<type>` on the
/// server), otherwise the handshake fails with `315 scope restricted`.
pub fn sync_endpoint(
    api: &str,
    client_type: &str,
    client_name: &str,
    client_version: &str,
) -> Result<Url> {
    let mut url = Url::parse(api)?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => {
            return Err(FnsError::Protocol(format!(
                "unsupported api scheme: {other}"
            )))
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| FnsError::Protocol("failed to set websocket scheme".into()))?;
    url.set_path("/api/user/sync");
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("client", client_type)
        .append_pair("clientName", client_name)
        .append_pair("clientVersion", client_version);
    Ok(url)
}

/// A connected FNS WebSocket session.
pub struct FnsClient {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
}

impl FnsClient {
    /// Connect and perform the `Authorization` + `ClientInfo` handshake.
    pub async fn connect(
        api: &str,
        token: &str,
        info: &ClientInfo,
    ) -> Result<Self> {
        // rustls 0.23 requires an explicit process-level provider when both
        // `ring` and `aws-lc-rs` are reachable through the dependency graph.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let endpoint = sync_endpoint(api, &info.client_type, &info.name, &info.version)?;
        let (stream, _response) = connect_async(endpoint.as_str()).await?;

        let mut client = Self {
            stream,
            timeout: DEFAULT_TIMEOUT,
        };

        // Authorization carries a *raw* token, not a JSON string.
        client
            .send_frame(&format!("{}|{}", action::AUTHORIZATION, token))
            .await?;
        let (received, envelope) = client.recv_frame(action::AUTHORIZATION).await?;
        debug_assert_eq!(received, action::AUTHORIZATION);
        ensure_success(&envelope)?;

        client
            .send_json(action::CLIENT_INFO, info)
            .await?;
        let (received, envelope) = client.recv_frame(action::CLIENT_INFO).await?;
        debug_assert_eq!(received, action::CLIENT_INFO);
        ensure_success(&envelope)?;

        Ok(client)
    }

    pub async fn send_json<T: serde::Serialize + ?Sized>(
        &mut self,
        action: &str,
        payload: &T,
    ) -> Result<()> {
        let body = serde_json::to_string(payload)?;
        self.send_frame(&format!("{action}|{body}")).await
    }

    pub async fn send_frame(&mut self, frame: &str) -> Result<()> {
        self.stream
            .send(Message::Text(frame.to_owned()))
            .await?;
        Ok(())
    }

    /// Read until a text frame with the expected action arrives.
    ///
    /// The server may interleave unrelated broadcasts (e.g. `ShareSyncRefresh`);
    /// those are skipped so the caller can stay strictly request/response.
    pub async fn recv_frame(&mut self, expected_action: &str) -> Result<(String, Envelope)> {
        loop {
            let (action, envelope) = self.recv_any().await?;
            if action == expected_action {
                return Ok((action, envelope));
            }
            tracing::debug!(action, "skipping unrelated frame");
        }
    }

    /// Read the next text frame, ignoring ping/pong/keepalive frames.
    pub async fn recv_any(&mut self) -> Result<(String, Envelope)> {
        loop {
            let message = tokio::time::timeout(self.timeout, self.stream.next())
                .await
                .map_err(|_| FnsError::Timeout("frame"))?
                .ok_or(FnsError::Closed)??;

            match message {
                Message::Text(text) => {
                    let (action, body) = text
                        .split_once('|')
                        .ok_or_else(|| FnsError::Protocol(format!("missing action separator: {text}")))?;
                    // An empty body (e.g. some broadcasts) decodes to a default envelope.
                    let envelope = if body.trim().is_empty() {
                        serde_json::from_str("{}")?
                    } else {
                        serde_json::from_str(body)?
                    };
                    return Ok((action.to_owned(), envelope));
                }
                Message::Binary(_) => continue,
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(frame) => {
                    tracing::debug!(?frame, "server closed the connection");
                    return Err(FnsError::Closed);
                }
                Message::Frame(_) => continue,
            }
        }
    }

    pub async fn close(mut self) -> Result<()> {
        self.stream.close(None).await?;
        Ok(())
    }
}

pub fn ensure_success(envelope: &Envelope) -> Result<()> {
    if envelope.status && envelope.code <= crate::protocol::CODE_SUCCESS {
        return Ok(());
    }
    Err(FnsError::Server {
        code: envelope.code,
        message: envelope
            .message
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_rewrites_scheme_and_path() {
        let url = sync_endpoint("https://fns.example.com", "flowix", "Flowix", "1.0").unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.path(), "/api/user/sync");
        assert!(url.query().unwrap().contains("client=flowix"));
    }

    #[test]
    fn endpoint_rejects_unknown_scheme() {
        assert!(sync_endpoint("ftp://example.com", "flowix", "Flowix", "1.0").is_err());
    }
}

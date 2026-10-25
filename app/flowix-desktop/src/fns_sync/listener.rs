//! Realtime change listener.
//!
//! Keeps one persistent WebSocket connection per bound FNS token and turns
//! server-pushed change broadcasts (`NoteSyncModify`, `FileSyncDelete`, …)
//! into debounced notebook syncs through [`FnsSyncService::schedule_sync`].
//!
//! The push only *triggers* a sync; it is never applied directly. The regular
//! pull flow (cursors, mtime comparison, server-side merge) does all the
//! work, so conflict handling is exactly the same as for any other sync.
//!
//! Connection lifecycle:
//! - one supervisor task re-plans the desired connections whenever the epoch
//!   (bumped by config or binding changes) advances;
//! - each connection reconnects with capped exponential backoff when the
//!   server drops it;
//! - our own pushes also come back as broadcasts (the server only excludes
//!   the *originating* connection, and syncs run on separate short-lived
//!   connections). They trigger one extra no-op sync per push batch, which
//!   terminates because a no-op sync writes nothing and therefore broadcasts
//!   nothing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use flowix_fns::{action, ClientInfo, Envelope, FnsClient, FnsError, Incoming, SyncState};

use crate::app::state::AppState;
use crate::fns_sync::config::FnsToken;
use crate::fns_sync::service::FnsSyncService;
use crate::lock_utils::read_lock;

/// Server broadcasts worth reacting to. Any of them means "this vault
/// moved"; the debounced sync that follows pulls the details.
const CHANGE_ACTIONS: &[&str] = &[
    action::NOTE_SYNC_MODIFY,
    action::NOTE_SYNC_DELETE,
    action::NOTE_SYNC_RENAME,
    action::NOTE_SYNC_NEED_PUSH,
    action::NOTE_SYNC_MTIME,
    action::FILE_SYNC_UPDATE,
    action::FILE_SYNC_DELETE,
    action::FILE_SYNC_MTIME,
    action::FILE_UPLOAD,
];

/// Idle window for the listener read loop. The server pings every 25s, so a
/// healthy connection never stays silent this long; a timeout is treated as
/// a liveness probe (send our own ping), not a fatal error.
const LISTENER_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Reconnect backoff: doubles from here, capped at [`RECONNECT_MAX`].
const RECONNECT_MIN: Duration = Duration::from_secs(2);
const RECONNECT_MAX: Duration = Duration::from_secs(60);

/// One desired connection: a bound token plus the vaults it serves.
struct ConnSpec {
    token: FnsToken,
    /// vault -> notebook ids bound to this token, captured at plan time.
    /// Binding changes bump the epoch, which forces a re-plan, so this map
    /// never goes stale within one connection.
    vault_map: HashMap<String, Vec<String>>,
}

/// Oversees the realtime listener connections.
pub struct FnsListener {
    /// Bumped to make the supervisor re-plan and current connections exit.
    epoch_tx: watch::Sender<u64>,
    supervisor_started: AtomicBool,
}

impl FnsListener {
    pub fn new() -> Self {
        let (epoch_tx, _) = watch::channel(0);
        Self {
            epoch_tx,
            supervisor_started: AtomicBool::new(false),
        }
    }

    /// Spawn the supervisor exactly once; later config or binding changes go
    /// through [`FnsListener::restart`], which the supervisor picks up on its
    /// watch channel.
    pub fn start(&self, app: AppHandle, service: Weak<FnsSyncService>) {
        if self.supervisor_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut rx = self.epoch_tx.subscribe();
        tauri::async_runtime::spawn(async move {
            supervise(app, service, &mut rx).await;
        });
    }

    /// Re-plan connections: credentials or notebook bindings changed.
    pub fn restart(&self) {
        let next = self.epoch_tx.borrow().wrapping_add(1);
        let _ = self.epoch_tx.send(next);
    }
}

impl Default for FnsListener {
    fn default() -> Self {
        Self::new()
    }
}

/// Re-plan on every epoch bump and spawn one task per desired connection.
async fn supervise(
    app: AppHandle,
    service: Weak<FnsSyncService>,
    rx: &mut watch::Receiver<u64>,
) {
    loop {
        if let Some(service) = service.upgrade() {
            for spec in plan_specs(&app, &service) {
                let task_rx = rx.clone();
                let task_app = app.clone();
                let task_service = service.clone();
                tauri::async_runtime::spawn(async move {
                    run_connection(task_app, task_service, spec, task_rx).await;
                });
            }
        }
        if rx.changed().await.is_err() {
            // Sender dropped: the service (and with it the app) is gone.
            return;
        }
        // Mark the new epoch as seen, otherwise the next `changed()` fires
        // immediately and the supervisor respawns connections in a hot loop.
        let _ = rx.borrow_and_update();
    }
}

/// Collect the tokens that actually serve bound notebooks, with their
/// vault -> notebooks mapping. Only ready configs produce specs.
fn plan_specs(app: &AppHandle, service: &FnsSyncService) -> Vec<ConnSpec> {
    let config = service.config_snapshot();
    if !config.is_ready() {
        return Vec::new();
    }

    let state = app.state::<AppState>();
    let notebooks = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        match memo_file.read_notebook_configs() {
            Ok(notebooks) => notebooks,
            Err(error) => {
                tracing::warn!("FNS listener: could not list notebooks: {error}");
                return Vec::new();
            }
        }
    };

    let bound = notebooks.into_iter().filter_map(|notebook| {
        let root = PathBuf::from(&notebook.path);
        let state = SyncState::load(&root).ok()??;
        if state.token_id.is_empty() || state.vault.trim().is_empty() {
            return None;
        }
        Some((state.token_id, state.vault, notebook.id))
    });
    let grouped = group_bound_vaults(bound);

    grouped
        .into_iter()
        .filter_map(|(token_id, vault_map)| {
            let token = config.token(&token_id)?.clone();
            Some(ConnSpec { token, vault_map })
        })
        .collect()
}

/// Fold `(token_id, vault, notebook_id)` triples into
/// `token_id -> vault -> [notebook_id]`.
fn group_bound_vaults(
    bound: impl Iterator<Item = (String, String, String)>,
) -> HashMap<String, HashMap<String, Vec<String>>> {
    let mut grouped: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    for (token_id, vault, notebook_id) in bound {
        grouped
            .entry(token_id)
            .or_default()
            .entry(vault)
            .or_default()
            .push(notebook_id);
    }
    grouped
}

/// Extract the vault from a broadcast frame worth reacting to. `None` for
/// anything else (acks, keepalives, other vaults' noise). Deliberately
/// lenient about the status code: these actions are only ever emitted for
/// real changes, and some broadcasts arrive with an empty body.
fn broadcast_vault(action: &str, envelope: &Envelope) -> Option<String> {
    if !CHANGE_ACTIONS.contains(&action) {
        return None;
    }
    envelope
        .vault
        .clone()
        .filter(|vault| !vault.trim().is_empty())
}

/// One persistent connection per bound token, reconnecting until the epoch
/// moves on.
async fn run_connection(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    spec: ConnSpec,
    mut rx: watch::Receiver<u64>,
) {
    let token = &spec.token;
    let info = ClientInfo {
        name: "Flowix".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        client_type: token.client_type.clone(),
        offline_sync_strategy: None,
    };

    let mut backoff = RECONNECT_MIN;
    loop {
        tracing::info!(
            label = %token.label,
            vaults = spec.vault_map.len(),
            "FNS listener: connecting"
        );
        match FnsClient::connect(&service.config_snapshot().api, &token.token, &info).await {
            Ok(mut client) => {
                backoff = RECONNECT_MIN;
                client.set_timeout(LISTENER_IDLE_TIMEOUT);
                tracing::info!(label = %token.label, "FNS listener: connected");
                match listen(&app, &service, &spec, &mut client, &mut rx).await {
                    ListenerExit::Restarted => return,
                    ListenerExit::Disconnected => {}
                }
                // Server hung up; fall through to the backoff below.
                tracing::info!(label = %token.label, "FNS listener: disconnected");
            }
            Err(error) => {
                tracing::warn!(
                    label = %token.label,
                    "FNS listener: connect failed: {error}"
                );
            }
        }

        let sleep = tokio::time::sleep(backoff);
        tokio::select! {
            _ = sleep => {}
            // Any epoch bump supersedes this connection; the supervisor has
            // already spawned its replacement.
            _ = rx.changed() => return,
        }
        backoff = backoff.saturating_mul(2).min(RECONNECT_MAX);
    }
}

enum ListenerExit {
    /// Epoch moved: the connection is superseded, stop without reconnecting.
    Restarted,
    /// Connection died: the caller should back off and reconnect.
    Disconnected,
}

/// Read broadcasts until the connection dies or the epoch moves on.
async fn listen(
    app: &AppHandle,
    service: &Arc<FnsSyncService>,
    spec: &ConnSpec,
    client: &mut FnsClient,
    rx: &mut watch::Receiver<u64>,
) -> ListenerExit {
    loop {
        let frame = tokio::select! {
            // Epoch moved (or the service is shutting down): the supervisor
            // owns the replacement, this connection just goes away.
            _ = rx.changed() => return ListenerExit::Restarted,
            frame = client.recv_incoming() => frame,
        };
        match frame {
            Ok(Incoming::Text { action, envelope }) => {
                if let Some(vault) = broadcast_vault(&action, &envelope) {
                    sync_vault(app, service, spec, &vault);
                }
            }
            Ok(Incoming::Binary(_)) => {}
            Err(FnsError::Timeout(_)) => {
                // Silent for a whole idle window. Probe and let the next
                // read surface a hard failure if the link is actually dead.
                if let Err(error) = client.ping().await {
                    tracing::debug!("FNS listener: keepalive ping failed: {error}");
                    return ListenerExit::Disconnected;
                }
            }
            Err(error) => {
                tracing::debug!("FNS listener: read failed: {error}");
                return ListenerExit::Disconnected;
            }
        }
    }
}

/// Turn one broadcast into debounced syncs for every notebook bound to the
/// changed vault under this token.
fn sync_vault(
    app: &AppHandle,
    service: &Arc<FnsSyncService>,
    spec: &ConnSpec,
    vault: &str,
) {
    let Some(notebook_ids) = spec.vault_map.get(vault) else {
        return;
    };
    for notebook_id in notebook_ids {
        tracing::debug!(
            vault = %vault,
            notebook_id = %notebook_id,
            "FNS listener: change broadcast, scheduling sync"
        );
        service.schedule_sync(app.clone(), notebook_id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(vault: &str) -> Envelope {
        serde_json::from_value(serde_json::json!({
            "code": 200,
            "status": true,
            "vault": vault,
        }))
        .unwrap()
    }

    #[test]
    fn change_actions_with_vault_are_broadcasts() {
        assert_eq!(
            broadcast_vault(action::NOTE_SYNC_MODIFY, &envelope("MyNotes")),
            Some("MyNotes".to_owned())
        );
        assert_eq!(
            broadcast_vault(action::FILE_SYNC_DELETE, &envelope("v2")),
            Some("v2".to_owned())
        );
    }

    #[test]
    fn unrelated_frames_are_ignored() {
        assert_eq!(broadcast_vault(action::NOTE_SYNC_END, &envelope("v")), None);
        assert_eq!(broadcast_vault("NoteSyncAck", &envelope("v")), None);
    }

    #[test]
    fn broadcasts_without_vault_are_ignored() {
        let envelope: Envelope = serde_json::from_str("{}").unwrap();
        assert_eq!(broadcast_vault(action::NOTE_SYNC_MODIFY, &envelope), None);
        let blank = serde_json::from_value(serde_json::json!({
            "code": 200,
            "status": true,
            "vault": "  ",
        }))
        .unwrap();
        assert_eq!(broadcast_vault(action::NOTE_SYNC_MODIFY, &blank), None);
    }

    #[test]
    fn grouping_folds_triples_by_token_and_vault() {
        let grouped = group_bound_vaults(
            [
                ("t1", "vault-a", "n1"),
                ("t1", "vault-a", "n2"),
                ("t1", "vault-b", "n3"),
                ("t2", "vault-a", "n4"),
            ]
            .into_iter()
            .map(|(t, v, n)| (t.to_owned(), v.to_owned(), n.to_owned())),
        );
        let t1 = &grouped["t1"];
        assert_eq!(t1["vault-a"], vec!["n1".to_owned(), "n2".to_owned()]);
        assert_eq!(t1["vault-b"], vec!["n3".to_owned()]);
        assert_eq!(grouped["t2"]["vault-a"], vec!["n4".to_owned()]);
    }
}

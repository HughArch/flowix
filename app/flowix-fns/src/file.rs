//! Attachment (file) synchronization.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::client::{ensure_success, FnsClient, FnsError, Incoming, Result};
use crate::protocol::{
    action, Envelope, FileChunkDownloadRequest, FileSyncCheckRequest, FileSyncDelFile,
    FileSyncDelete, FileSyncDownload, FileSyncEnd, FileSyncModify, FileSyncMtime, FileSyncRequest,
    FileSyncUpload, FileUploadAck, SyncPageAckRequest, SyncPageMessage,
};
use crate::sync::new_context;

/// Everything the server asked us to do during one `FileSync` round.
#[derive(Debug, Default)]
pub struct PullFilesResult {
    /// Remote files the client should download.
    pub updated: Vec<FileSyncModify>,
    pub deleted: Vec<FileSyncDelete>,
    pub mtime_only: Vec<FileSyncMtime>,
    /// Prepared upload sessions for local files the server does not have yet.
    pub uploads: Vec<FileSyncUpload>,
    pub last_time: i64,
    pub end: Option<FileSyncEnd>,
}

impl PullFilesResult {
    pub fn is_empty(&self) -> bool {
        self.updated.is_empty()
            && self.deleted.is_empty()
            && self.mtime_only.is_empty()
            && self.uploads.is_empty()
    }
}

/// Pull remote attachment changes. `local_files` should only contain files the
/// client wants synced (already filtered by the configured size limit).
pub async fn pull_files(
    client: &mut FnsClient,
    vault: &str,
    last_time: i64,
    local_files: Vec<FileSyncCheckRequest>,
    del_files: Vec<FileSyncDelFile>,
) -> Result<PullFilesResult> {
    let context = new_context();
    let request = FileSyncRequest {
        context: context.clone(),
        vault: vault.to_owned(),
        last_time,
        batch_index: 0,
        total_batches: 1,
        files: local_files,
        del_files,
        missing_files: Vec::new(),
    };

    client.send_json(action::FILE_SYNC, &request).await?;
    let (_, envelope) = client.recv_frame(action::FILE_SYNC_END).await?;
    ensure_success(&envelope)?;
    let end: FileSyncEnd = envelope.parse_data()?;

    let mut result = PullFilesResult {
        last_time: end.last_time,
        end: Some(end.clone()),
        ..Default::default()
    };

    let pending = end.need_upload_count
        + end.need_modify_count
        + end.need_sync_mtime_count
        + end.need_delete_count;
    if pending == 0 {
        return Ok(result);
    }

    send_page_ack(client, &context, vault, -1).await?;

    loop {
        let (page_action, page_envelope) = client.recv_any().await?;
        if page_action != action::FILE_SYNC_PAGE {
            tracing::debug!(page_action, "skipping frame while waiting for file page");
            continue;
        }
        ensure_success(&page_envelope)?;
        let page: SyncPageMessage = page_envelope.parse_data()?;

        let mut received = 0;
        while received < page.total_count.max(0) as usize {
            let (item_action, item_envelope) = client.recv_any().await?;
            if dispatch_item(&item_action, &item_envelope, &mut result)? {
                received += 1;
            }
        }

        if page.is_last {
            break;
        }
        send_page_ack(client, &context, vault, page.page_index).await?;
    }

    Ok(result)
}

/// Returns `true` when the frame was a file-sync item (so the page counter can
/// advance). Unrelated broadcasts are skipped.
fn dispatch_item(
    action_name: &str,
    envelope: &Envelope,
    out: &mut PullFilesResult,
) -> Result<bool> {
    match action_name {
        action::FILE_SYNC_UPDATE => out.updated.push(envelope.parse_data()?),
        action::FILE_SYNC_DELETE => out.deleted.push(envelope.parse_data()?),
        action::FILE_SYNC_MTIME => out.mtime_only.push(envelope.parse_data()?),
        action::FILE_UPLOAD => out.uploads.push(envelope.parse_data()?),
        other => {
            tracing::debug!(other, "skipping unrelated frame during file sync");
            return Ok(false);
        }
    }
    Ok(true)
}

async fn send_page_ack(
    client: &mut FnsClient,
    context: &str,
    vault: &str,
    page_index: i32,
) -> Result<()> {
    client
        .send_json(
            action::FILE_SYNC_PAGE_ACK,
            &SyncPageAckRequest {
                context: context.to_owned(),
                vault: vault.to_owned(),
                page_index,
            },
        )
        .await
}

/// Upload one file using a session the server already prepared.
pub async fn upload_file(
    client: &mut FnsClient,
    upload: &FileSyncUpload,
    data: &[u8],
) -> Result<FileUploadAck> {
    let chunk_size = upload.chunk_size.max(1) as usize;
    let total = data.len().div_ceil(chunk_size);

    for index in 0..total {
        let start = index * chunk_size;
        let end = (start + chunk_size).min(data.len());
        client
            .send_binary_chunk(&upload.session_id, index as u32, &data[start..end])
            .await?;
    }

    // The server completes the session once all bytes arrive and replies with
    // a text ack.
    loop {
        let (item_action, envelope) = client.recv_any().await?;
        if item_action == action::FILE_UPLOAD_ACK {
            ensure_success(&envelope)?;
            return Ok(envelope.parse_data()?);
        }
        tracing::debug!(item_action, "skipping frame while waiting for upload ack");
    }
}

/// Download one file. The server streams chunks right after the metadata
/// message.
pub async fn download_file(
    client: &mut FnsClient,
    vault: &str,
    path: &str,
    path_hash: &str,
) -> Result<Vec<u8>> {
    let context = new_context();
    client
        .send_json(
            action::FILE_CHUNK_DOWNLOAD,
            &FileChunkDownloadRequest {
                vault: vault.to_owned(),
                path: path.to_owned(),
                path_hash: path_hash.to_owned(),
                context: Some(context.clone()),
            },
        )
        .await?;

    let (_, envelope) = client.recv_frame(action::FILE_SYNC_CHUNK_DOWNLOAD).await?;
    ensure_success(&envelope)?;
    let meta: FileSyncDownload = envelope.parse_data()?;

    if meta.size < 0 || meta.total_chunks < 0 {
        return Err(FnsError::Protocol("invalid download metadata".into()));
    }

    let total_chunks = meta.total_chunks as usize;
    let mut chunks: BTreeMap<u32, Vec<u8>> = BTreeMap::new();

    while chunks.len() < total_chunks {
        match client.recv_incoming().await? {
            Incoming::Binary(payload) => {
                if payload.len() < 40 {
                    return Err(FnsError::Protocol("download chunk too short".into()));
                }
                let session = &payload[..36];
                if session != meta.session_id.as_bytes() {
                    continue;
                }
                let index = u32::from_be_bytes([
                    payload[36],
                    payload[37],
                    payload[38],
                    payload[39],
                ]);
                chunks.insert(index, payload[40..].to_vec());
            }
            Incoming::Text { action, .. } => {
                tracing::debug!(action, "skipping text frame during download");
            }
        }
    }

    let mut out = Vec::with_capacity(meta.size.max(0) as usize);
    for index in 0..total_chunks {
        let Some(chunk) = chunks.remove(&(index as u32)) else {
            return Err(FnsError::Protocol(format!(
                "missing download chunk {index}/{total_chunks}"
            )));
        };
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Requests an upload session for a local file the server may not know about.
pub async fn upload_check(
    client: &mut FnsClient,
    vault: &str,
    path: &str,
    path_hash: &str,
    content_hash: &str,
    size: i64,
    ctime: i64,
    mtime: i64,
) -> Result<Option<FileSyncUpload>> {
    let context = new_context();
    client
        .send_json(
            action::FILE_UPLOAD_CHECK,
            &crate::protocol::FileUploadCheckRequest {
                vault: vault.to_owned(),
                path: path.to_owned(),
                path_hash: path_hash.to_owned(),
                content_hash: content_hash.to_owned(),
                size,
                ctime,
                mtime,
                context: Some(context),
            },
        )
        .await?;

    loop {
        let (item_action, envelope) = client.recv_any().await?;
        match item_action.as_str() {
            action::FILE_UPLOAD => {
                ensure_success(&envelope)?;
                return Ok(Some(envelope.parse_data()?));
            }
            action::FILE_SYNC_MTIME | action::FILE_SYNC_END => return Ok(None),
            other => {
                // `FileUploadCheck` may answer with a bare success envelope.
                if envelope.code == crate::protocol::CODE_SUCCESS && envelope.data.is_none() {
                    return Ok(None);
                }
                tracing::debug!(other, "skipping frame during upload check");
            }
        }
    }
}

/// The server auto-completes a session when the last chunk arrives; give the
/// ack a bounded amount of time.
pub const UPLOAD_ACK_TIMEOUT: Duration = Duration::from_secs(60);

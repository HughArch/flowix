//! High-level note sync flows built on [`FnsClient`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::{ensure_success, FnsClient, FnsError, Result};
use crate::hash::{content_hash, path_hash};
use crate::protocol::{
    action, Envelope, NoteDeleteRequest, NoteModifyAck, NoteModifyOrCreateRequest,
    NoteSyncCheckRequest, NoteSyncDelNote, NoteSyncDelete, NoteSyncEnd, NoteSyncModify,
    NoteSyncMtime, NoteSyncNeedPush, NoteSyncRename, NoteSyncRequest, OfflineSyncStrategy,
    SyncPageAckRequest, SyncPageMessage, CODE_SYNC_CONFLICT,
};

static CONTEXT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Generate a unique sync context. The server echoes it on every frame so the
/// client can match a response to its request.
pub fn new_context() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let seq = CONTEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("flowix_{millis}_{seq}")
}

/// Everything the server pushed during one `NoteSync` round.
#[derive(Debug, Default)]
pub struct PullResult {
    pub modified: Vec<NoteSyncModify>,
    pub deleted: Vec<NoteSyncDelete>,
    pub renamed: Vec<NoteSyncRename>,
    pub mtime_only: Vec<NoteSyncMtime>,
    pub need_push: Vec<NoteSyncNeedPush>,
    /// New incremental cursor; persist this and pass it to the next pull.
    pub last_time: i64,
    pub end: Option<NoteSyncEnd>,
}

impl PullResult {
    pub fn is_empty(&self) -> bool {
        self.modified.is_empty()
            && self.deleted.is_empty()
            && self.renamed.is_empty()
            && self.mtime_only.is_empty()
            && self.need_push.is_empty()
    }
}

/// Pull remote changes for a vault.
///
/// `local_notes` describes what this client already has. Passing an empty vec
/// means "I have nothing", which makes the server push every note.
pub async fn pull_notes(
    client: &mut FnsClient,
    vault: &str,
    last_time: i64,
    local_notes: Vec<NoteSyncCheckRequest>,
    del_notes: Vec<NoteSyncDelNote>,
    strategy: OfflineSyncStrategy,
) -> Result<PullResult> {
    let context = new_context();
    let request = NoteSyncRequest {
        context: context.clone(),
        vault: vault.to_owned(),
        last_time,
        batch_index: 0,
        total_batches: 1,
        notes: local_notes,
        del_notes,
        missing_notes: Vec::new(),
    };

    client.send_json(action::NOTE_SYNC, &request).await?;
    if std::env::var_os("FNS_DEBUG").is_some() {
        eprintln!(
            "[fns] NoteSync request: {}",
            serde_json::to_string(&request).unwrap_or_default()
        );
    }
    let (_, envelope) = client.recv_frame(action::NOTE_SYNC_END).await?;
    ensure_success(&envelope)?;
    let end: NoteSyncEnd = envelope.parse_data()?;
    if std::env::var_os("FNS_DEBUG").is_some() {
        eprintln!("[fns] NoteSyncEnd: {end:?}");
    }

    let mut result = PullResult {
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

    // Ask for the first page. Negative index is the documented "start" signal.
    send_page_ack(client, &context, vault, -1).await?;

    let mut received: i64 = 0;
    loop {
        let (page_action, page_envelope) = client.recv_any().await?;
        if page_action != action::NOTE_SYNC_PAGE {
            tracing::debug!(page_action, "skipping frame while waiting for page header");
            continue;
        }
        ensure_success(&page_envelope)?;
        let page: SyncPageMessage = page_envelope.parse_data()?;

        for _ in 0..page.total_count {
            let (item_action, item_envelope) = client.recv_any().await?;
            received += 1;
            dispatch_item(&item_action, &item_envelope, &mut result)?;
        }

        if page.is_last {
            break;
        }
        send_page_ack(client, &context, vault, page.page_index).await?;
    }

    tracing::debug!(
        received,
        pending,
        strategy = strategy.as_str(),
        "note sync finished"
    );
    Ok(result)
}

fn dispatch_item(action_name: &str, envelope: &Envelope, out: &mut PullResult) -> Result<()> {
    match action_name {
        action::NOTE_SYNC_MODIFY => out.modified.push(envelope.parse_data()?),
        action::NOTE_SYNC_DELETE => out.deleted.push(envelope.parse_data()?),
        action::NOTE_SYNC_RENAME => out.renamed.push(envelope.parse_data()?),
        action::NOTE_SYNC_MTIME => out.mtime_only.push(envelope.parse_data()?),
        action::NOTE_SYNC_NEED_PUSH => out.need_push.push(envelope.parse_data()?),
        other => {
            return Err(FnsError::Protocol(format!(
                "unexpected sync item action: {other}"
            )))
        }
    }
    Ok(())
}

async fn send_page_ack(
    client: &mut FnsClient,
    context: &str,
    vault: &str,
    page_index: i32,
) -> Result<()> {
    client
        .send_json(
            action::NOTE_SYNC_PAGE_ACK,
            &SyncPageAckRequest {
                context: context.to_owned(),
                vault: vault.to_owned(),
                page_index,
            },
        )
        .await
}

/// Upload one note. `base_hash` is the content hash this edit was based on;
/// when it no longer matches the server, the server may return a conflict.
pub struct PushNote<'a> {
    pub vault: &'a str,
    pub path: &'a str,
    pub content: &'a str,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
    pub base_hash: Option<String>,
    pub create_only: bool,
}

pub async fn push_note(client: &mut FnsClient, note: PushNote<'_>) -> Result<NoteModifyAck> {
    let request = NoteModifyOrCreateRequest {
        vault: note.vault.to_owned(),
        path: note.path.to_owned(),
        path_hash: path_hash(note.path),
        base_hash: note.base_hash,
        base_hash_missing: false,
        content: note.content.to_owned(),
        content_hash: content_hash(note.content),
        ctime: note.ctime_ms,
        mtime: note.mtime_ms,
        create_only: note.create_only,
        context: Some(new_context()),
        is_conflict_resolved: false,
    };

    client.send_json(action::NOTE_MODIFY, &request).await?;

    loop {
        let (item_action, envelope) = client.recv_any().await?;
        if envelope.code == CODE_SYNC_CONFLICT {
            let payload = envelope.parse_data().unwrap_or_default();
            return Err(FnsError::Conflict {
                path: note.path.to_owned(),
                payload: Box::new(payload),
            });
        }
        if item_action == action::NOTE_MODIFY_ACK {
            ensure_success(&envelope)?;
            return Ok(envelope.parse_data()?);
        }
        tracing::debug!(item_action, "skipping frame while waiting for modify ack");
    }
}

pub async fn delete_note(client: &mut FnsClient, vault: &str, path: &str) -> Result<()> {
    let request = NoteDeleteRequest {
        vault: vault.to_owned(),
        path: path.to_owned(),
        path_hash: path_hash(path),
        context: Some(new_context()),
    };
    client.send_json(action::NOTE_DELETE, &request).await?;
    let (item_action, envelope) = client.recv_frame(action::NOTE_DELETE_ACK).await?;
    debug_assert_eq!(item_action, action::NOTE_DELETE_ACK);
    ensure_success(&envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contexts_are_unique() {
        let a = new_context();
        let b = new_context();
        assert_ne!(a, b);
        assert!(a.starts_with("flowix_"));
    }
}

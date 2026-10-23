//! Wire types for the Fast Note Sync Service (FNS) WebSocket protocol.
//!
//! Frames are `Action|JSON`. JSON payloads are wrapped in [`Envelope`] on the
//! server-to-client direction; client-to-server payloads are the raw request
//! bodies below.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

pub mod action {
    // client -> server
    pub const AUTHORIZATION: &str = "Authorization";
    pub const CLIENT_INFO: &str = "ClientInfo";
    pub const NOTE_SYNC: &str = "NoteSync";
    pub const NOTE_MODIFY: &str = "NoteModify";
    pub const NOTE_DELETE: &str = "NoteDelete";
    pub const NOTE_RENAME: &str = "NoteRename";
    pub const NOTE_SYNC_PAGE_ACK: &str = "NoteSyncPageAck";

    // server -> client
    pub const NOTE_SYNC_MODIFY: &str = "NoteSyncModify";
    pub const NOTE_SYNC_DELETE: &str = "NoteSyncDelete";
    pub const NOTE_SYNC_RENAME: &str = "NoteSyncRename";
    pub const NOTE_SYNC_MTIME: &str = "NoteSyncMtime";
    pub const NOTE_SYNC_NEED_PUSH: &str = "NoteSyncNeedPush";
    pub const NOTE_SYNC_END: &str = "NoteSyncEnd";
    pub const NOTE_SYNC_PAGE: &str = "NoteSyncPage";
    pub const NOTE_MODIFY_ACK: &str = "NoteModifyAck";
    pub const NOTE_DELETE_ACK: &str = "NoteDeleteAck";
}

/// `ErrorSyncConflict`: the server needs the client to resolve a conflict
/// manually and resend `NoteModify` with `isConflictResolved = true`.
pub const CODE_SYNC_CONFLICT: i32 = 530;
/// Server reports success with this business code.
pub const CODE_SUCCESS: i32 = 200;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/// Envelope used by every server-to-client frame.
#[derive(Debug, Clone, Deserialize)]
pub struct Envelope {
    #[serde(default)]
    pub code: i32,
    #[serde(default)]
    pub status: bool,
    #[serde(default)]
    pub message: Option<Value>,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub details: Option<Value>,
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// 1-based page number on the wire; absent for non-paginated messages.
    #[serde(default, rename = "pageIndex")]
    pub page_index: Option<i64>,
}

impl Envelope {
    pub fn parse_data<T: for<'de> Deserialize<'de>>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.data.clone().unwrap_or(Value::Null))
    }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub client_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_sync_strategy: Option<String>,
}

/// Offline merge strategies understood by the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflineSyncStrategy {
    /// Newer mtime wins; the server may overwrite the client.
    NewTimeMerge,
    /// Ignore mtime and let the client overwrite.
    IgnoreTimeMerge,
    /// Reject with code 530 and hand both versions back to the client.
    ManualMerge,
}

impl OfflineSyncStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewTimeMerge => "newTimeMerge",
            Self::IgnoreTimeMerge => "ignoreTimeMerge",
            Self::ManualMerge => "manualMerge",
        }
    }
}

// ---------------------------------------------------------------------------
// Note sync (pull)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncCheckRequest {
    pub path: String,
    pub path_hash: String,
    pub content_hash: String,
    pub mtime: i64,
    pub ctime: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncDelNote {
    pub path: String,
    pub path_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncRequest {
    pub context: String,
    pub vault: String,
    pub last_time: i64,
    pub batch_index: i32,
    pub total_batches: i32,
    pub notes: Vec<NoteSyncCheckRequest>,
    pub del_notes: Vec<NoteSyncDelNote>,
    pub missing_notes: Vec<NoteSyncDelNote>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncEnd {
    pub last_time: i64,
    #[serde(default)]
    pub need_upload_count: i64,
    #[serde(default)]
    pub need_modify_count: i64,
    #[serde(default)]
    pub need_sync_mtime_count: i64,
    #[serde(default)]
    pub need_delete_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncModify {
    pub path: String,
    pub path_hash: String,
    #[serde(default)]
    pub content: String,
    pub content_hash: String,
    #[serde(default)]
    pub ctime: i64,
    #[serde(default)]
    pub mtime: i64,
    #[serde(default, rename = "lastTime")]
    pub updated_timestamp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncDelete {
    pub path: String,
    pub path_hash: String,
    #[serde(default)]
    pub ctime: i64,
    #[serde(default)]
    pub mtime: i64,
    #[serde(default)]
    pub size: i64,
    #[serde(default, rename = "lastTime")]
    pub updated_timestamp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncRename {
    pub path: String,
    pub path_hash: String,
    #[serde(default, rename = "oldPath")]
    pub old_path: String,
    #[serde(default, rename = "oldPathHash")]
    pub old_path_hash: String,
    #[serde(default, rename = "lastTime")]
    pub updated_timestamp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncMtime {
    pub path: String,
    #[serde(default)]
    pub ctime: i64,
    #[serde(default)]
    pub mtime: i64,
    #[serde(default, rename = "lastTime")]
    pub updated_timestamp: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncNeedPush {
    pub path: String,
    pub path_hash: String,
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPageMessage {
    pub page_index: i32,
    pub page_size: i32,
    pub total_count: i32,
    pub is_last: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPageAckRequest {
    pub context: String,
    pub vault: String,
    /// `-1` requests the first page; otherwise acknowledges the given page.
    pub page_index: i32,
}

// ---------------------------------------------------------------------------
// Note modify (push)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteModifyOrCreateRequest {
    pub vault: String,
    pub path: String,
    pub path_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_hash: Option<String>,
    #[serde(default)]
    pub base_hash_missing: bool,
    pub content: String,
    pub content_hash: String,
    pub ctime: i64,
    pub mtime: i64,
    #[serde(default)]
    pub create_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default)]
    pub is_conflict_resolved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteModifyAck {
    pub last_time: i64,
    pub path: String,
    pub path_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteRequest {
    pub vault: String,
    pub path: String,
    pub path_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// Payload returned with `530` when the server needs manual conflict
/// resolution.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub path_hash: String,
    #[serde(default)]
    pub server_content: String,
    #[serde(default)]
    pub base_content: String,
    #[serde(default)]
    pub server_hash: String,
}

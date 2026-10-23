//! Client for Fast Note Sync Service (FNS).
//!
//! This crate is deliberately free of Tauri and Flowix storage dependencies so
//! it can be reused by the desktop shell, the CLI and future mobile targets.
//!
//! Wire protocol summary:
//! - frames are `Action|JSON`
//! - handshake: `Authorization|<raw token>` then `ClientInfo|{...}`
//! - incremental pull: `NoteSync` -> `NoteSyncEnd` -> `PageAck(-1)` -> pages

pub mod client;
pub mod hash;
pub mod protocol;
pub mod sync;

pub use client::{sync_endpoint, FnsClient, FnsError, Result, CLIENT_TYPE};
pub use hash::{content_hash, encode_hash32, encode_hash32_bytes, path_hash};
pub use protocol::{
    action, ClientInfo, Envelope, NoteSyncCheckRequest, NoteSyncDelete, NoteSyncEnd,
    NoteSyncModify, NoteSyncMtime, NoteSyncNeedPush, NoteSyncRename, OfflineSyncStrategy,
    SyncPageMessage,
};
pub use sync::{delete_note, new_context, pull_notes, push_note, PullResult, PushNote};

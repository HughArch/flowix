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
pub mod engine;
pub mod file;
pub mod fs_store;
pub mod hash;
pub mod local;
pub mod protocol;
pub mod state;
pub mod sync;

pub use client::{sync_endpoint, FnsClient, FnsError, Incoming, Result, CLIENT_TYPE};
pub use engine::{sync_notebook, SyncOptions, SyncReport};
pub use file::{download_file, pull_files, upload_check, upload_file, PullFilesResult};
pub use fs_store::FsNoteStore;
pub use hash::{content_hash, encode_hash32, encode_hash32_bytes, path_hash};
pub use local::{LocalFile, LocalFileStore, LocalNote, LocalNoteStore, MemoryNoteStore};
pub use protocol::{
    action, ClientInfo, Envelope, NoteSyncCheckRequest, NoteSyncDelete, NoteSyncEnd,
    NoteSyncModify, NoteSyncMtime, NoteSyncNeedPush, NoteSyncRename, OfflineSyncStrategy,
    SyncPageMessage,
};
pub use state::SyncState;
pub use sync::{delete_note, new_context, pull_notes, push_note, PullResult, PushNote};

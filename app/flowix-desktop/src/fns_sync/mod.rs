//! Fast Note Sync Service (FNS) integration.
//!
//! The protocol client lives in the `flowix-fns` crate; this module wires it to
//! the desktop shell: global credentials, a `MemoFile`-backed local store, and
//! IPC commands.

mod commands;
mod binding;
mod history;
mod share;
pub mod config;
pub mod listener;
mod service;
mod store;

pub use commands::*;
pub use config::{FnsConfig, FnsConfigPatch, FnsConfigView, FnsTokenInput, FnsTokenView};
pub use history::{FnsApiError, FnsCloudHistoryPage, FnsCloudVersionMeta};
pub use share::FnsShareView;
pub use service::{
    now_ms, schedule_notebook_sync, FnsNotebookState, FnsNotebookSyncOutcome, FnsSyncRecord,
    FnsSyncService, FnsSyncStatus,
};

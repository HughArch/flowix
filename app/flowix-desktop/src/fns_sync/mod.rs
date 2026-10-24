//! Fast Note Sync Service (FNS) integration.
//!
//! The protocol client lives in the `flowix-fns` crate; this module wires it to
//! the desktop shell: global credentials, a `MemoFile`-backed local store, and
//! IPC commands.

mod commands;
pub mod config;
mod service;
mod store;

pub use commands::*;
pub use config::{FnsConfig, FnsConfigPatch, FnsConfigView};
pub use service::{
    now_ms, schedule_notebook_sync, FnsNotebookSyncOutcome, FnsSyncService, FnsSyncStatus,
};

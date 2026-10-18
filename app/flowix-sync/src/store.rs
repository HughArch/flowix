use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::SyncError;

#[derive(Clone)]
pub struct SyncStore {
    path: PathBuf,
    schema_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    schema_lock: std::sync::Arc<std::sync::Mutex<()>>,
}

mod schema;
mod v2;

#[cfg(test)]
mod v2_tests;

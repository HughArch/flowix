//! FNS sync orchestration for the desktop shell.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use flowix_fns::{
    sync_notebook as run_engine_sync, ClientInfo, FnsClient, SyncReport, SyncState,
};

use crate::app::state::AppState;
use crate::fns_sync::config::{FnsConfig, FnsConfigPatch, FnsConfigView};
use crate::fns_sync::store::MemoFileStore;
use crate::lock_utils::read_lock;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsSyncStatus {
    pub running: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_pulled: usize,
    pub last_pushed: usize,
    /// Consecutive failed attempts; reset by a success or a new local edit.
    pub consecutive_failures: u32,
    /// Epoch milliseconds of the next scheduled retry, when one is pending.
    pub next_retry_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct RetryEntry {
    attempts: u32,
    /// Bumped whenever a newer attempt (or a fresh edit) supersedes this one.
    token: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsNotebookSyncOutcome {
    pub notebook_id: String,
    pub vault: String,
    pub pulled: usize,
    pub pushed: usize,
    pub deleted_local: usize,
    pub renamed: usize,
    pub conflicts: Vec<String>,
    pub last_time: i64,
}

pub struct FnsSyncService {
    config_dir: PathBuf,
    config: RwLock<FnsConfig>,
    status: RwLock<FnsSyncStatus>,
    running: AtomicBool,
    /// Per-notebook debounce generation. A scheduled run whose generation has
    /// been superseded does nothing.
    scheduled: Mutex<HashMap<String, u64>>,
    /// Per-notebook exponential backoff state for failed syncs.
    retry: Mutex<HashMap<String, RetryEntry>>,
}

const AUTO_SYNC_DEBOUNCE: Duration = Duration::from_secs(5);

impl FnsSyncService {
    pub fn new(config_dir: PathBuf) -> Self {
        let config = FnsConfig::load(&config_dir);
        Self {
            config_dir,
            config: RwLock::new(config),
            status: RwLock::new(FnsSyncStatus::default()),
            running: AtomicBool::new(false),
            scheduled: Mutex::new(HashMap::new()),
            retry: Mutex::new(HashMap::new()),
        }
    }

    /// Debounced sync after a local edit. Only applies to notebooks that
    /// already have a vault binding; the first binding is always explicit.
    pub fn schedule_sync(self: &Arc<Self>, app: AppHandle, notebook_id: String) {
        let ready = {
            let config = self.read_config();
            config.is_ready()
        };
        if !ready {
            return;
        }

        if !self.notebook_is_bound(&app, &notebook_id) {
            return;
        }

        // A fresh edit supersedes any pending retry and resets the backoff.
        {
            let mut retry = self
                .retry
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = retry.get_mut(&notebook_id) {
                entry.attempts = 0;
                entry.token = entry.token.wrapping_add(1);
            }
        }

        let generation = {
            let mut scheduled = self
                .scheduled
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = scheduled.entry(notebook_id.clone()).or_insert(0);
            *entry = entry.wrapping_add(1);
            *entry
        };

        let service = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AUTO_SYNC_DEBOUNCE).await;
            {
                let scheduled = service
                    .scheduled
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if scheduled.get(&notebook_id).copied() != Some(generation) {
                    return;
                }
            }
            match service.sync_notebook(&app, &notebook_id).await {
                Ok(_) => {}
                Err(error) => tracing::warn!(
                    notebook_id = %notebook_id,
                    "FNS automatic sync failed: {error}"
                ),
            }
        });
    }

    fn notebook_is_bound(&self, app: &AppHandle, notebook_id: &str) -> bool {
        let state = app.state::<AppState>();
        let root = {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            memo_file
                .get_notebook_config_by_id(notebook_id)
                .map(|notebook| PathBuf::from(notebook.path))
        };
        root.and_then(|root| SyncState::load(&root).ok().flatten())
            .is_some()
    }

    pub fn config_view(&self) -> FnsConfigView {
        FnsConfigView::from(&*self.read_config())
    }

    pub fn patch_config(&self, patch: FnsConfigPatch) -> Result<FnsConfigView, String> {
        let mut config = self
            .config
            .write()
            .map_err(|_| "FNS config lock poisoned".to_owned())?;
        config.apply(patch);
        config.save(&self.config_dir).map_err(|error| error.to_string())?;
        Ok(FnsConfigView::from(&*config))
    }

    pub fn status(&self) -> FnsSyncStatus {
        self.status
            .read()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    fn read_config(&self) -> std::sync::RwLockReadGuard<'_, FnsConfig> {
        self.config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_status<F: FnOnce(&mut FnsSyncStatus)>(&self, change: F) {
        if let Ok(mut status) = self.status.write() {
            change(&mut status);
        }
    }

    /// Sync one notebook. Returns `Ok(None)` when sync is disabled or not
    /// configured, so callers can treat it as a no-op rather than an error.
    pub async fn sync_notebook(
        self: &Arc<Self>,
        app: &AppHandle,
        notebook_id: &str,
    ) -> Result<Option<FnsNotebookSyncOutcome>, String> {
        let (config, offline_strategy) = {
            let config = self.read_config();
            if !config.is_ready() {
                return Ok(None);
            }
            (config.clone(), config.offline_sync_strategy())
        };

        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("FNS sync is already running".to_owned());
        }
        self.set_status(|status| {
            status.running = true;
            status.last_error = None;
        });

        let result = self
            .sync_notebook_inner(app, notebook_id, config, offline_strategy)
            .await;

        self.running.store(false, Ordering::SeqCst);
        match &result {
            Ok(Some(outcome)) => {
                self.clear_retry(notebook_id);
                self.set_status(|status| {
                    status.running = false;
                    status.last_sync_at = Some(now_ms());
                    status.last_pulled = outcome.pulled;
                    status.last_pushed = outcome.pushed;
                    status.last_error = None;
                    status.consecutive_failures = 0;
                    status.next_retry_at = None;
                });
            }
            Ok(None) => {
                self.clear_retry(notebook_id);
                self.set_status(|status| {
                    status.running = false;
                    status.next_retry_at = None;
                });
            }
            Err(error) => {
                let delay = self.schedule_retry(app, notebook_id);
                self.set_status(|status| {
                    status.running = false;
                    status.last_error = Some(error.clone());
                    status.consecutive_failures = status.consecutive_failures.saturating_add(1);
                    status.next_retry_at = Some(now_ms() + delay.as_millis() as i64);
                });
            }
        }
        result
    }

    /// Schedule the next attempt with exponential backoff. Returns the delay so
    /// the status can expose `nextRetryAt`.
    fn schedule_retry(self: &Arc<Self>, app: &AppHandle, notebook_id: &str) -> Duration {
        let (token, delay) = {
            let mut retry = self
                .retry
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = retry.entry(notebook_id.to_owned()).or_default();
            entry.token = entry.token.wrapping_add(1);
            let attempts = entry.attempts;
            entry.attempts = entry.attempts.saturating_add(1);
            (entry.token, retry_delay(attempts))
        };

        let service = self.clone();
        let app = app.clone();
        let id = notebook_id.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let retry = service
                    .retry
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if retry.get(&id).map(|entry| entry.token) != Some(token) {
                    return;
                }
            }
            let _ = service.sync_notebook(&app, &id).await;
        });
        delay
    }

    fn clear_retry(&self, notebook_id: &str) {
        if let Ok(mut retry) = self.retry.lock() {
            retry.remove(notebook_id);
        }
    }

    async fn sync_notebook_inner(
        &self,
        app: &AppHandle,
        notebook_id: &str,
        config: FnsConfig,
        offline_strategy: flowix_fns::OfflineSyncStrategy,
    ) -> Result<Option<FnsNotebookSyncOutcome>, String> {
        let state = app.state::<AppState>();
        let (notebook_name, root) = {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            let notebook = memo_file
                .get_notebook_config_by_id(notebook_id)
                .ok_or_else(|| format!("notebook not found: {notebook_id}"))?;
            (notebook.name, PathBuf::from(notebook.path))
        };

        if !root.is_dir() {
            return Err(format!(
                "notebook root is not a directory: {}",
                root.display()
            ));
        }

        let mut sync_state = match SyncState::load(&root).map_err(|error| error.to_string())? {
            Some(state) => state,
            None => SyncState::new(&notebook_name, uuid::Uuid::new_v4().to_string()),
        };

        let store = MemoFileStore::new(
            app.clone(),
            state.memo_file.clone(),
            notebook_id.to_owned(),
            root.clone(),
        );

        let info = ClientInfo {
            name: config.client_name.clone(),
            version: config.client_version.clone(),
            client_type: config.client_type.clone(),
            offline_sync_strategy: Some(offline_strategy.as_str().to_owned()),
        };

        let mut client = FnsClient::connect(&config.api, &config.token, &info)
            .await
            .map_err(|error| error.to_string())?;

        let report: SyncReport =
            run_engine_sync(&mut client, &store, &mut sync_state, offline_strategy)
                .await
                .map_err(|error| error.to_string())?;

        let _ = client.close().await;

        sync_state
            .save(&root)
            .map_err(|error| error.to_string())?;

        Ok(Some(FnsNotebookSyncOutcome {
            notebook_id: notebook_id.to_owned(),
            vault: sync_state.vault,
            pulled: report.pulled,
            pushed: report.pushed,
            deleted_local: report.deleted_local,
            renamed: report.renamed,
            conflicts: report.conflicts,
            last_time: report.last_time,
        }))
    }

    /// Sync every notebook that already has a binding. Used on startup and by
    /// the "sync all" command.
    pub async fn sync_bound_notebooks(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> Result<Vec<FnsNotebookSyncOutcome>, String> {
        let state = app.state::<AppState>();
        let notebooks = {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            memo_file
                .read_notebook_configs()
                .map_err(|error| error.to_string())?
        };

        let mut outcomes = Vec::new();
        for notebook in notebooks {
            let root = PathBuf::from(&notebook.path);
            let bound = SyncState::load(&root)
                .map(|state| state.is_some())
                .unwrap_or(false);
            if !bound {
                continue;
            }
            match self.sync_notebook(app, &notebook.id).await {
                Ok(Some(outcome)) => outcomes.push(outcome),
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(
                        notebook_id = %notebook.id,
                        "FNS notebook sync failed: {error}"
                    );
                }
            }
        }
        Ok(outcomes)
    }
}

pub fn now_ms() -> i64 {
    flowix_fns::engine::now_ms()
}

/// 2s, 4s, 8s … capped at 256s.
fn retry_delay(attempts: u32) -> Duration {
    let factor = 1u64.checked_shl(attempts.min(7)).unwrap_or(128);
    Duration::from_secs(2u64.saturating_mul(factor).min(300))
}

#[cfg(test)]
mod tests {
    use super::retry_delay;

    #[test]
    fn retry_delay_is_exponential_and_capped() {
        assert_eq!(retry_delay(0).as_secs(), 2);
        assert_eq!(retry_delay(1).as_secs(), 4);
        assert_eq!(retry_delay(3).as_secs(), 16);
        assert_eq!(retry_delay(7).as_secs(), 256);
        assert_eq!(retry_delay(20).as_secs(), 256);
    }
}

/// Debounced FNS sync for one notebook, callable from the watcher and memo
/// event paths without borrowing the service.
pub fn schedule_notebook_sync(app: &AppHandle, notebook_id: &str) {
    let service = app.state::<AppState>().fns_sync.clone();
    service.schedule_sync(app.clone(), notebook_id.to_owned());
}

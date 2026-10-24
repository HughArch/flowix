//! FNS sync orchestration for the desktop shell.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

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
}

impl FnsSyncService {
    pub fn new(config_dir: PathBuf) -> Self {
        let config = FnsConfig::load(&config_dir);
        Self {
            config_dir,
            config: RwLock::new(config),
            status: RwLock::new(FnsSyncStatus::default()),
            running: AtomicBool::new(false),
        }
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
        &self,
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
            Ok(Some(outcome)) => self.set_status(|status| {
                status.running = false;
                status.last_sync_at = Some(now_ms());
                status.last_pulled = outcome.pulled;
                status.last_pushed = outcome.pushed;
            }),
            Ok(None) => self.set_status(|status| status.running = false),
            Err(error) => self.set_status(|status| {
                status.running = false;
                status.last_error = Some(error.clone());
            }),
        }
        result
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
        &self,
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

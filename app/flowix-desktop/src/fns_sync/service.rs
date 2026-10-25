//! FNS sync orchestration for the desktop shell.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

use flowix_fns::{
    sync_notebook as run_engine_sync, ClientInfo, FnsClient, SyncProgress, SyncProgressSink,
    SyncReport, SyncState,
};

use crate::app::state::AppState;
use crate::fns_sync::config::{FnsConfig, FnsConfigPatch, FnsConfigView, FnsTokenInput};
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
    /// Notebook the current/last status belongs to.
    pub notebook_id: Option<String>,
    /// Live progress while a sync runs.
    pub progress: Option<SyncProgress>,
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
    pub files_pulled: usize,
    pub files_pushed: usize,
    pub conflicts: Vec<String>,
    pub last_time: i64,
}

/// One entry in the in-memory sync history shown by the status panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsSyncRecord {
    pub at: i64,
    pub notebook_id: String,
    pub vault: String,
    pub ok: bool,
    pub pulled: usize,
    pub pushed: usize,
    pub files_pulled: usize,
    pub files_pushed: usize,
    pub deleted_local: usize,
    pub duration_ms: i64,
    pub error: Option<String>,
}

const HISTORY_LIMIT: usize = 50;

/// Forwards engine progress into the shared status snapshot.
struct StatusSink(Arc<RwLock<FnsSyncStatus>>);

impl SyncProgressSink for StatusSink {
    fn report(&self, progress: SyncProgress) {
        if let Ok(mut status) = self.0.write() {
            status.progress = Some(progress);
        }
    }
}

/// Binding and recent activity for one notebook.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsNotebookState {
    pub notebook_id: String,
    pub bound: bool,
    pub vault: String,
    pub token_id: String,
    pub token_label: Option<String>,
    pub status: FnsSyncStatus,
    pub history: Vec<FnsSyncRecord>,
}

pub struct FnsSyncService {
    config_dir: PathBuf,
    config: RwLock<FnsConfig>,
    status: Arc<RwLock<FnsSyncStatus>>,
    /// Serializes sync runs across every trigger source (edit debounce,
    /// realtime broadcast, manual command, retry). Queuing beats failing:
    /// a dropped trigger may never re-fire on its own — a remote change
    /// notification, for instance, is not repeated until the next edit.
    sync_lock: AsyncMutex<()>,
    /// Realtime change listener; restarted whenever credentials or notebook
    /// bindings change.
    listener: Arc<super::listener::FnsListener>,
    /// Per-notebook pending run deadline. A scheduled run that no longer owns
    /// the slot (a newer trigger scheduled an earlier deadline) does nothing.
    scheduled: Mutex<HashMap<String, std::time::Instant>>,
    /// Per-notebook exponential backoff state for failed syncs.
    retry: Mutex<HashMap<String, RetryEntry>>,
    /// Newest-first history for the status panel.
    history: Mutex<Vec<FnsSyncRecord>>,
}

const AUTO_SYNC_DEBOUNCE: Duration = Duration::from_secs(5);
/// Upper bound for one notebook sync. Prevents a wedged network call from
/// leaving the UI stuck on "syncing" forever.
const SYNC_TIMEOUT: Duration = Duration::from_secs(120);

impl FnsSyncService {
    pub fn new(config_dir: PathBuf) -> Self {
        let config = FnsConfig::load(&config_dir);
        Self {
            config_dir,
            config: RwLock::new(config),
            status: Arc::new(RwLock::new(FnsSyncStatus::default())),
            sync_lock: AsyncMutex::new(()),
            listener: Arc::new(super::listener::FnsListener::new()),
            scheduled: Mutex::new(HashMap::new()),
            retry: Mutex::new(HashMap::new()),
            history: Mutex::new(Vec::new()),
        }
    }

    /// Realtime listener supervisor. Call [`FnsListener::start`] once at
    /// startup; this accessor exists so the bootstrap wiring can reach it
    /// without exposing the field.
    pub fn listener(&self) -> &Arc<super::listener::FnsListener> {
        &self.listener
    }

    /// Clone of the current credential config, for listeners planning their
    /// connections.
    pub(crate) fn config_snapshot(&self) -> FnsConfig {
        self.read_config().clone()
    }

    /// Newest-first history, optionally restricted to one notebook.
    pub fn history(&self, notebook_id: Option<&str>) -> Vec<FnsSyncRecord> {
        self.history
            .lock()
            .map(|history| {
                history
                    .iter()
                    .filter(|record| {
                        notebook_id.is_none_or(|id| record.notebook_id == id)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn record_history(&self, record: FnsSyncRecord) {
        if let Ok(mut history) = self.history.lock() {
            history.insert(0, record);
            history.truncate(HISTORY_LIMIT);
        }
    }

    /// Debounced sync after a local edit. Only applies to notebooks that
    /// already have a vault binding; the first binding is always explicit.
    pub fn schedule_sync(self: &Arc<Self>, app: AppHandle, notebook_id: String) {
        self.schedule_sync_with_delay(app, notebook_id, AUTO_SYNC_DEBOUNCE);
    }

    /// Debounced sync with an explicit delay. The per-notebook slot holds the
    /// earliest pending deadline: a new trigger takes over only when it wants
    /// to run *sooner*; a later trigger is already covered by the pending run
    /// (its scan happens at fire time, so it sees the newest state).
    ///
    /// The slot is released when the run starts, not when it finishes — edits
    /// made during a long sync must be able to schedule the next run.
    pub fn schedule_sync_with_delay(
        self: &Arc<Self>,
        app: AppHandle,
        notebook_id: String,
        delay: Duration,
    ) {
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

        let deadline = std::time::Instant::now() + delay;
        {
            let mut scheduled = self
                .scheduled
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match scheduled.get(&notebook_id) {
                // An earlier (or equally timed) pending run covers this one.
                Some(current) if *current <= deadline => return,
                _ => {
                    scheduled.insert(notebook_id.clone(), deadline);
                }
            }
        }

        let service = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut scheduled = service
                    .scheduled
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if scheduled.get(&notebook_id).copied() != Some(deadline) {
                    return;
                }
                scheduled.remove(&notebook_id);
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
        self.listener.restart();
        Ok(FnsConfigView::from(&*config))
    }

    pub fn upsert_token(&self, input: FnsTokenInput) -> Result<FnsConfigView, String> {
        let mut config = self
            .config
            .write()
            .map_err(|_| "FNS config lock poisoned".to_owned())?;
        config
            .upsert_token(input.id.as_deref(), &input.label, &input.token)
            .ok_or_else(|| "label and token are required for a new token".to_owned())?;
        config.save(&self.config_dir).map_err(|error| error.to_string())?;
        self.listener.restart();
        Ok(FnsConfigView::from(&*config))
    }

    pub fn delete_token(&self, id: &str) -> Result<FnsConfigView, String> {
        let mut config = self
            .config
            .write()
            .map_err(|_| "FNS config lock poisoned".to_owned())?;
        config.remove_token(id);
        config.save(&self.config_dir).map_err(|error| error.to_string())?;
        self.listener.restart();
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

    /// Explain why a manual sync of this notebook would be a no-op, if so.
    /// Automatic callers ignore this and simply skip.
    pub fn sync_blocker(&self, app: &AppHandle, notebook_id: &str) -> Option<String> {
        let config = self.read_config();
        if !config.enabled {
            return Some("sync is not enabled".to_owned());
        }
        if config.api.trim().is_empty() {
            return Some("server url is not configured".to_owned());
        }
        if config.tokens.is_empty() {
            return Some("no sync token has been added".to_owned());
        }
        let (_, root) = notebook_root(app, notebook_id).ok()?;
        let state = match SyncState::load(&root).ok().flatten() {
            Some(state) => state,
            None => return Some("notebook is not bound to a token".to_owned()),
        };
        if config.token(&state.token_id).is_none() {
            return Some("the bound token no longer exists".to_owned());
        }
        None
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

        // Wait for any in-flight sync instead of failing: every trigger path
        // is a "please sync this notebook soon" request, and none of them
        // benefits from being discarded here.
        let _sync_lock = self.sync_lock.lock().await;
        self.set_status(|status| {
            status.running = true;
            status.last_error = None;
            status.notebook_id = Some(notebook_id.to_owned());
        });

        tracing::info!(notebook_id, "FNS sync started");
        let started = std::time::Instant::now();
        let started_at = now_ms();
        let result = match tokio::time::timeout(
            SYNC_TIMEOUT,
            self.sync_notebook_inner(app, notebook_id, config, offline_strategy),
        )
        .await
        {
            Ok(inner) => inner,
            Err(_) => {
                tracing::warn!(notebook_id, "FNS sync timed out");
                Err("sync timed out".to_owned())
            }
        };

        match &result {
            Ok(Some(outcome)) => {
                tracing::info!(
                    notebook_id,
                    vault = %outcome.vault,
                    pulled = outcome.pulled,
                    pushed = outcome.pushed,
                    files_pulled = outcome.files_pulled,
                    files_pushed = outcome.files_pushed,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "FNS sync finished"
                );
                self.clear_retry(notebook_id);
                self.record_history(FnsSyncRecord {
                    at: started_at,
                    notebook_id: outcome.notebook_id.clone(),
                    vault: outcome.vault.clone(),
                    ok: true,
                    pulled: outcome.pulled,
                    pushed: outcome.pushed,
                    files_pulled: outcome.files_pulled,
                    files_pushed: outcome.files_pushed,
                    deleted_local: outcome.deleted_local,
                    duration_ms: started.elapsed().as_millis() as i64,
                    error: None,
                });
                self.set_status(|status| {
                    status.running = false;
                    status.progress = None;
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
                    status.progress = None;
                    status.next_retry_at = None;
                });
            }
            Err(error) => {
                tracing::warn!(
                    notebook_id,
                    error = %error,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "FNS sync failed"
                );
                let retry = self.schedule_retry(app, notebook_id);
                let exhausted = retry.is_none();
                self.record_history(FnsSyncRecord {
                    at: started_at,
                    notebook_id: notebook_id.to_owned(),
                    vault: String::new(),
                    ok: false,
                    pulled: 0,
                    pushed: 0,
                    files_pulled: 0,
                    files_pushed: 0,
                    deleted_local: 0,
                    duration_ms: started.elapsed().as_millis() as i64,
                    error: Some(error.clone()),
                });
                self.set_status(|status| {
                    status.running = false;
                    status.progress = None;
                    status.last_error = Some(if exhausted {
                        format!("{error}（已达到最大重试次数，自动重试已暂停）")
                    } else {
                        error.clone()
                    });
                    status.consecutive_failures = status.consecutive_failures.saturating_add(1);
                    status.next_retry_at =
                        retry.map(|delay| now_ms() + delay.as_millis() as i64);
                });
            }
        }
        result
    }

    /// Schedule the next attempt with exponential backoff. Returns `None` once
    /// the configured attempt budget is exhausted.
    fn schedule_retry(
        self: &Arc<Self>,
        app: &AppHandle,
        notebook_id: &str,
    ) -> Option<Duration> {
        let max_attempts = self.read_config().max_retry_attempts;
        let (token, delay) = {
            let mut retry = self
                .retry
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = retry.entry(notebook_id.to_owned()).or_default();
            if max_attempts == 0 || entry.attempts >= max_attempts {
                return None;
            }
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
        Some(delay)
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
        let root = {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            let notebook = memo_file
                .get_notebook_config_by_id(notebook_id)
                .ok_or_else(|| format!("notebook not found: {notebook_id}"))?;
            PathBuf::from(notebook.path)
        };

        if !root.is_dir() {
            return Err(format!(
                "notebook root is not a directory: {}",
                root.display()
            ));
        }

        // Binding is explicit: a notebook without sync state is not synced.
        let mut sync_state = match SyncState::load(&root).map_err(|error| error.to_string())? {
            Some(state) => state,
            None => return Ok(None),
        };

        let token = match config.token(&sync_state.token_id) {
            Some(token) => token.clone(),
            None => return Ok(None),
        };
        if sync_state.token_id.is_empty() {
            // Older state without an explicit binding: adopt the only token.
            sync_state.token_id = token.id.clone();
        }

        let store = MemoFileStore::new(
            app.clone(),
            state.memo_file.clone(),
            notebook_id.to_owned(),
            root.clone(),
        );

        let info = ClientInfo {
            name: "Flowix".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            client_type: token.client_type.clone(),
            offline_sync_strategy: Some(offline_strategy.as_str().to_owned()),
        };

        tracing::info!(notebook_id, vault = %sync_state.vault, "FNS sync: connecting");
        let mut client = FnsClient::connect(&config.api, &token.token, &info)
            .await
            .map_err(describe_sync_error)?;
        tracing::info!(notebook_id, "FNS sync: connected");

        let options = flowix_fns::SyncOptions {
            max_attachment_bytes: config.max_attachment_bytes.min(i64::MAX as u64) as i64,
        };
        let sink = StatusSink(self.status.clone());
        let report: SyncReport = run_engine_sync(
            &mut client,
            &store,
            &store,
            &mut sync_state,
            offline_strategy,
            &options,
            &sink,
        )
        .await
        .map_err(describe_sync_error)?;

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
            files_pulled: report.files_pulled,
            files_pushed: report.files_pushed,
            conflicts: report.conflicts,
            last_time: report.last_time,
        }))
    }

    /// Sync every notebook that already has a binding. Used on startup and by
    /// the "sync all" command.
    /// Bind a notebook to one token and one vault.
    pub fn bind_notebook(
        &self,
        app: &AppHandle,
        notebook_id: &str,
        token_id: &str,
        vault: &str,
    ) -> Result<FnsNotebookState, String> {
        let (notebook_name, root) = notebook_root(app, notebook_id)?;

        if token_id.trim().is_empty() {
            return Err("token id is required".to_owned());
        }
        {
            let config = self.read_config();
            if config.token(token_id).is_none() {
                return Err("token not found".to_owned());
            }
        }

        let existing = SyncState::load(&root).map_err(|error| error.to_string())?;
        let vault_name = {
            let trimmed = vault.trim();
            if trimmed.is_empty() {
                notebook_name
            } else {
                trimmed.to_owned()
            }
        };

        let mut state = existing.clone().unwrap_or_else(|| {
            SyncState::new(vault_name.clone(), uuid::Uuid::new_v4().to_string())
        });

        let vault_changed = existing
            .as_ref()
            .is_some_and(|previous| previous.vault != vault_name);
        if vault_changed {
            // Cursors and snapshots belong to the previous vault.
            state.last_time = 0;
            state.file_last_time = 0;
            state.notes.clear();
            state.files.clear();
        }

        state.vault = vault_name;
        state.token_id = token_id.to_owned();
        state.save(&root).map_err(|error| error.to_string())?;
        self.listener.restart();

        self.notebook_state(app, notebook_id)
    }

    /// Remove the binding. Synced files stay on disk; the server is untouched.
    pub fn unbind_notebook(&self, app: &AppHandle, notebook_id: &str) -> Result<(), String> {
        let (_, root) = notebook_root(app, notebook_id)?;
        let path = SyncState::path_for(&root);
        match std::fs::remove_file(&path) {
            Ok(()) => {
                self.listener.restart();
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn notebook_state(
        &self,
        app: &AppHandle,
        notebook_id: &str,
    ) -> Result<FnsNotebookState, String> {
        let (_, root) = notebook_root(app, notebook_id)?;
        let state = SyncState::load(&root).map_err(|error| error.to_string())?;
        let config = self.read_config();

        let (bound, vault, token_id, token_label) = match &state {
            Some(state) => {
                let label = config
                    .token(&state.token_id)
                    .map(|token| token.label.clone());
                (
                    config.token(&state.token_id).is_some(),
                    state.vault.clone(),
                    state.token_id.clone(),
                    label,
                )
            }
            None => (false, String::new(), String::new(), None),
        };

        Ok(FnsNotebookState {
            notebook_id: notebook_id.to_owned(),
            bound,
            vault,
            token_id,
            token_label,
            status: self.status(),
            history: self.history(Some(notebook_id)),
        })
    }

    /// Wait the configured startup delay, then pull bound notebooks.
    pub async fn sync_after_startup(self: &Arc<Self>, app: AppHandle) {
        let (ready, delay) = {
            let config = self.read_config();
            (config.is_ready(), config.startup_sync_delay_seconds)
        };
        if !ready {
            return;
        }
        if delay > 0 {
            tracing::info!(delay_seconds = delay, "FNS startup sync scheduled");
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        if let Err(error) = self.sync_bound_notebooks(&app).await {
            tracing::warn!("startup FNS sync failed: {error}");
        }
    }

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

fn describe_sync_error(error: flowix_fns::FnsError) -> String {
    match &error {
        flowix_fns::FnsError::Server { code: 315, message }
            if message.contains("Vault access restricted") =>
        {
            format!(
                "令牌的 vault 白名单不包含目标笔记库（{message}）。\
                 请在服务端为该令牌授权对应的 vault，或改用 vault 白名单留空的令牌。"
            )
        }
        flowix_fns::FnsError::Server { code: 315, .. } => {
            "令牌权限不匹配（315）：该令牌的客户端类型与服务端 scope 不一致。\
             Obsidian 插件签发的令牌请在「同步令牌」里把客户端类型设为 obsidianPlugin。"
                .to_owned()
        }
        flowix_fns::FnsError::Server { code: 314, .. } => {
            "令牌权限不足（314）：当前令牌不允许该操作。".to_owned()
        }
        _ => error.to_string(),
    }
}

fn notebook_root(app: &AppHandle, notebook_id: &str) -> Result<(String, PathBuf), String> {
    let state = app.state::<AppState>();
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| format!("notebook not found: {notebook_id}"))?;
    Ok((notebook.name, PathBuf::from(notebook.path)))
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

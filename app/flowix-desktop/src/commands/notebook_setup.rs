//! Durable lifecycle and worker coordination for notebook template setup.

use crate::app::state::{AppState, NotebookImportStatusKind};
use crate::events as dispatcher;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    MemoFile, NotebookSetupJob, NotebookSetupJobStatus, NotebookSetupSnapshot, NotebookSetupStage,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use super::notebook::{emit_notebook_import_status, run_notebook_import};

const NOTEBOOK_SETUP_STATUS_EVENT: &str = "notebook-setup-status";

pub(crate) fn persist_notebook_setup_job(
    state: &AppState,
    app: &AppHandle,
    job: NotebookSetupJob,
) -> Result<NotebookSetupJob, String> {
    let persisted = read_lock(&state.memo_file, "memo_file")
        .write_notebook_setup_job(&job)
        .map_err(|error| format!("persist notebook setup status failed: {error}"))?;
    emit_notebook_setup_job(app, persisted.clone());
    Ok(persisted)
}

pub(crate) fn emit_notebook_setup_job(app: &AppHandle, job: NotebookSetupJob) {
    dispatcher::emit_to(app, NOTEBOOK_SETUP_STATUS_EVENT, job);
}

fn persist_notebook_setup_run_start(
    state: &AppState,
    app: &AppHandle,
    job: &NotebookSetupJob,
    expected_run_id: &str,
) -> Result<NotebookSetupJob, String> {
    let persisted = read_lock(&state.memo_file, "memo_file")
        .start_notebook_setup_job(job, expected_run_id)
        .map_err(|error| format!("persist notebook setup run start failed: {error}"))?;
    emit_notebook_setup_job(app, persisted.clone());
    Ok(persisted)
}

fn release_notebook_template_setup(state: &AppState, notebook_id: &str) {
    state
        .notebook_template_initializations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(notebook_id);
}

fn read_current_notebook_setup_run(
    state: &AppState,
    notebook_id: &str,
    job_id: &str,
    run_id: &str,
) -> Option<NotebookSetupJob> {
    let mut delay = std::time::Duration::from_millis(250);
    loop {
        match read_lock(&state.memo_file, "memo_file").get_notebook_setup_job(notebook_id) {
            Ok(Some(job)) if job.job_id == job_id && job.run_id == run_id => return Some(job),
            Ok(_) => return None,
            Err(error) => {
                tracing::error!(
                    notebook_id = %notebook_id,
                    error = %error,
                    "retrying notebook setup checkpoint read"
                );
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(30));
            }
        }
    }
}

fn persist_notebook_setup_terminal_until_committed(
    state: &AppState,
    app: &AppHandle,
    job: NotebookSetupJob,
) {
    let mut delay = std::time::Duration::from_millis(250);
    loop {
        match persist_notebook_setup_job(state, app, job.clone()) {
            Ok(_) => return,
            Err(error) => {
                if error.contains("NOTEBOOK_SETUP_JOB_SUPERSEDED")
                    || error.contains("NOTEBOOK_SETUP_RUN_SUPERSEDED")
                    || error.contains("NOTEBOOK_SETUP_JOB_MISSING")
                {
                    tracing::warn!(
                        notebook_id = %job.notebook_id,
                        job_id = %job.job_id,
                        "discarding terminal result for a superseded notebook setup job"
                    );
                    return;
                }

                let current = read_lock(&state.memo_file, "memo_file")
                    .get_notebook_setup_job(&job.notebook_id);
                match current {
                    Ok(Some(current))
                        if current.job_id != job.job_id || current.run_id != job.run_id =>
                    {
                        tracing::warn!(
                            notebook_id = %job.notebook_id,
                            job_id = %job.job_id,
                            "discarding terminal result after setup identity changed"
                        );
                        return;
                    }
                    Ok(None) => return,
                    _ => {}
                }

                tracing::error!(
                    notebook_id = %job.notebook_id,
                    error = %error,
                    "retrying notebook setup terminal-state persistence"
                );
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(30));
            }
        }
    }
}

fn fail_notebook_template_setup_after_panic(app: AppHandle, mut job: NotebookSetupJob) {
    let state = app.state::<AppState>();
    let Some(latest) = read_current_notebook_setup_run(
        state.inner(),
        &job.notebook_id,
        &job.job_id,
        &job.run_id,
    ) else {
        release_notebook_template_setup(state.inner(), &job.notebook_id);
        return;
    };
    if matches!(
        latest.status,
        NotebookSetupJobStatus::Completed
            | NotebookSetupJobStatus::Partial
            | NotebookSetupJobStatus::Failed
    ) {
        release_notebook_template_setup(state.inner(), &job.notebook_id);
        return;
    }

    job.stage = latest.stage;
    job.report = latest.report;
    job.status = NotebookSetupJobStatus::Failed;
    job.message = Some("NOTEBOOK_TEMPLATE_WORKER_PANICKED".to_string());
    job.updated_at = chrono::Utc::now().timestamp_millis();
    persist_notebook_setup_terminal_until_committed(state.inner(), &app, job);
    release_notebook_template_setup(state.inner(), &latest.notebook_id);
}

fn finish_notebook_template_setup(app: AppHandle, mut job: NotebookSetupJob) {
    let state = app.state::<AppState>();
    let mut report = job.report.clone().unwrap_or_default();
    let result = (|| {
        let template_id = job
            .template_id
            .as_deref()
            .ok_or_else(|| "NOTEBOOK_TEMPLATE_NOT_SELECTED".to_string())?;
        if template_id.starts_with("scene-") {
            let template = super::memo::creates::resolve_notebook_template(template_id)?;
            if template.id != template_id {
                job.template_id = Some(template.id);
                job.updated_at = chrono::Utc::now().timestamp_millis();
                job = persist_notebook_setup_job(state.inner(), &app, job.clone())?;
            }
        }
        if job.stage != NotebookSetupStage::Indexing {
            let notebook_id = job.notebook_id.clone();
            let template_id = job
                .template_id
                .clone()
                .ok_or_else(|| "NOTEBOOK_TEMPLATE_NOT_SELECTED".to_string())?;
            let mut next_stage_job = job.clone();
            super::memo::creates::initialize_notebook_template_for_notebook(
                &notebook_id,
                &template_id,
                true,
                job.overwrite_existing,
                state.inner(),
                &app,
                Some(&job),
                |report| {
                    next_stage_job.stage = NotebookSetupStage::Indexing;
                    next_stage_job.message = None;
                    next_stage_job.report = Some(report.clone());
                    next_stage_job.updated_at = chrono::Utc::now().timestamp_millis();
                    next_stage_job = persist_notebook_setup_job(
                        state.inner(),
                        &app,
                        next_stage_job.clone(),
                    )?;
                    Ok(())
                },
            )?;
            report = next_stage_job.report.clone().unwrap_or_default();
            job = next_stage_job;
        }

        if job.stage == NotebookSetupStage::Indexing {
            let template_id = job
                .template_id
                .as_deref()
                .ok_or_else(|| "NOTEBOOK_TEMPLATE_NOT_SELECTED".to_string())?;
            super::memo::creates::clear_notebook_template_init_marker(
                &job.notebook_id,
                template_id,
                state.inner(),
            )?;
        }

        emit_notebook_import_status(
            state.inner(),
            &app,
            &job.notebook_id,
            NotebookImportStatusKind::Started,
            None,
        );
        if !run_notebook_import(app.clone(), job.notebook_id.clone(), false) {
            let message = state
                .notebook_imports
                .lock()
                .ok()
                .and_then(|imports| imports.get(&job.notebook_id).and_then(|status| status.message.clone()))
                .unwrap_or_else(|| "NOTEBOOK_IMPORT_FAILED".to_string());
            return Err(message);
        }
        Ok(())
    })();

    if result.is_err() {
        let Some(latest) = read_current_notebook_setup_run(
            state.inner(),
            &job.notebook_id,
            &job.job_id,
            &job.run_id,
        ) else {
            release_notebook_template_setup(state.inner(), &job.notebook_id);
            return;
        };
        job.stage = latest.stage;
        if let Some(latest_report) = latest.report {
            report = latest_report;
        }
    }

    job.updated_at = chrono::Utc::now().timestamp_millis();
    match result {
        Ok(()) => {
            job.report = Some(report.clone());
            if report.failed_files > 0 {
                job.status = NotebookSetupJobStatus::Partial;
                job.stage = NotebookSetupStage::Writing;
            } else {
                job.status = NotebookSetupJobStatus::Completed;
                job.stage = NotebookSetupStage::Completed;
            }
            job.message = None;
        }
        Err(message) => {
            job.status = NotebookSetupJobStatus::Failed;
            if report.failed_files > 0 && job.stage != NotebookSetupStage::Indexing {
                job.stage = NotebookSetupStage::Writing;
            }
            job.report = Some(report);
            job.message = Some(message);
        }
    }
    persist_notebook_setup_terminal_until_committed(state.inner(), &app, job.clone());
    release_notebook_template_setup(state.inner(), &job.notebook_id);
}

#[tauri::command]
pub fn get_notebook_template_setup_status(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<NotebookSetupJob>, String> {
    read_lock(&state.memo_file, "memo_file")
        .get_notebook_setup_job(&notebook_id)
        .map_err(|error| format!("read notebook setup status failed: {error}"))
}

#[tauri::command]
pub async fn get_notebook_template_setup_snapshot(
    app: AppHandle,
) -> Result<NotebookSetupSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let snapshot = read_lock(&state.memo_file, "memo_file")
            .get_notebook_setup_snapshot()
            .map_err(|error| format!("read notebook setup snapshot failed: {error}"));
        snapshot
    })
    .await
    .map_err(|error| format!("notebook setup snapshot task failed: {error}"))?
}

/// Start or resume template preparation for an opened notebook. Failed and
/// partial jobs only restart when the user explicitly requests a retry.
#[tauri::command]
pub fn start_notebook_template_setup(
    notebook_id: String,
    retry: Option<bool>,
    app: AppHandle,
) -> Result<Option<NotebookSetupJob>, String> {
    let state = app.state::<AppState>();
    let mut running = state
        .notebook_template_initializations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let Some(mut job) = memo_file
        .get_notebook_setup_job(&notebook_id)
        .map_err(|error| format!("read notebook setup status failed: {error}"))?
    else {
        return Ok(None);
    };
    drop(memo_file);

    if job.status == NotebookSetupJobStatus::Completed {
        return Ok(Some(job));
    }
    if matches!(job.status, NotebookSetupJobStatus::Partial | NotebookSetupJobStatus::Failed)
        && retry != Some(true)
    {
        return Ok(Some(job));
    }
    if job.status == NotebookSetupJobStatus::Partial && retry == Some(true) {
        job.status = NotebookSetupJobStatus::Pending;
        job.stage = NotebookSetupStage::Preparing;
        job.message = None;
        job.report = None;
    } else if job.status == NotebookSetupJobStatus::Failed && retry == Some(true) {
        job.status = NotebookSetupJobStatus::Pending;
        job.message = None;
        if job.stage != NotebookSetupStage::Indexing {
            job.stage = NotebookSetupStage::Preparing;
            job.report = None;
        }
    }

    if !running.insert(notebook_id.clone()) {
        return Ok(Some(job));
    }

    job.execution_requested = true;
    job.status = NotebookSetupJobStatus::Running;
    // Fresh/retried template setup starts by resolving and loading files.
    // Preserve indexing retries so already-written templates are not applied again.
    if job.stage != NotebookSetupStage::Indexing {
        job.stage = NotebookSetupStage::Preparing;
    }
    let expected_run_id = job.run_id.clone();
    job.run_id = uuid::Uuid::now_v7().to_string();
    job.message = None;
    job.updated_at = chrono::Utc::now().timestamp_millis();
    let job = match persist_notebook_setup_run_start(state.inner(), &app, &job, &expected_run_id) {
        Ok(job) => job,
        Err(error) => {
            running.remove(&notebook_id);
            return Err(error);
        }
    };
    drop(running);

    let worker_app = app.clone();
    let worker_job = job.clone();
    let panic_app = app.clone();
    let panic_job = job.clone();
    if let Err(error) = std::thread::Builder::new()
        .name(format!("notebook-setup-{}", job.notebook_id))
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                finish_notebook_template_setup(worker_app, worker_job)
            }));
            if result.is_err() {
                fail_notebook_template_setup_after_panic(panic_app, panic_job);
            }
        })
    {
        let mut failed = job.clone();
        failed.status = NotebookSetupJobStatus::Failed;
        failed.message = Some(format!("NOTEBOOK_SETUP_WORKER_START_FAILED:{error}"));
        failed.updated_at = chrono::Utc::now().timestamp_millis();
        persist_notebook_setup_terminal_until_committed(state.inner(), &app, failed);
        release_notebook_template_setup(state.inner(), &notebook_id);
        return Err(format!("failed to spawn notebook setup worker: {error}"));
    }
    Ok(Some(job))
}

/// Resume requested or interrupted jobs after workspace preparation. Also
/// start a pending job when its notebook is the active, ready workspace.
#[tauri::command]
pub async fn start_or_resume_ready_notebook_template_setups(
    active_notebook_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let candidates = read_lock(&state.memo_file, "memo_file")
            .list_notebook_setup_jobs()
            .map_err(|error| format!("read notebook setup jobs failed: {error}"))?
            .into_iter()
            .filter(|job| {
                job.status == NotebookSetupJobStatus::Running
                    || (job.status == NotebookSetupJobStatus::Pending
                        && (job.execution_requested
                            || active_notebook_id.as_deref() == Some(job.notebook_id.as_str())))
            })
            .map(|job| job.notebook_id)
            .collect::<Vec<_>>();
        let mut failures = Vec::new();
        for notebook_id in candidates {
            match start_notebook_template_setup(notebook_id, None, app.clone()) {
                Ok(Some(_)) => {}
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!("failed to resume notebook template setup: {error}");
                    failures.push(error);
                }
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "failed to resume {} notebook template setup job(s): {}",
                failures.len(),
                failures.join("; ")
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("notebook setup recovery task failed: {error}"))?
}

/// Attach a deferred template to an already registered notebook.
/// This is used by retry-safe onboarding when its chosen default path was
/// registered before the current onboarding attempt.
#[tauri::command]
pub async fn ensure_notebook_template_setup(
    notebook_id: String,
    template_id: String,
    overwrite_existing: Option<bool>,
    app: AppHandle,
) -> Result<NotebookSetupJob, String> {
    let event_app = app.clone();
    let job = tauri::async_runtime::spawn_blocking(move || {
        super::memo::creates::validate_notebook_template_id(&template_id)?;
        let state = app.state::<AppState>();
        let running = state
            .notebook_template_initializations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let notebook = memo_file
            .get_notebook_config_by_id(&notebook_id)
            .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
        let existing = memo_file
            .get_notebook_setup_job(&notebook_id)
            .map_err(|error| format!("read notebook setup status failed: {error}"))?;
        if let Some(existing) = &existing {
            let matches = match existing.template_id.as_deref() {
                Some(existing_id) => {
                    super::memo::creates::notebook_template_ids_match(existing_id, &template_id)?
                }
                None => false,
            };
            if !matches {
                return Err("NOTEBOOK_TEMPLATE_SELECTION_CONFLICT".to_string());
            }
        }

        let notebook_root = PathBuf::from(&notebook.path);
        if !notebook_root.is_dir() {
            return Err("PATH_MISSING".to_string());
        }
        let overwrite_existing = overwrite_existing.unwrap_or(false);
        if existing.is_none()
            && !overwrite_existing
            && super::notebook::notebook_folder_has_content(&notebook_root)?
        {
            return Err("NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED".to_string());
        }
        if overwrite_existing
            && existing.as_ref().is_some_and(|job| !job.overwrite_existing)
            && running.contains(&notebook_id)
        {
            return Err("NOTEBOOK_TEMPLATE_SETUP_IN_PROGRESS".to_string());
        }
        MemoFile::ensure_notebook_scene_id(&notebook, &template_id)
            .map_err(|error| format!("NOTEBOOK_SCENE_ID_WRITE_FAILED: {error}"))?;

        if let Some(mut existing) = existing {
            let normalize_template_id = !running.contains(&notebook_id)
                && existing.template_id.as_deref() != Some(template_id.as_str());
            let enable_overwrite = overwrite_existing && !existing.overwrite_existing;
            if normalize_template_id {
                existing.template_id = Some(template_id);
            }
            if enable_overwrite {
                existing.overwrite_existing = true;
                existing.status = NotebookSetupJobStatus::Pending;
                existing.stage = NotebookSetupStage::Preparing;
                existing.message = None;
                existing.report = None;
            }
            if normalize_template_id || enable_overwrite {
                existing.updated_at = chrono::Utc::now().timestamp_millis();
                existing = memo_file
                    .write_notebook_setup_job(&existing)
                    .map_err(|error| format!("persist notebook setup status failed: {error}"))?;
            }
            return Ok(existing);
        }
        let job = NotebookSetupJob {
            notebook_id,
            job_id: uuid::Uuid::now_v7().to_string(),
            template_id: Some(template_id),
            overwrite_existing,
            status: NotebookSetupJobStatus::Pending,
            stage: NotebookSetupStage::Preparing,
            revision: 0,
            run_id: String::new(),
            message: None,
            report: None,
            updated_at: chrono::Utc::now().timestamp_millis(),
            execution_requested: false,
        };
        let job = memo_file
            .write_notebook_setup_job(&job)
            .map_err(|error| format!("persist notebook setup status failed: {error}"))?;
        Ok(job)
    })
    .await
    .map_err(|error| format!("notebook template setup registration task failed: {error}"))??;
    emit_notebook_setup_job(&event_app, job.clone());
    Ok(job)
}

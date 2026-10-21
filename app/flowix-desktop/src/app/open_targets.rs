//! Trusted OS file-open ingress and pending requests for the main window.
//! Events only notify consumers; requests remain available until acknowledged.

use crate::app::document_access::DocumentAccess;
use crate::app::state::AppState;
use crate::commands::helpers::is_registered_notebook_path_with_state;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const CHANGED_EVENT: &str = "flowix:open-targets-changed";

#[derive(Clone, Copy, serde::Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OpenTargetConsumer {
    Path,
    ExternalMarkdown,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum OpenTarget {
    Path { path: String },
    ExternalMarkdown { file_paths: Vec<String> },
    Error { message: String },
}

impl OpenTarget {
    fn consumer(&self) -> OpenTargetConsumer {
        match self {
            Self::ExternalMarkdown { .. } => OpenTargetConsumer::ExternalMarkdown,
            _ => OpenTargetConsumer::Path,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct OpenTargetRequest {
    id: String,
    target: OpenTarget,
}

#[derive(Default)]
pub struct PendingOpenTargets(Mutex<Vec<OpenTargetRequest>>);

impl PendingOpenTargets {
    fn push(&self, target: OpenTarget) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(OpenTargetRequest {
                id: uuid::Uuid::new_v4().to_string(),
                target,
            });
    }

    fn snapshot(&self, consumer: OpenTargetConsumer) -> Vec<OpenTargetRequest> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|request| request.target.consumer() == consumer)
            .cloned()
            .collect()
    }

    fn acknowledge(&self, ids: &[String]) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|request| !ids.contains(&request.id));
    }
}

#[tauri::command]
pub fn get_pending_open_targets(
    window: tauri::WebviewWindow,
    consumer: OpenTargetConsumer,
    pending: tauri::State<PendingOpenTargets>,
) -> Vec<OpenTargetRequest> {
    if window.label() != "main" {
        return Vec::new();
    }
    pending.snapshot(consumer)
}

#[tauri::command]
pub fn acknowledge_open_targets(
    window: tauri::WebviewWindow,
    ids: Vec<String>,
    pending: tauri::State<PendingOpenTargets>,
) {
    if window.label() == "main" {
        pending.acknowledge(&ids);
    }
}

/// All platform adapters hand raw targets to this boundary. Only native file
/// paths confer access; a deep link never grants access to an arbitrary file.
pub fn dispatch(app: &tauri::AppHandle, targets: Vec<String>, source: &str) {
    if crate::commands::window_shutdown::is_exiting() {
        return;
    }
    let state = app.state::<AppState>();
    let pending = app.state::<PendingOpenTargets>();
    let mut external = Vec::new();
    let mut changed = false;
    for raw in targets {
        let lower = raw.to_ascii_lowercase();
        if lower.starts_with("flowix://open?") || lower.starts_with("flowix://memo/") {
            pending.push(OpenTarget::Path { path: raw });
            changed = true;
            continue;
        }
        let requested = Path::new(&raw);
        if !requested
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        {
            continue;
        }
        let authorized = authorize_file(requested, &state.document_access);
        match authorized {
            Ok(path) => {
                let inside_notebook = is_registered_notebook_path_with_state(&path, &state);
                let path = path.to_string_lossy().into_owned();
                if inside_notebook {
                    pending.push(OpenTarget::Path { path });
                } else {
                    external.push(path);
                }
            }
            Err(error) => {
                tracing::warn!(source, path = %raw, %error, "OS file-open authorization failed");
                pending.push(OpenTarget::Error {
                    message: format!("{error}: {raw}"),
                });
            }
        }
        changed = true;
    }
    if !external.is_empty() {
        pending.push(OpenTarget::ExternalMarkdown {
            file_paths: external,
        });
    }
    if changed {
        focus_main_window(app);
        // Failure to notify is recoverable: consumers reconcile on listener readiness.
        if let Err(error) = app.emit(CHANGED_EVENT, ()) {
            tracing::warn!(%error, "Could not notify pending file-open requests");
        }
    }
}

fn authorize_file(requested: &Path, access: &DocumentAccess) -> Result<PathBuf, String> {
    let path =
        dunce::canonicalize(requested).map_err(|error| format!("Cannot resolve file: {error}"))?;
    if !access.grant("main", &path) {
        return Err("Cannot authorize file access".to_string());
    }
    Ok(path)
}

#[cfg(desktop)]
pub fn focus_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // A protocol launch briefly activates its own helper process. Focusing
        // the existing NSWindow alone does not reactivate the already-running
        // app on macOS, so explicitly activate NSApp on the main thread first.
        let app = app.clone();
        let app_for_main_thread = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSApp(mtm).activate();
            }
            if let Some(window) = app_for_main_thread.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_survive_notifications_until_acknowledged() {
        let pending = PendingOpenTargets::default();
        pending.push(OpenTarget::Path {
            path: "note.md".into(),
        });
        let first = pending.snapshot(OpenTargetConsumer::Path);
        assert_eq!(first.len(), 1);
        assert_eq!(
            pending.snapshot(OpenTargetConsumer::Path)[0].id,
            first[0].id
        );
        pending.push(OpenTarget::Path {
            path: "later.md".into(),
        });
        pending.acknowledge(&[first[0].id.clone()]);
        let remaining = pending.snapshot(OpenTargetConsumer::Path);
        assert_eq!(remaining.len(), 1);
        assert!(matches!(&remaining[0].target, OpenTarget::Path { path } if path == "later.md"));
    }

    #[test]
    fn consumers_receive_only_their_requests_and_external_payload_is_camel_case() {
        let pending = PendingOpenTargets::default();
        pending.push(OpenTarget::ExternalMarkdown {
            file_paths: vec!["outside.md".into()],
        });
        pending.push(OpenTarget::Error {
            message: "authorization failed".into(),
        });
        assert_eq!(pending.snapshot(OpenTargetConsumer::Path).len(), 1);
        let external = pending.snapshot(OpenTargetConsumer::ExternalMarkdown);
        assert_eq!(external.len(), 1);
        assert_eq!(
            serde_json::to_value(&external[0]).unwrap()["target"]["filePaths"][0],
            "outside.md"
        );
    }

    #[test]
    fn native_authorization_grants_only_the_selected_file_in_main_window() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        let sibling = directory.path().join("sibling.md");
        std::fs::write(&selected, "selected").unwrap();
        std::fs::write(&sibling, "sibling").unwrap();
        let access = DocumentAccess::default();
        let canonical = authorize_file(&selected, &access).unwrap();
        assert!(canonical.is_absolute());
        assert!(access.contains("main", &selected));
        assert!(!access.contains("other-window", &selected));
        assert!(!access.contains("main", &sibling));
        assert!(authorize_file(directory.path(), &access).is_err());
        assert!(authorize_file(&directory.path().join("missing.md"), &access).is_err());
    }
}

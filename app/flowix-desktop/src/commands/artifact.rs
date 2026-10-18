use tauri::State;

use crate::app::state::AppState;

/// Resolve a durable artifact pointer through the host artifact service.
/// This command intentionally does not live under the plugin API: a plugin
/// can be removed while its artifact remains a readable notebook document.
#[tauri::command]
pub fn artifact_resolve(
    note_path: String,
    state: State<AppState>,
) -> Result<crate::artifact::ArtifactSession, String> {
    crate::artifact::resolve(&note_path, &state.memo_file)
}

//! Android export bridge.
//!
//! Desktop exports write to real filesystem paths. Android's document picker
//! (SAF) instead returns a `content://` URI and has already created the target
//! document, so text bytes must be written through a `ContentResolver` stream.
//! PDF has no app-writable equivalent: the platform only exposes WebView ->
//! PDF through the system print framework, so the user finishes the export in
//! the print sheet ("Save as PDF") and the spooler owns the destination.
//!
//! [`FlowixExportPlugin`]: ../../gen/android/app/src/main/java/com/flowix/app/FlowixExportPlugin.kt

use serde::Serialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

pub struct MobileExportHandle(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("flowix-export")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.flowix.app", "FlowixExportPlugin")?;
            app.manage(MobileExportHandle(handle));
            Ok(())
        })
        .build()
}

fn plugin(app: &AppHandle) -> Result<PluginHandle<Wry>, String> {
    app.try_state::<MobileExportHandle>()
        .map(|state| state.0.clone())
        .ok_or_else(|| "Android export plugin is not initialized".to_string())
}

#[derive(Serialize)]
struct TextPayload<'a> {
    uri: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintPayload<'a> {
    job_name: &'a str,
}

/// Write UTF-8 text into a SAF document, truncating any previous content.
pub fn write_text(app: &AppHandle, uri: &str, content: &str) -> Result<(), String> {
    plugin(app)?
        .run_mobile_plugin::<()>("writeTextToUri", TextPayload { uri, content })
        .map_err(|error| error.to_string())
}

/// Open Android's print sheet for the live document. The spooler writes the
/// PDF itself ("Save as PDF"); the returned flag reports whether the job
/// reached the write phase, i.e. whether the user actually saved a document.
pub async fn print_document(app: &AppHandle, job_name: &str) -> Result<bool, String> {
    plugin(app)?
        .run_mobile_plugin_async::<bool>("printDocument", PrintPayload { job_name })
        .await
        .map_err(|error| error.to_string())
}

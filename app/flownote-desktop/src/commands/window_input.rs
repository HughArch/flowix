//! Thin IPC adapter for native input routing.
/// Publish visual button geometry; routing itself lives outside the WebView.
#[tauri::command]
pub async fn set_window_close_region(
    window: tauri::WebviewWindow,
    revision: u64,
    region: Option<crate::native_close_region::CloseRegion>,
) -> Result<(), String> {
    if region.is_some_and(|region| !region.valid()) {
        return Err("Invalid close region".into());
    }
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        let route = crate::commands::window_shutdown::close_route(&window)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(crate::native_close_region::set(
                    hwnd, route, revision, region,
                ));
            })
            .map_err(|error| error.to_string())?;
        return receiver.await.map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (window, revision, region);
        Ok(())
    }
}

/// Actual receiver health, not merely whether initialization was attempted.
#[tauri::command]
pub fn native_close_routing_ready() -> bool {
    #[cfg(windows)]
    {
        crate::native_close_region::routing_ready()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

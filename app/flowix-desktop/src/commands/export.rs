//! Native document exporters.
//!
//! The web layer owns the printable DOM. This module only asks the platform
//! WebView to turn that DOM into PDF bytes, then commits the result through the
//! existing export authorization and atomic-write path.

#[cfg(not(target_os = "android"))]
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

use tauri::{State, WebviewWindow};

use crate::app::state::AppState;
#[cfg(not(target_os = "android"))]
use crate::lock_utils::read_lock;

#[cfg(not(target_os = "android"))]
fn temporary_pdf_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "PDF target has no parent directory".to_string())?;
    let temporary = tempfile::Builder::new()
        .prefix(".flowix-pdf-")
        .suffix(".pdf")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    let path = temporary.path().to_path_buf();
    drop(temporary);
    Ok(path)
}

#[cfg(target_os = "macos")]
fn pdf_file_is_complete(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if metadata.len() < 5 {
        return false;
    }

    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let tail_start = metadata.len().saturating_sub(128);
    if file.seek(SeekFrom::Start(tail_start)).is_err() {
        return false;
    }

    let mut tail = Vec::with_capacity((metadata.len() - tail_start) as usize);
    if file.read_to_end(&mut tail).is_err() {
        return false;
    }

    tail.windows(5).any(|window| window == b"%%EOF")
}

#[tauri::command]
pub async fn export_pdf(
    window: WebviewWindow,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&window, &state, &file_path);
        Err("use print_pdf on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let requested = Path::new(&file_path);
        let target = state
            .export_access
            .authorized_target(window.label(), requested)
            .map_err(|error| error.to_string())?;
        let temporary = temporary_pdf_path(&target)?;

        let native_result = export_pdf_native(window.clone(), temporary.clone()).await;
        let result = match native_result {
            Ok(()) => {
                let mut reader = File::open(&temporary).map_err(|error| error.to_string())?;
                state
                    .export_access
                    .save(
                        window.label(),
                        &target,
                        &mut reader,
                        &read_lock(&state.memo_file, "memo_file"),
                    )
                    .map(|()| true)
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error),
        };

        let _ = fs::remove_file(&temporary);
        result
    }
}

/// Android has no writable WebView-PDF primitive: the system print framework
/// owns the destination document. The web layer calls this instead of the
/// desktop [`export_pdf`] and lets the user pick "Save as PDF" in the print
/// sheet. Resolves once the spooler has finished with the document so the
/// web layer can restore the print DOM.
#[tauri::command]
pub async fn print_pdf(app: tauri::AppHandle, job_name: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let job_name = job_name.unwrap_or_else(|| "Flowix".to_string());
        crate::mobile_export::print_document(&app, &job_name).await
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, job_name);
        Err("Native PDF printing is only available on Android".to_string())
    }
}

#[cfg(target_os = "macos")]
async fn export_pdf_native(window: WebviewWindow, output: PathBuf) -> Result<(), String> {
    use std::time::Duration;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPrintInfo, NSPrintSaveJob};
    use objc2_foundation::{NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tokio::sync::oneshot;
    use tokio::time::{sleep, timeout};

    const PRINT_TIMEOUT: Duration = Duration::from_secs(30);
    // The path is reserved by `tempfile`, but AppKit's save job should create
    // the PDF itself instead of treating the empty reservation as a finished
    // export.
    let _ = fs::remove_file(&output);
    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let output_for_print = output.clone();

    window
        .with_webview(move |webview| {
            let result = (|| {
                let raw = webview.inner();
                let Some(marker) = MainThreadMarker::new() else {
                    return Err("PDF export must run on the main thread".to_string());
                };

                let Some(webview) = (unsafe { (raw as *const WKWebView).as_ref() }) else {
                    return Err("WKWebView is unavailable".to_string());
                };

                // `createPDFWithConfiguration` is a content snapshot API. On
                // some WebKit versions it keeps screen media and the current
                // viewport, which can put the application shell into the PDF.
                // The native print operation is the same WebView, but uses the
                // print layout/pagination pipeline and runs without a print UI.
                // It therefore honors the existing DOM's @media print rules
                // without changing the screen layout or mounting a print copy.
                let print_info = NSPrintInfo::new();
                let output_path = NSString::from_str(&output_for_print.to_string_lossy());
                let output_url = NSURL::fileURLWithPath(&output_path);
                let settings = unsafe { print_info.dictionary() };
                unsafe {
                    settings.insert(objc2_app_kit::NSPrintJobSavingURL, &output_url);
                    print_info.setJobDisposition(NSPrintSaveJob);
                }

                let print_operation = unsafe { webview.printOperationWithPrintInfo(&print_info) };
                print_operation.setShowsPrintPanel(false);
                print_operation.setShowsProgressPanel(false);
                // WebKit needs the AppKit main run loop while laying out pages.
                // Disallowing a separate print thread can leave `runOperation`
                // waiting on that same run loop forever.
                print_operation.setCanSpawnSeparateThread(true);

                let Some(doc_window) = webview.window() else {
                    return Err("WKWebView has no host window".to_string());
                };

                // This is the same native WebView and the same DOM the user is
                // viewing. No print UI is shown, but the modal API keeps AppKit's
                // run loop alive until WebKit has completed the PDF job.
                let _ = marker;
                unsafe {
                    print_operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        &doc_window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );
                }

                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;

    timeout(PRINT_TIMEOUT, async {
        receiver
            .await
            .map_err(|_| "WKWebView PDF operation was cancelled".to_string())??;

        // `runOperationModal...` may return as soon as AppKit has handed the
        // job to its print worker. Wait for the actual PDF trailer instead of
        // accepting a partially-written file.
        loop {
            if pdf_file_is_complete(&output) {
                return Ok(());
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "WKWebView PDF export timed out after 30 seconds".to_string())?
}

#[cfg(target_os = "windows")]
async fn export_pdf_native(window: WebviewWindow, output: PathBuf) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    use tokio::task::spawn_blocking;
    use tokio::time::timeout;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfCompletedHandler};
    use windows::core::{Interface, PCWSTR};

    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    let output = output
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();

    window
        .with_webview(move |webview| {
            let controller = webview.controller();
            let environment = webview.environment();
            let result = (|| -> windows::core::Result<()> {
                let core = unsafe { controller.CoreWebView2()? };
                let printable = core.cast::<ICoreWebView2_7>()?;
                let environment = environment.cast::<ICoreWebView2Environment6>()?;
                let settings = unsafe { environment.CreatePrintSettings()? };
                // Document content uses backgrounds as first-class formatting:
                // line/paragraph fills, mark highlights, table header fills and
                // zebra rows are all painted with `background-color`. Turning
                // this off silently drops them from the PDF. The print
                // stylesheet keeps the page itself transparent, so enabling
                // backgrounds only affects the document body.
                unsafe { settings.SetShouldPrintBackgrounds(true)? };
                let output = PCWSTR(output.as_ptr());
                let callback_sender = sender.clone();
                let callback =
                    PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                        let result = match status {
                            Ok(()) if success => Ok(()),
                            Ok(()) => Err("WebView2 did not create the PDF".to_string()),
                            Err(error) => Err(error.to_string()),
                        };
                        let _ = callback_sender.send(result);
                        Ok(())
                    }));
                unsafe { printable.PrintToPdf(output, &settings, &callback)? };
                Ok(())
            })();

            if let Err(error) = result {
                let _ = sender.send(Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;

    timeout(
        Duration::from_secs(30),
        spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|_| "WebView2 PDF callback was cancelled".to_string())?
        }),
    )
    .await
    .map_err(|_| "WebView2 PDF export timed out after 30 seconds".to_string())?
    .map_err(|error| error.to_string())?
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
async fn export_pdf_native(
    _window: WebviewWindow,
    _output: std::path::PathBuf,
) -> Result<(), String> {
    Err("Native PDF export is not supported on this platform yet".to_string())
}

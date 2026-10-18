//! Renderer-independent mouse routing for the existing frameless close button.
//! DOM owns appearance/geometry; a dedicated Raw Input thread observes clicks.
//! Input is never suppressed; window-instance routing deduplicates JS/native intent.

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseRegion {
    pub right_inset: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl CloseRegion {
    pub(crate) fn valid(self) -> bool {
        [self.right_inset, self.top, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.right_inset >= 0.0
            && self.top >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.width <= 256.0
            && self.height <= 256.0
            && self.top <= 256.0
    }

    #[cfg(any(windows, test))]
    fn contains(self, x: f64, y: f64, client_width: f64, scale: f64) -> bool {
        let right = client_width - self.right_inset * scale;
        x >= right - self.width * scale
            && x < right
            && y >= self.top * scale
            && y < (self.top + self.height) * scale
    }
}

/// A route owns a window-instance callback, never a reusable window label.
#[cfg(any(windows, test))]
#[derive(Clone)]
pub(crate) struct CloseRoute {
    pub(crate) id: u64,
    is_alive: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    callback: std::sync::Arc<dyn Fn(std::time::Instant) + Send + Sync>,
}
#[cfg(any(windows, test))]
impl CloseRoute {
    pub(crate) fn new(
        id: u64,
        is_alive: impl Fn() -> bool + Send + Sync + 'static,
        callback: impl Fn(std::time::Instant) + Send + Sync + 'static,
    ) -> Self {
        Self {
            id,
            is_alive: std::sync::Arc::new(is_alive),
            callback: std::sync::Arc::new(callback),
        }
    }
    fn is_alive(&self) -> bool {
        (self.is_alive)()
    }
    fn dispatch(&self, started: std::time::Instant) {
        (self.callback)(started);
    }
}

#[cfg(any(windows, test))]
#[path = "native_input_health.rs"]
mod health;
#[cfg(windows)]
pub(crate) use windows_impl::{remove, routing_ready, set, start};

#[cfg(windows)]
mod windows_impl {
    use super::{health::RoutingHealth, CloseRegion, CloseRoute};
    use std::{
        collections::HashMap,
        sync::{mpsc, Arc, Mutex, OnceLock},
        time::{Duration, Instant},
    };
    use windows::{
        core::w,
        Win32::{
            Foundation::{HWND, RECT},
            Graphics::Gdi::ScreenToClient,
            System::{SystemInformation::GetTickCount64, Threading::GetCurrentProcessId},
            UI::{
                HiDpi::{
                    GetDpiForWindow, SetThreadDpiAwarenessContext,
                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                },
                Input::*,
                WindowsAndMessaging::*,
            },
        },
    };

    #[derive(Clone)]
    struct Entry {
        route: CloseRoute,
        revision: u64,
        region: Option<CloseRegion>,
        dpi: u32,
    }
    fn regions() -> &'static Mutex<HashMap<usize, Entry>> {
        static REGIONS: OnceLock<Mutex<HashMap<usize, Entry>>> = OnceLock::new();
        REGIONS.get_or_init(Mutex::default)
    }
    struct Router {
        health: Arc<RoutingHealth>,
    }
    static ROUTER: OnceLock<Router> = OnceLock::new();

    /// Raw Input is process-owned, read-only mouse input. It cannot be silently
    /// removed by LowLevelHooksTimeout, and it never suppresses normal clicks.
    /// This module must remain the application's only raw mouse registration.
    pub(crate) fn start() -> Result<(), String> {
        let router = ROUTER.get_or_init(|| {
            let health = Arc::new(RoutingHealth::new());
            let (sender, receiver) = mpsc::channel::<(CloseRoute, Instant)>();
            std::thread::spawn(move || {
                for (route, started) in receiver {
                    // Blocking one Tauri dispatch cannot block input delivery.
                    std::thread::spawn(move || route.dispatch(started));
                }
            });
            let state = health.clone();
            std::thread::spawn(move || loop {
                state.retrying();
                // Initialization and GetMessage failures are recoverable. The
                // initialized singleton is never confused with active routing.
                if unsafe { input_pump(&sender, &state) }.is_err() {
                    state.retrying();
                }
                std::thread::sleep(Duration::from_secs(1));
            });
            Router { health }
        });
        // Give first registration a small startup opportunity; never wait for
        // the UI thread or indefinitely block application startup.
        let until = Instant::now() + Duration::from_millis(100);
        while !router.health.ready(Instant::now()) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        if routing_ready() {
            Ok(())
        } else {
            Err("Native close input is recovering; automatic retry is active".into())
        }
    }
    pub(crate) fn routing_ready() -> bool {
        ROUTER
            .get()
            .is_some_and(|router| router.health.ready(Instant::now()))
    }

    unsafe fn input_pump(
        sender: &mpsc::Sender<(CloseRoute, Instant)>,
        health: &RoutingHealth,
    ) -> Result<(), String> {
        if SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            .0
            .is_null()
        {
            return Err("Per-monitor DPI awareness is unavailable for native close input".into());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Flowix close input"),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .map_err(|error| error.to_string())?;
        let result = pump_registered(hwnd, sender, health);
        health.retrying();
        let _ = RegisterRawInputDevices(
            &[RAWINPUTDEVICE {
                usUsagePage: 1,
                usUsage: 2,
                dwFlags: RIDEV_REMOVE,
                hwndTarget: HWND::default(),
            }],
            std::mem::size_of::<RAWINPUTDEVICE>() as u32,
        );
        let _ = DestroyWindow(hwnd);
        result
    }
    unsafe fn pump_registered(
        hwnd: HWND,
        sender: &mpsc::Sender<(CloseRoute, Instant)>,
        health: &RoutingHealth,
    ) -> Result<(), String> {
        RegisterRawInputDevices(
            &[RAWINPUTDEVICE {
                usUsagePage: 1,
                usUsage: 2,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            }],
            std::mem::size_of::<RAWINPUTDEVICE>() as u32,
        )
        .map_err(|error| error.to_string())?;
        if SetTimer(Some(hwnd), 1, 1000, None) == 0 {
            return Err("Native input heartbeat unavailable".into());
        }
        health.heartbeat(Instant::now());
        let mut pressed: Option<(usize, CloseRoute)> = None;
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result <= 0 {
                return Err("Native input message pump stopped".into());
            }
            // Refresh on any message as well as the timer. Continuous mouse
            // traffic can defer WM_TIMER because Windows queues timers last.
            health.heartbeat(Instant::now());
            if message.message == WM_INPUT {
                let mut raw = RAWINPUT::default();
                let mut size = std::mem::size_of::<RAWINPUT>() as u32;
                let copied = GetRawInputData(
                    HRAWINPUT(message.lParam.0 as _),
                    RID_INPUT,
                    Some((&mut raw as *mut RAWINPUT).cast()),
                    &mut size,
                    std::mem::size_of::<RAWINPUTHEADER>() as u32,
                );
                if copied != u32::MAX
                    && copied >= std::mem::size_of::<RAWINPUT>() as u32
                    && raw.header.dwType == RIM_TYPEMOUSE.0
                {
                    let flags = raw.data.mouse.Anonymous.Anonymous.usButtonFlags as u32;
                    if flags & (RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_LEFT_BUTTON_UP) != 0 {
                        // MSG.pt/time are sampled when input was posted, rather
                        // than using today's cursor position after queue delay.
                        let hit = hit_region(message.pt);
                        if flags & RI_MOUSE_LEFT_BUTTON_DOWN != 0 {
                            pressed = hit.clone();
                        }
                        if flags & RI_MOUSE_LEFT_BUTTON_UP != 0 {
                            if let Some((down, route)) = pressed.take() {
                                if hit.is_some_and(|(up, entry)| up == down && entry.id == route.id)
                                {
                                    let age = (GetTickCount64() as u32).wrapping_sub(message.time);
                                    let now = Instant::now();
                                    let started = now
                                        .checked_sub(Duration::from_millis(age as u64))
                                        .unwrap_or(now);
                                    let _ = sender.send((route, started));
                                }
                            }
                        }
                    }
                }
                // Raw Input foreground messages require native buffer cleanup.
                DefWindowProcW(
                    message.hwnd,
                    message.message,
                    message.wParam,
                    message.lParam,
                );
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    unsafe fn hit_region(
        mut point: windows::Win32::Foundation::POINT,
    ) -> Option<(usize, CloseRoute)> {
        let root = GetAncestor(WindowFromPoint(point), GA_ROOT);
        let hwnd = root.0 as usize;
        let mut process = 0;
        GetWindowThreadProcessId(root, Some(&mut process));
        if process != GetCurrentProcessId() {
            return None;
        }
        let entry = regions().try_lock().ok()?.get(&hwnd)?.clone();
        let region = entry.region?;
        let mut client = RECT::default();
        if !ScreenToClient(root, &mut point).as_bool() || GetClientRect(root, &mut client).is_err()
        {
            return None;
        }
        region
            .contains(
                point.x as f64,
                point.y as f64,
                client.right as f64,
                GetDpiForWindow(root).max(96) as f64 / entry.dpi as f64,
            )
            .then_some((hwnd, entry.route))
    }

    pub(crate) fn set(
        hwnd: usize,
        route: CloseRoute,
        revision: u64,
        region: Option<CloseRegion>,
    ) -> Result<(), String> {
        if region.is_some_and(|region| !region.valid()) {
            return Err("Invalid close region".into());
        }
        let mut process = 0;
        unsafe {
            GetWindowThreadProcessId(HWND(hwnd as _), Some(&mut process));
        }
        if process != unsafe { GetCurrentProcessId() } {
            return Err("Close region is not an application window".into());
        }
        let dpi = unsafe { GetDpiForWindow(HWND(hwnd as _)) }.max(96);
        let mut entries = regions().lock().unwrap_or_else(|e| e.into_inner());
        // A delayed IPC from a destroyed window must not replace a new
        // instance's route after Windows reuses the same HWND.
        if !route.is_alive() {
            return Err("Window has already been destroyed".into());
        }
        if entries
            .get(&hwnd)
            .is_some_and(|entry| entry.route.id == route.id && entry.revision >= revision)
        {
            return Ok(());
        }
        entries.insert(
            hwnd,
            Entry {
                route,
                revision,
                region,
                dpi,
            },
        );
        Ok(())
    }
    pub(crate) fn remove(id: u64) {
        regions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| entry.route.id != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    fn button() -> CloseRegion {
        CloseRegion {
            right_inset: 0.0,
            top: 0.0,
            width: 42.0,
            height: 36.0,
        }
    }
    #[test]
    fn close_does_not_capture_adjacent_maximize_or_content() {
        let button = button();
        assert!(button.contains(999.0, 35.0, 1000.0, 1.0));
        assert!(!button.contains(957.0, 10.0, 1000.0, 1.0));
        assert!(!button.contains(990.0, 36.0, 1000.0, 1.0));
    }
    #[test]
    fn region_follows_resize_and_dpi_without_renderer_updates() {
        assert!(button().contains(1999.0, 71.0, 2000.0, 2.0));
        assert!(!button().contains(1915.0, 10.0, 2000.0, 2.0));
        assert!(button().contains(499.0, 10.0, 500.0, 1.0));
    }
    #[test]
    fn invalid_region_cannot_capture_window_content() {
        assert!(!CloseRegion {
            width: f64::NAN,
            ..button()
        }
        .valid());
        assert!(!CloseRegion {
            height: 1000.0,
            ..button()
        }
        .valid());
    }

    #[test]
    fn captured_close_route_stops_accepting_input_after_its_window_dies() {
        let alive = Arc::new(AtomicBool::new(true));
        let route_alive = alive.clone();
        let route = CloseRoute::new(7, move || route_alive.load(Ordering::Acquire), |_| {});
        assert!(route.is_alive());
        alive.store(false, Ordering::Release);
        assert!(!route.is_alive());
    }
}

//! 系统托盘 (desktop only)：图标 + 右键菜单 + 点击打开主窗口。
//!
//! 菜单由 OS 原生渲染 (Windows 弹出菜单 / macOS NSMenu)，没有自定义样式空间；
//! 视觉上保持克制：仅「打开主窗口」「退出」两项加一条分隔线，文案跟随 UI 语言。
//! macOS 菜单栏图标走 template 模式，随系统明暗菜单栏自动反色。

#[cfg(desktop)]
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    desktop::setup(app)
}

#[cfg(desktop)]
pub fn set_language(app: &tauri::AppHandle, language: &str) -> tauri::Result<()> {
    desktop::set_language(app, language)
}

#[cfg(not(desktop))]
pub fn setup(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(desktop))]
pub fn set_language(_app: &tauri::AppHandle, _language: &str) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
mod desktop {
    use crate::app::open_targets;
    use crate::app::state::AppState;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    const TRAY_ID: &str = "flowix-main-tray";
    const OPEN_MENU_ID: &str = "flowix-tray-open";
    const QUIT_MENU_ID: &str = "flowix-tray-quit";

    struct TrayLabels {
        open: String,
        quit: String,
    }

    /// 与 native_menu 的双语策略一致：en-US / en 走英文，其余走中文。
    fn tray_labels(app_name: &str, language: &str) -> TrayLabels {
        let english =
            language.eq_ignore_ascii_case("en-us") || language.eq_ignore_ascii_case("en");
        if english {
            TrayLabels {
                open: format!("Open {app_name}"),
                quit: format!("Quit {app_name}"),
            }
        } else {
            TrayLabels {
                open: format!("打开 {app_name}"),
                quit: format!("退出 {app_name}"),
            }
        }
    }

    fn build_menu(app: &tauri::AppHandle, language: &str) -> tauri::Result<Menu<tauri::Wry>> {
        let labels = tray_labels(&app.package_info().name.clone(), language);
        let open = MenuItem::with_id(app, OPEN_MENU_ID, labels.open, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, QUIT_MENU_ID, labels.quit, true, None::<&str>)?;
        Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])
    }

    pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
        let language = app
            .try_state::<AppState>()
            .map(|state| state.user_config.get_preference().language)
            .unwrap_or_default();
        let menu = build_menu(app, &language)?;

        // Windows: 左键不弹菜单 (留给打开主窗口)，右键由系统弹菜单；
        // macOS: 菜单栏图标惯例是点击即弹菜单。
        #[cfg(target_os = "macos")]
        let builder = TrayIconBuilder::with_id(TRAY_ID).show_menu_on_left_click(true);
        #[cfg(not(target_os = "macos"))]
        let builder = TrayIconBuilder::with_id(TRAY_ID).show_menu_on_left_click(false);

        let builder = builder
            .icon(app.default_window_icon().ok_or_else(|| {
                tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "missing default window icon",
                ))
            })?.clone())
            .tooltip(app.package_info().name.clone())
            .menu(&menu)
            .on_menu_event(|app, event| match event.id().as_ref() {
                OPEN_MENU_ID => open_targets::focus_main_window(app),
                QUIT_MENU_ID => {
                    // 统一退出管线：文档保存 → 子进程清理 → 退出。
                    crate::commands::window_shutdown::request_exit(app, 0);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                match event {
                    // 双击打开 ── Windows/macOS 的单击分支已先行打开，这里兜住
                    // 双击事件的独立触发场景。
                    TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => open_targets::focus_main_window(tray.app_handle()),
                    // Windows/Linux 单击即打开 (标准托盘交互)；macOS 单击已由
                    // 菜单接管 (show_menu_on_left_click(true))。
                    #[cfg(not(target_os = "macos"))]
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => open_targets::focus_main_window(tray.app_handle()),
                    _ => {}
                }
            })
            // macOS 菜单栏图标必须是 template image，否则彩色方形图标在明暗
            // 菜单栏里都非常突兀。template 模式按 alpha 通道自动适配反色；
            // 该标志在 Windows/Linux 无效果，交叉平台统一传入即可。
            .icon_as_template(cfg!(target_os = "macos"));
        builder.build(app)?;
        Ok(())
    }

    /// 语言切换时整体重建菜单 (与 native_menu 同策略：不逐项改文案)。
    pub fn set_language(app: &tauri::AppHandle, language: &str) -> tauri::Result<()> {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_menu(Some(build_menu(app, language)?))?;
        }
        Ok(())
    }
}

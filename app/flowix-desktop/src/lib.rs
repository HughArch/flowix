// `deepseek_harness_e2e` 集成测试需要真实 Wry AppHandle（主线程）+ 仓内类型,
// 因此这几个模块对外可见。app crate 无外部消费者, 可见性放宽无成本。
pub mod agent_builtin;
pub mod agent_external;
mod agent_external_config;
pub mod agent_history;
pub mod agent_lifecycle;
pub mod agent_session;
mod agent_types;
pub mod agent_wire;
mod app;
#[cfg(desktop)]
mod app_update;
mod artifact;
mod cli_link;
mod commands;
pub mod config;
mod connection_probe;
mod device_registration;
mod document_mutation;
mod document_io;
mod dsh;
mod events;
mod fns_sync;
mod frame_scrollbar;
mod lock_utils;
mod maintenance;
mod memo_events;
mod plugin;
mod process_window;
mod runtime_log;
#[cfg(windows)]
mod runtime_state;
mod system_data;
mod storage_initialization;
mod template_store;
mod update_security;
mod watcher;
mod window_chrome;
mod window_material;
mod native_close_region;

pub use app::{get_app_data_path, get_user_config_dir, APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

// 移动端入口 ── 该属性宏生成 Android/iOS 启动所需的 JNI 入口符号 (桌面为空)。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}

use std::path::PathBuf;

/// 用户配置�?���?(~/.<NAME>/ 下放 db/*.db / boot/preference.json /
/// agent-config.toml / boot/system.json 绛?銆?
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 桌面应用数据�?���?(�?`dirs::data_dir()` 之下, macOS:
/// `~/Library/Application Support/<NAME>/`)銆?
pub const APP_DATA_DIR_NAME: &str = "flowix";

/// 移动端 app 私有主目录 ── Android 上 `dirs::home_dir()` 为 None, 启动路径
/// (配置根 / 数据库 / 线程库) 全部以此为准。包名由 wry 在进程初始化时通过
/// `WRY_ANDROID_PACKAGE` 注入, 兜底为生产包名。
#[cfg(mobile)]
pub fn mobile_home_dir() -> PathBuf {
    let package =
        std::env::var("WRY_ANDROID_PACKAGE").unwrap_or_else(|_| "com.flowix.app".to_string());
    PathBuf::from("/data/user/0").join(package).join("files")
}

pub fn get_app_data_path() -> PathBuf {
    #[cfg(mobile)]
    return mobile_home_dir();

    #[cfg(desktop)]
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}

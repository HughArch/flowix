//! Global FNS credentials and preferences.
//!
//! 实现已下沉到 [`flowix_core::fns_config`] (CLI / 内置 Agent 需要读取同一份
//! `boot/fns-sync.json`, 结构体定义必须单源); 此模块只做 re-export, 桌面内
//! 既有的 `crate::fns_sync::config::*` 引用路径不变。

pub use flowix_core::fns_config::{
    FnsConfig, FnsConfigPatch, FnsConfigView, FnsToken, FnsTokenInput, FnsTokenView,
    DEFAULT_CLIENT_TYPE, DEFAULT_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_RETRY_ATTEMPTS,
    DEFAULT_OFFLINE_SYNC_STRATEGY, DEFAULT_STARTUP_SYNC_DELAY_SECONDS,
};

/// 策略字符串 → 引擎枚举的映射。留在桌面侧是因为枚举类型在 flowix-fns,
/// core 单源只保字段本体 (见 flowix_core::fns_config)。
pub fn offline_sync_strategy(config: &FnsConfig) -> flowix_fns::OfflineSyncStrategy {
    match config.offline_sync_strategy.as_str() {
        "newTimeMerge" => flowix_fns::OfflineSyncStrategy::NewTimeMerge,
        "ignoreTimeMerge" => flowix_fns::OfflineSyncStrategy::IgnoreTimeMerge,
        _ => flowix_fns::OfflineSyncStrategy::ManualMerge,
    }
}

//! Built-in assistant configuration, stored separately from every desktop
//! agent config (`agent-config.toml`, Pi, DSH, agent-external-config).
//!
//! The file lives at `<user_config_dir>/boot/builtin-ai.json`. The API key is
//! stored alongside it (same trust level as the FNS token in
//! `boot/fns-sync.json`); IPC views never echo it back.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const BOOT_DIR: &str = "boot";
const FILE_NAME: &str = "builtin-ai.json";
/// Rough token budget across one run (system + history + tool results).
pub const DEFAULT_MAX_TOTAL_TOKENS: u32 = 180_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuiltinAiConfig {
    pub enabled: bool,
    /// OpenAI-compatible base URL, e.g. `https://api.deepseek.com` or
    /// `https://api.openai.com/v1`. `/chat/completions` is appended.
    pub api_url: String,
    pub api_key: String,
    pub model: String,
    pub max_total_tokens: u32,
    /// Expose the `web_search` tool. Off by default: it calls an external
    /// search service, which the user must opt into.
    pub web_search_enabled: bool,
}

impl Default for BuiltinAiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            max_total_tokens: DEFAULT_MAX_TOTAL_TOKENS,
            web_search_enabled: false,
        }
    }
}

impl BuiltinAiConfig {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(BOOT_DIR).join(FILE_NAME)
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!(path = %path.display(), "invalid built-in AI config: {error}");
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(path = %path.display(), "could not read built-in AI config: {error}");
                Self::default()
            }
        }
    }

    pub fn save(&self, config_dir: &Path) -> io::Result<()> {
        let path = Self::path(config_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        // 覆盖写（noclobber 版本在文件已存在时报 AlreadyExists）。
        flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
    }

    /// True when chat can actually start: the three provider fields are set.
    pub fn is_configured(&self) -> bool {
        !self.api_url.trim().is_empty()
            && !self.api_key.trim().is_empty()
            && !self.model.trim().is_empty()
    }

    /// Base URL for the chat-completions endpoint. Accepts both
    /// `https://host` and `https://host/v1` styles.
    pub fn chat_endpoint(&self) -> String {
        format!("{}/chat/completions", self.api_base())
    }

    /// Base URL for the models-list endpoint.
    pub fn models_endpoint(&self) -> String {
        format!("{}/models", self.api_base())
    }

    fn api_base(&self) -> &str {
        self.api_url.trim().trim_end_matches('/')
    }
}

/// IPC view: never carries the plaintext key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiConfigView {
    pub enabled: bool,
    pub api_url: String,
    pub model: String,
    pub max_total_tokens: u32,
    pub web_search_enabled: bool,
    pub has_api_key: bool,
    pub configured: bool,
}

impl BuiltinAiConfig {
    pub fn view(&self) -> BuiltinAiConfigView {
        BuiltinAiConfigView {
            enabled: self.enabled,
            api_url: self.api_url.clone(),
            model: self.model.clone(),
            max_total_tokens: self.max_total_tokens,
            web_search_enabled: self.web_search_enabled,
            has_api_key: !self.api_key.trim().is_empty(),
            configured: self.is_configured(),
        }
    }
}

/// IPC input for `agent_builtin_set_config`. `api_key = None` keeps the
/// stored key; an explicit string (including empty) replaces it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiConfigInput {
    pub enabled: bool,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model: String,
    #[serde(default)]
    pub max_total_tokens: Option<u32>,
    #[serde(default)]
    pub web_search_enabled: bool,
}

impl BuiltinAiConfig {
    pub fn apply(&mut self, input: BuiltinAiConfigInput) {
        self.enabled = input.enabled;
        self.api_url = input.api_url.trim().trim_end_matches('/').to_owned();
        if let Some(key) = input.api_key {
            self.api_key = key.trim().to_owned();
        }
        self.model = input.model.trim().to_owned();
        self.web_search_enabled = input.web_search_enabled;
        if let Some(budget) = input.max_total_tokens {
            self.max_total_tokens = budget.max(1_000);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = BuiltinAiConfig::default();
        config.apply(BuiltinAiConfigInput {
            enabled: true,
            api_url: "https://api.deepseek.com/".into(),
            api_key: Some(" sk-test ".into()),
            model: "deepseek-chat".into(),
            max_total_tokens: Some(50_000),
            web_search_enabled: true,
        });
        config.save(dir.path()).unwrap();
        // 重复保存（覆盖已存在文件）不能再报 AlreadyExists。
        config.save(dir.path()).unwrap();
        let loaded = BuiltinAiConfig::load(dir.path());
        assert!(loaded.enabled);
        assert_eq!(loaded.api_url, "https://api.deepseek.com");
        assert_eq!(loaded.api_key, "sk-test");
        assert_eq!(loaded.model, "deepseek-chat");
        assert_eq!(loaded.max_total_tokens, 50_000);
        assert!(loaded.web_search_enabled);
        assert!(loaded.is_configured());
        assert_eq!(loaded.chat_endpoint(), "https://api.deepseek.com/chat/completions");
        assert_eq!(loaded.models_endpoint(), "https://api.deepseek.com/models");
    }

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let config = BuiltinAiConfig::load(dir.path());
        assert!(!config.is_configured());
        assert!(!config.view().has_api_key);
    }

    #[test]
    fn none_api_key_keeps_stored_value() {
        let mut config = BuiltinAiConfig::default();
        config.api_key = "keep-me".into();
        config.apply(BuiltinAiConfigInput {
            enabled: true,
            api_url: "https://x/v1".into(),
            api_key: None,
            model: "m".into(),
            max_total_tokens: None,
            web_search_enabled: false,
        });
        assert_eq!(config.api_key, "keep-me");
        assert_eq!(config.chat_endpoint(), "https://x/v1/chat/completions");
    }
}

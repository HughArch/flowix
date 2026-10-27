//! Built-in assistant configuration, stored separately from every desktop
//! agent config (`agent-config.toml`, Pi, DSH, agent-external-config).
//!
//! The file lives at `<user_config_dir>/boot/builtin-ai.json`. API keys are
//! stored alongside it (same trust level as the FNS token in
//! `boot/fns-sync.json`); IPC views never echo them back.
//!
//! Multiple providers are supported: each entry is one OpenAI-compatible
//! endpoint + key + default model, and the user can switch the active provider
//! from the AI panel. Legacy single-provider files are migrated on load.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const BOOT_DIR: &str = "boot";
const FILE_NAME: &str = "builtin-ai.json";

/// One provider configuration (vendor endpoint + credentials + default model).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuiltinAiProvider {
    pub id: String,
    /// User-visible label, e.g. "DeepSeek" / "OpenAI".
    pub name: String,
    /// OpenAI-compatible base URL, e.g. `https://api.deepseek.com` or
    /// `https://api.openai.com/v1`. `/chat/completions` is appended.
    pub api_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for BuiltinAiProvider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            api_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        }
    }
}

impl BuiltinAiProvider {
    pub fn api_base(&self) -> &str {
        self.api_url.trim().trim_end_matches('/')
    }

    pub fn chat_endpoint(&self) -> String {
        format!("{}/chat/completions", self.api_base())
    }

    pub fn models_endpoint(&self) -> String {
        format!("{}/models", self.api_base())
    }

    pub fn is_configured(&self) -> bool {
        !self.api_url.trim().is_empty()
            && !self.api_key.trim().is_empty()
            && !self.model.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuiltinAiConfig {
    pub enabled: bool,
    /// Expose the `web_search` tool. Off by default: it calls an external
    /// search service, which the user must opt into.
    pub web_search_enabled: bool,
    pub providers: Vec<BuiltinAiProvider>,
    pub active_provider_id: String,
    // ── Legacy single-provider fields (read-only migration) ──────────────
    #[serde(default, rename = "apiUrl", skip_serializing)]
    legacy_api_url: String,
    #[serde(default, rename = "apiKey", skip_serializing)]
    legacy_api_key: String,
    #[serde(default, rename = "model", skip_serializing)]
    legacy_model: String,
}

impl Default for BuiltinAiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            web_search_enabled: false,
            providers: Vec::new(),
            active_provider_id: String::new(),
            legacy_api_url: String::new(),
            legacy_api_key: String::new(),
            legacy_model: String::new(),
        }
    }
}

fn provider_name_from_url(api_url: &str) -> String {
    url::Url::parse(api_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "默认".to_owned())
}

impl BuiltinAiConfig {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(BOOT_DIR).join(FILE_NAME)
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        let mut config = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!(path = %path.display(), "invalid built-in AI config: {error}");
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(path = %path.display(), "could not read built-in AI config: {error}");
                Self::default()
            }
        };
        config.migrate();
        config
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

    /// Fold the pre-multi-provider shape into a single provider and make sure
    /// `active_provider_id` points at an existing entry.
    fn migrate(&mut self) {
        if self.providers.is_empty() && !self.legacy_api_url.trim().is_empty() {
            let api_url = self.legacy_api_url.trim().trim_end_matches('/').to_owned();
            self.providers.push(BuiltinAiProvider {
                id: "default".to_owned(),
                name: provider_name_from_url(&api_url),
                api_url,
                api_key: self.legacy_api_key.trim().to_owned(),
                model: self.legacy_model.trim().to_owned(),
            });
            self.active_provider_id = "default".to_owned();
        }
        self.legacy_api_url.clear();
        self.legacy_api_key.clear();
        self.legacy_model.clear();
        if !self
            .providers
            .iter()
            .any(|provider| provider.id == self.active_provider_id)
        {
            self.active_provider_id = self
                .providers
                .first()
                .map(|provider| provider.id.clone())
                .unwrap_or_default();
        }
    }

    pub fn active_provider(&self) -> Option<&BuiltinAiProvider> {
        self.providers
            .iter()
            .find(|provider| provider.id == self.active_provider_id)
            .or_else(|| self.providers.first())
    }

    /// True when chat can actually start: the active provider has all three
    /// fields set.
    pub fn is_configured(&self) -> bool {
        self.active_provider()
            .is_some_and(BuiltinAiProvider::is_configured)
    }

    pub fn set_active_provider(&mut self, provider_id: &str) -> Result<(), String> {
        if !self
            .providers
            .iter()
            .any(|provider| provider.id == provider_id)
        {
            return Err("未知的 AI 厂商配置".to_owned());
        }
        self.active_provider_id = provider_id.to_owned();
        Ok(())
    }
}

/// IPC view: never carries plaintext keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiProviderView {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    pub has_api_key: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiConfigView {
    pub enabled: bool,
    pub web_search_enabled: bool,
    pub providers: Vec<BuiltinAiProviderView>,
    pub active_provider_id: String,
    pub configured: bool,
}

impl BuiltinAiConfig {
    pub fn view(&self) -> BuiltinAiConfigView {
        BuiltinAiConfigView {
            enabled: self.enabled,
            web_search_enabled: self.web_search_enabled,
            providers: self
                .providers
                .iter()
                .map(|provider| BuiltinAiProviderView {
                    id: provider.id.clone(),
                    name: provider.name.clone(),
                    api_url: provider.api_url.clone(),
                    model: provider.model.clone(),
                    has_api_key: !provider.api_key.trim().is_empty(),
                    configured: provider.is_configured(),
                })
                .collect(),
            active_provider_id: self.active_provider_id.clone(),
            configured: self.is_configured(),
        }
    }
}

/// IPC input for `agent_builtin_set_config`. `api_key = None` keeps the
/// stored key for an existing provider; an explicit string replaces it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiConfigInput {
    pub enabled: bool,
    #[serde(default)]
    pub web_search_enabled: bool,
    pub providers: Vec<BuiltinAiProviderInput>,
    #[serde(default)]
    pub active_provider_id: String,
}

impl BuiltinAiConfig {
    pub fn apply(&mut self, input: BuiltinAiConfigInput) {
        self.enabled = input.enabled;
        self.web_search_enabled = input.web_search_enabled;

        let previous = std::mem::take(&mut self.providers);
        let mut next = Vec::with_capacity(input.providers.len());
        for provider_input in input.providers {
            let id = provider_input
                .id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .filter(|id| previous.iter().any(|provider| provider.id == *id))
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let existing = previous.iter().find(|provider| provider.id == id);
            let api_url = provider_input.api_url.trim().trim_end_matches('/').to_owned();
            let name = if provider_input.name.trim().is_empty() {
                provider_name_from_url(&api_url)
            } else {
                provider_input.name.trim().to_owned()
            };
            let api_key = match provider_input.api_key {
                Some(key) => key.trim().to_owned(),
                None => existing
                    .map(|provider| provider.api_key.clone())
                    .unwrap_or_default(),
            };
            next.push(BuiltinAiProvider {
                id,
                name,
                api_url,
                api_key,
                model: provider_input.model.trim().to_owned(),
            });
        }
        self.providers = next;

        self.active_provider_id = if self
            .providers
            .iter()
            .any(|provider| provider.id == input.active_provider_id)
        {
            input.active_provider_id
        } else {
            self.providers
                .first()
                .map(|provider| provider.id.clone())
                .unwrap_or_default()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_input(id: Option<&str>, name: &str, url: &str, key: Option<&str>, model: &str) -> BuiltinAiProviderInput {
        BuiltinAiProviderInput {
            id: id.map(str::to_owned),
            name: name.to_owned(),
            api_url: url.to_owned(),
            api_key: key.map(str::to_owned),
            model: model.to_owned(),
        }
    }

    #[test]
    fn round_trips_multiple_providers() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = BuiltinAiConfig::default();
        config.apply(BuiltinAiConfigInput {
            enabled: true,
            web_search_enabled: true,
            providers: vec![
                provider_input(None, "DeepSeek", "https://api.deepseek.com/", Some(" sk-ds "), "deepseek-chat"),
                provider_input(None, "OpenAI", "https://api.openai.com/v1", Some("sk-oa"), "gpt-4o"),
            ],
            active_provider_id: String::new(),
        });
        assert_eq!(config.providers.len(), 2);
        // Unknown active id falls back to the first provider.
        assert_eq!(config.active_provider_id, config.providers[0].id);
        config.active_provider_id = config.providers[1].id.clone();
        config.save(dir.path()).unwrap();
        config.save(dir.path()).unwrap();

        let loaded = BuiltinAiConfig::load(dir.path());
        assert!(loaded.enabled);
        assert!(loaded.web_search_enabled);
        assert_eq!(loaded.providers.len(), 2);
        assert_eq!(loaded.active_provider().unwrap().name, "OpenAI");
        assert_eq!(loaded.active_provider().unwrap().api_key, "sk-oa");
        assert_eq!(
            loaded.active_provider().unwrap().chat_endpoint(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert!(loaded.is_configured());
    }

    #[test]
    fn migrates_legacy_single_provider_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = BuiltinAiConfig::path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"enabled":true,"apiUrl":"https://api.deepseek.com","apiKey":"sk-old","model":"deepseek-chat","maxTotalTokens":42000}"#,
        )
        .unwrap();
        let config = BuiltinAiConfig::load(dir.path());
        assert_eq!(config.providers.len(), 1);
        let provider = config.active_provider().unwrap();
        assert_eq!(provider.api_url, "https://api.deepseek.com");
        assert_eq!(provider.api_key, "sk-old");
        assert_eq!(provider.model, "deepseek-chat");
        assert_eq!(provider.name, "api.deepseek.com");
        assert!(config.is_configured());
    }

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let config = BuiltinAiConfig::load(dir.path());
        assert!(!config.is_configured());
        assert!(config.providers.is_empty());
        assert!(config.view().providers.is_empty());
    }

    #[test]
    fn none_api_key_keeps_stored_value_for_existing_provider() {
        let mut config = BuiltinAiConfig::default();
        config.apply(BuiltinAiConfigInput {
            enabled: true,
            web_search_enabled: false,
            providers: vec![provider_input(None, "Keep", "https://x/v1", Some("keep-me"), "m")],
            active_provider_id: String::new(),
        });
        let id = config.providers[0].id.clone();
        // A second save with `api_key: None` must preserve the stored key.
        config.apply(BuiltinAiConfigInput {
            enabled: true,
            web_search_enabled: false,
            providers: vec![provider_input(Some(&id), "Keep", "https://x/v1", None, "m2")],
            active_provider_id: id,
        });
        let provider = config.active_provider().unwrap();
        assert_eq!(provider.api_key, "keep-me");
        assert_eq!(provider.model, "m2");
        assert_eq!(provider.chat_endpoint(), "https://x/v1/chat/completions");
    }

    #[test]
    fn active_provider_must_exist() {
        let mut config = BuiltinAiConfig::default();
        assert!(config.set_active_provider("missing").is_err());
    }
}

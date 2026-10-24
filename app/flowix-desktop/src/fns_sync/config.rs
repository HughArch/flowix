//! Global FNS credentials and preferences.
//!
//! One credential set can hold several tokens. Each notebook binds to exactly
//! one token (and one vault) through its own `.flowix/sync-state.json`, so the
//! token value never lives inside user data directories.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const BOOT_DIR: &str = "boot";
const FILE_NAME: &str = "fns-sync.json";

pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub const DEFAULT_CLIENT_TYPE: &str = "flowix";

/// One named credential. `client_type` belongs to the token because the server
/// binds the token's scope to a `c:` client dimension.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsToken {
    pub id: String,
    pub label: String,
    pub token: String,
    #[serde(default = "default_client_type")]
    pub client_type: String,
}

fn default_client_type() -> String {
    DEFAULT_CLIENT_TYPE.to_owned()
}

impl FnsToken {
    pub fn new(label: impl Into<String>, token: impl Into<String>, client_type: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            label: label.into(),
            token: token.into(),
            client_type: client_type.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FnsConfig {
    pub enabled: bool,
    pub api: String,
    /// Attachments larger than this are not synced. `0` disables attachment
    /// sync entirely.
    pub max_attachment_bytes: u64,
    pub tokens: Vec<FnsToken>,
    /// Pre-token-list configuration. Read once for migration, never written.
    #[serde(default, skip_serializing, rename = "token")]
    legacy_token: String,
    #[serde(default, skip_serializing, rename = "clientType")]
    legacy_client_type: String,
}

impl Default for FnsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api: String::new(),
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
            tokens: Vec::new(),
            legacy_token: String::new(),
            legacy_client_type: String::new(),
        }
    }
}

impl FnsConfig {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(BOOT_DIR).join(FILE_NAME)
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        let mut config = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!(path = %path.display(), "invalid FNS config: {error}");
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(path = %path.display(), "could not read FNS config: {error}");
                Self::default()
            }
        };
        config.migrate_legacy_token();
        config
    }

    /// Fold the pre-token-list shape into `tokens`.
    fn migrate_legacy_token(&mut self) {
        if !self.tokens.is_empty() || self.legacy_token.trim().is_empty() {
            return;
        }
        let client_type = if self.legacy_client_type.trim().is_empty() {
            DEFAULT_CLIENT_TYPE.to_owned()
        } else {
            self.legacy_client_type.clone()
        };
        self.tokens.push(FnsToken::new(
            "Default",
            self.legacy_token.trim(),
            client_type,
        ));
        self.legacy_token.clear();
        self.legacy_client_type.clear();
    }

    pub fn save(&self, config_dir: &Path) -> io::Result<()> {
        let path = Self::path(config_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(self)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The file holds bearer tokens.
            let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    /// Whether a notebook can attempt a sync at all.
    pub fn is_ready(&self) -> bool {
        self.enabled && !self.api.trim().is_empty() && !self.tokens.is_empty()
    }

    pub fn token(&self, token_id: &str) -> Option<&FnsToken> {
        if !token_id.is_empty() {
            return self.tokens.iter().find(|token| token.id == token_id);
        }
        // Backward compatibility: a single token is an unambiguous binding.
        if self.tokens.len() == 1 {
            return self.tokens.first();
        }
        None
    }

    /// Add a token or update the existing one. Returns the stored entry.
    pub fn upsert_token(
        &mut self,
        id: Option<&str>,
        label: &str,
        token: &str,
        client_type: &str,
    ) -> Option<FnsToken> {
        let label = label.trim();
        let token = token.trim();
        let client_type = if client_type.trim().is_empty() {
            DEFAULT_CLIENT_TYPE
        } else {
            client_type.trim()
        };

        if let Some(id) = id.filter(|id| !id.is_empty()) {
            let entry = self.tokens.iter_mut().find(|entry| entry.id == id)?;
            if !label.is_empty() {
                entry.label = label.to_owned();
            }
            // An empty token keeps the stored secret.
            if !token.is_empty() {
                entry.token = token.to_owned();
            }
            entry.client_type = client_type.to_owned();
            return Some(entry.clone());
        }

        if label.is_empty() || token.is_empty() {
            return None;
        }
        let entry = FnsToken::new(label, token, client_type);
        self.tokens.push(entry.clone());
        Some(entry)
    }

    pub fn remove_token(&mut self, id: &str) -> bool {
        let before = self.tokens.len();
        self.tokens.retain(|token| token.id != id);
        self.tokens.len() != before
    }

    pub fn offline_sync_strategy(&self) -> flowix_fns::OfflineSyncStrategy {
        flowix_fns::OfflineSyncStrategy::NewTimeMerge
    }
}

// ---------------------------------------------------------------------------
// Frontend views (never include token values)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsTokenView {
    pub id: String,
    pub label: String,
    pub client_type: String,
    pub has_token: bool,
}

impl From<&FnsToken> for FnsTokenView {
    fn from(token: &FnsToken) -> Self {
        Self {
            id: token.id.clone(),
            label: token.label.clone(),
            client_type: token.client_type.clone(),
            has_token: !token.token.trim().is_empty(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsConfigView {
    pub enabled: bool,
    pub api: String,
    pub max_attachment_bytes: u64,
    pub tokens: Vec<FnsTokenView>,
    pub configured: bool,
}

impl From<&FnsConfig> for FnsConfigView {
    fn from(config: &FnsConfig) -> Self {
        Self {
            enabled: config.enabled,
            api: config.api.clone(),
            max_attachment_bytes: config.max_attachment_bytes,
            tokens: config.tokens.iter().map(FnsTokenView::from).collect(),
            configured: config.is_ready(),
        }
    }
}

/// Global settings patch. Token editing has its own commands.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsConfigPatch {
    pub enabled: Option<bool>,
    pub api: Option<String>,
    pub max_attachment_bytes: Option<u64>,
}

impl FnsConfig {
    pub fn apply(&mut self, patch: FnsConfigPatch) {
        if let Some(enabled) = patch.enabled {
            self.enabled = enabled;
        }
        if let Some(api) = patch.api {
            self.api = api.trim().trim_end_matches('/').to_owned();
        }
        if let Some(bytes) = patch.max_attachment_bytes {
            self.max_attachment_bytes = bytes;
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsTokenInput {
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub token: String,
    pub client_type: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_single_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = FnsConfig::path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"enabled":true,"api":"https://example.com","token":"secret","clientType":"obsidianPlugin"}"#,
        )
        .unwrap();

        let config = FnsConfig::load(dir.path());
        assert_eq!(config.tokens.len(), 1);
        assert_eq!(config.tokens[0].token, "secret");
        assert_eq!(config.tokens[0].client_type, "obsidianPlugin");
    }

    #[test]
    fn single_token_is_an_implicit_binding() {
        let mut config = FnsConfig::default();
        config.tokens.push(FnsToken::new("a", "secret", "flowix"));
        assert!(config.token("").is_some());
        config.tokens.push(FnsToken::new("b", "secret2", "flowix"));
        assert!(config.token("").is_none());
    }

    #[test]
    fn upsert_keeps_existing_secret_when_blank() {
        let mut config = FnsConfig::default();
        let token = config.upsert_token(None, "work", "secret", "flowix").unwrap();
        let updated = config
            .upsert_token(Some(&token.id), "work 2", "", "obsidianPlugin")
            .unwrap();
        assert_eq!(updated.token, "secret");
        assert_eq!(updated.label, "work 2");
        assert_eq!(updated.client_type, "obsidianPlugin");
    }

    #[test]
    fn views_hide_token_values() {
        let mut config = FnsConfig::default();
        config.tokens.push(FnsToken::new("a", "secret-value", "flowix"));
        let view = FnsConfigView::from(&config);
        assert!(!serde_json::to_string(&view).unwrap().contains("secret-value"));
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = FnsConfig::default();
        config.api = "https://example.com".into();
        config.tokens.push(FnsToken::new("a", "secret", "flowix"));
        config.save(dir.path()).unwrap();
        let loaded = FnsConfig::load(dir.path());
        assert_eq!(loaded.api, config.api);
        assert_eq!(loaded.tokens.len(), 1);
        assert_eq!(loaded.tokens[0].token, "secret");
    }
}

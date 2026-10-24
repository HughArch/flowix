//! Global FNS credentials and preferences.
//!
//! One credential set serves every notebook; each notebook binds to its own
//! vault through `.flowix/sync-state.json`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const BOOT_DIR: &str = "boot";
const FILE_NAME: &str = "fns-sync.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FnsConfig {
    pub enabled: bool,
    pub api: String,
    /// Bearer token. Never returned to the frontend in clear text.
    pub token: String,
    pub client_name: String,
    pub client_version: String,
    /// Must match the `c:` dimension bound to the token on the server.
    pub client_type: String,
    /// Attachments larger than this are not synced. `0` disables attachment
    /// sync entirely.
    pub max_attachment_bytes: u64,
}

pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

impl Default for FnsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api: String::new(),
            token: String::new(),
            client_name: "Flowix".to_owned(),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
            client_type: "flowix".to_owned(),
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        }
    }
}

impl FnsConfig {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(BOOT_DIR).join(FILE_NAME)
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!(path = %path.display(), "invalid FNS config: {error}");
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(path = %path.display(), "could not read FNS config: {error}");
                Self::default()
            }
        }
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
            // The file holds a bearer token.
            let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    /// Whether the config carries enough information to attempt a sync.
    pub fn is_ready(&self) -> bool {
        self.enabled && !self.api.trim().is_empty() && !self.token.trim().is_empty()
    }

    pub fn offline_sync_strategy(&self) -> flowix_fns::OfflineSyncStrategy {
        flowix_fns::OfflineSyncStrategy::NewTimeMerge
    }
}

/// Frontend-facing view; intentionally omits the token value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsConfigView {
    pub enabled: bool,
    pub api: String,
    pub has_token: bool,
    pub client_name: String,
    pub client_version: String,
    pub client_type: String,
    pub max_attachment_bytes: u64,
    pub configured: bool,
}

impl From<&FnsConfig> for FnsConfigView {
    fn from(config: &FnsConfig) -> Self {
        Self {
            enabled: config.enabled,
            api: config.api.clone(),
            has_token: !config.token.trim().is_empty(),
            client_name: config.client_name.clone(),
            client_version: config.client_version.clone(),
            client_type: config.client_type.clone(),
            max_attachment_bytes: config.max_attachment_bytes,
            configured: config.is_ready(),
        }
    }
}

/// Patch accepted from the frontend. An empty token keeps the stored one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsConfigPatch {
    pub enabled: Option<bool>,
    pub api: Option<String>,
    pub token: Option<String>,
    pub client_name: Option<String>,
    pub client_type: Option<String>,
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
        if let Some(token) = patch.token {
            let token = token.trim();
            if !token.is_empty() {
                self.token = token.to_owned();
            }
        }
        if let Some(name) = patch.client_name {
            if !name.trim().is_empty() {
                self.client_name = name.trim().to_owned();
            }
        }
        if let Some(client_type) = patch.client_type {
            if !client_type.trim().is_empty() {
                self.client_type = client_type.trim().to_owned();
            }
        }
        if let Some(bytes) = patch.max_attachment_bytes {
            self.max_attachment_bytes = bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_keeps_existing_token_when_blank() {
        let mut config = FnsConfig::default();
        config.token = "existing".into();
        config.apply(FnsConfigPatch {
            enabled: Some(true),
            api: Some("https://example.com/".into()),
            token: Some("   ".into()),
            client_name: None,
            client_type: None,
            max_attachment_bytes: None,
        });
        assert_eq!(config.token, "existing");
        assert_eq!(config.api, "https://example.com");
        assert!(config.enabled);
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = FnsConfig::default();
        config.api = "https://example.com".into();
        config.token = "secret".into();
        config.save(dir.path()).unwrap();
        let loaded = FnsConfig::load(dir.path());
        assert_eq!(loaded.api, config.api);
        assert_eq!(loaded.token, config.token);
    }

    #[test]
    fn view_hides_token() {
        let mut config = FnsConfig::default();
        config.token = "secret".into();
        let view = FnsConfigView::from(&config);
        assert!(view.has_token);
        assert!(!serde_json::to_string(&view).unwrap().contains("secret"));
    }
}

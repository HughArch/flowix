//! One-time removal of the retired Flowix Cloud Pi provider.
//!
//! Only the Cloud-managed provider is removed. User BYOK providers, their
//! credentials, and unrelated settings are preserved. Every step is
//! best-effort and idempotent: a missing file is skipped, malformed JSON is
//! left untouched, and symlinks are never followed.

use serde_json::{Map, Value};
use std::path::Path;

use super::config::{read_json, write_json};
use super::runtime::pi_config_dir;

pub(crate) fn purge_legacy_cloud_providers() {
    let dir = match pi_config_dir() {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!("legacy Pi cloud cleanup skipped: {error}");
            return;
        }
    };
    purge_in(&dir);
}

pub(super) fn purge_in(dir: &Path) {
    let settings_path = dir.join("settings.json");
    let models_path = dir.join("models.json");
    let auth_path = dir.join("auth.json");

    let cloud_provider_id = if settings_path.is_file() {
        let settings = match read_json(&settings_path) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!("legacy Pi cloud settings skipped: {error}");
                return;
            }
        };
        let marked = settings
            .get("flowixCloudProviderId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let changed = purge_settings(&settings_path, settings, marked.as_deref());
        if changed {
            tracing::info!("removed legacy Flowix Cloud Pi provider settings");
        }
        marked
    } else {
        None
    };

    if models_path.is_file() {
        if let Ok(mut models) = read_json(&models_path) {
            let removed = purge_models(&mut models, cloud_provider_id.as_deref());
            if removed > 0 {
                if let Err(error) = write_json(&models_path, &models) {
                    tracing::warn!("legacy Pi cloud model cleanup failed: {error}");
                } else {
                    tracing::info!(removed, "removed legacy Flowix Cloud Pi providers");
                }
            }
        }
    }

    if auth_path.is_file() {
        if let Ok(mut auth) = read_json(&auth_path) {
            if let Some(entries) = auth.as_object_mut() {
                let removed = remove_cloud_entries(entries, cloud_provider_id.as_deref());
                if removed > 0 {
                    if let Err(error) = write_json(&auth_path, &auth) {
                        tracing::warn!("legacy Pi cloud credential cleanup failed: {error}");
                    }
                }
            }
        }
    }
}

fn purge_settings(path: &Path, mut settings: Value, marked: Option<&str>) -> bool {
    let Some(object) = settings.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if object.remove("flowixCloudProviderId").is_some() {
        changed = true;
    }
    if object.remove("flowixPiCatalog").is_some() {
        changed = true;
    }
    let default_is_cloud = object
        .get("defaultProvider")
        .and_then(Value::as_str)
        .is_some_and(|id| is_cloud_provider(id, marked));
    if default_is_cloud {
        object.remove("defaultProvider");
        object.remove("defaultModel");
        changed = true;
    }
    if changed {
        if let Err(error) = write_json(path, &settings) {
            tracing::warn!("legacy Pi cloud settings write failed: {error}");
        }
    }
    changed
}

fn purge_models(models: &mut Value, marked: Option<&str>) -> usize {
    let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) else {
        return 0;
    };
    remove_cloud_entries(providers, marked)
}

fn remove_cloud_entries(entries: &mut Map<String, Value>, marked: Option<&str>) -> usize {
    let ids: Vec<String> = entries
        .iter()
        .filter(|(id, value)| is_cloud_provider(id, marked) || looks_like_cloud_provider(value))
        .map(|(id, _)| id.clone())
        .collect();
    let removed = ids.len();
    for id in ids {
        entries.remove(&id);
    }
    removed
}

fn is_cloud_provider(id: &str, marked: Option<&str>) -> bool {
    id == "flowix-cloud"
        || id.starts_with("flowix-cloud-")
        || marked == Some(id)
}

fn looks_like_cloud_provider(value: &Value) -> bool {
    value.get("name").and_then(Value::as_str) == Some("Flowix Cloud")
        && value
            .get("baseUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| url.trim_end_matches('/').ends_with("/v1/ai"))
}

#[cfg(test)]
mod tests {
    use super::purge_in;
    use serde_json::json;
    use std::fs;

    #[test]
    fn removes_only_cloud_providers_and_keeps_byok() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&json!({
                "defaultProvider": "flowix-cloud-member",
                "defaultModel": "member-model",
                "flowixCloudProviderId": "flowix-cloud-member",
                "flowixPiCatalog": { "flowix-cloud-member": {} },
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.path().join("models.json"),
            serde_json::to_vec(&json!({
                "providers": {
                    "flowix-cloud-member": {
                        "name": "Flowix Cloud",
                        "baseUrl": "https://cloud.example/v1/ai",
                        "models": [{ "id": "member-model" }]
                    },
                    "byok": {
                        "name": "BYOK",
                        "baseUrl": "https://api.example/v1",
                        "models": [{ "id": "model-a" }]
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.path().join("auth.json"),
            serde_json::to_vec(&json!({
                "flowix-cloud-member": { "type": "api_key", "key": "fai_x" },
                "byok": { "type": "api_key", "key": "sk-x" }
            }))
            .unwrap(),
        )
        .unwrap();

        purge_in(dir.path());

        let models: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("models.json")).unwrap()).unwrap();
        assert!(models["providers"].get("flowix-cloud-member").is_none());
        assert!(models["providers"].get("byok").is_some());

        let auth: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("auth.json")).unwrap()).unwrap();
        assert!(auth.get("flowix-cloud-member").is_none());
        assert!(auth.get("byok").is_some());

        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
        assert!(settings.get("flowixCloudProviderId").is_none());
        assert!(settings.get("flowixPiCatalog").is_none());
        assert!(settings.get("defaultProvider").is_none());
        assert!(settings.get("defaultModel").is_none());
    }

    #[test]
    fn ignores_missing_files_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        purge_in(dir.path());
        purge_in(dir.path());
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn leaves_malformed_json_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        fs::write(&path, b"{ not json").unwrap();
        purge_in(dir.path());
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }
}

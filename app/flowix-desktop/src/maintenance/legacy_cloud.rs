//! One-time removal of artifacts left behind by the retired Flowix Cloud
//! account/sync subsystem.
//!
//! Only Cloud-owned state is removed. Local AI configuration, FNS bindings,
//! notebook archives and every other database are left untouched. All steps
//! are best-effort: a missing file is skipped and errors never block startup.

use std::path::{Path, PathBuf};

use flowix_core::secret::{entry_name, SecretStore};

const CLOUD_SECRET_PROVIDERS: &[&str] = &[
    "flowix_cloud_refresh",
    "flowix_cloud_dev_staging_refresh",
    "flowix_cloud_dev_production_refresh",
];
const SECRET_ACCOUNT: &str = "default";

pub(crate) fn purge_legacy_cloud_data(user_config_dir: &Path) {
    purge_sync_databases(user_config_dir);
    purge_refresh_tokens(user_config_dir);
    crate::agent_external::pi::purge_legacy_cloud_providers();
}

fn purge_sync_databases(config_dir: &Path) {
    let db_dir = config_dir.join("db");
    let mut targets = vec![config_dir.join("sync.db"), db_dir.join("sync.db")];

    match std::fs::read_dir(&db_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("sync-dev-") && name.ends_with(".db") {
                    targets.push(entry.path());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "legacy cloud database scan failed"),
    }

    for target in targets {
        remove_sqlite_files(&target);
    }
}

fn remove_sqlite_files(base: &Path) {
    match std::fs::symlink_metadata(base) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            tracing::warn!(path = %base.display(), "skipping legacy sync database symlink");
            return;
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            tracing::warn!(path = %base.display(), "skipping non-file legacy sync database");
            return;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(path = %base.display(), %error, "cannot inspect legacy sync database");
            return;
        }
    }

    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = base.as_os_str().to_os_string();
        name.push(suffix);
        let path = PathBuf::from(name);
        match std::fs::remove_file(&path) {
            Ok(()) => tracing::info!(path = %path.display(), "removed legacy cloud database file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "legacy cloud database removal failed")
            }
        }
    }
}

fn purge_refresh_tokens(config_dir: &Path) {
    let db_path = config_dir.join("db").join("default.db");
    match std::fs::symlink_metadata(&db_path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {}
        _ => return,
    }
    let store = SecretStore::new(&db_path);
    for provider in CLOUD_SECRET_PROVIDERS {
        let entry = entry_name(provider, SECRET_ACCOUNT);
        match store.delete(&entry) {
            Ok(true) => tracing::info!(provider, "removed legacy cloud refresh token"),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(provider, %error, "legacy cloud refresh token removal failed")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::purge_legacy_cloud_data;
    use flowix_core::secret::{entry_name, SecretStore};
    use std::fs;

    #[test]
    fn removes_only_cloud_sync_databases() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        fs::create_dir_all(&db).unwrap();
        for name in [
            "sync.db",
            "sync-dev-prod.db",
            "sync-dev-staging.db",
            "local.db",
            "thread.db",
            "default.db",
        ] {
            fs::write(db.join(name), b"fixture").unwrap();
        }
        fs::write(dir.path().join("sync.db"), b"fixture").unwrap();
        fs::write(db.join("sync.db-wal"), b"fixture").unwrap();

        purge_legacy_cloud_data(dir.path());

        assert!(!dir.path().join("sync.db").exists());
        assert!(!db.join("sync.db").exists());
        assert!(!db.join("sync.db-wal").exists());
        assert!(!db.join("sync-dev-prod.db").exists());
        assert!(!db.join("sync-dev-staging.db").exists());
        assert!(db.join("local.db").exists());
        assert!(db.join("thread.db").exists());
        assert!(db.join("default.db").exists());
    }

    #[test]
    fn removes_cloud_secrets_only() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        fs::create_dir_all(&db).unwrap();
        let db_path = db.join("default.db");
        let store = SecretStore::new(&db_path);
        store
            .save(&entry_name("flowix_cloud_refresh", "default"), "cloud-token")
            .unwrap();
        store
            .save(&entry_name("byok_provider", "default"), "user-secret")
            .unwrap();

        purge_legacy_cloud_data(dir.path());

        let store = SecretStore::new(&db_path);
        assert!(!store.exists(&entry_name("flowix_cloud_refresh", "default")));
        assert!(store.exists(&entry_name("byok_provider", "default")));
    }

    #[test]
    fn missing_directories_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        purge_legacy_cloud_data(dir.path());
        purge_legacy_cloud_data(dir.path());
        assert!(!dir.path().join("db").join("default.db").exists());
    }
}

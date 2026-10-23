//! Small startup helpers for recreatable application storage.
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
};

/// Preserve a database and all its SQLite companions in one backup directory.
/// No replacement is attempted unless every existing component was preserved.
pub fn backup_database(path: &Path) -> io::Result<Option<PathBuf>> {
    backup_files(path, &["", "-wal", "-shm", "-journal"])
}

pub fn backup_storage_file(path: &Path) -> io::Result<Option<PathBuf>> {
    backup_files(path, &[""])
}

fn backup_files(path: &Path, suffixes: &[&str]) -> io::Result<Option<PathBuf>> {
    let mut sources = Vec::new();
    for suffix in suffixes {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let source = PathBuf::from(name);
        match fs::symlink_metadata(&source) {
            Ok(_) => sources.push(source),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if sources.is_empty() {
        return Ok(None);
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("storage path has no parent"))?;
    let backup = parent
        .join("rebuild-backups")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&backup)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for source in sources {
        let target = backup.join(source.file_name().unwrap());
        if let Err(error) = fs::rename(&source, &target) {
            for (source, target) in moved.iter().rev() {
                if let Err(rollback) = fs::rename(target, source) {
                    return Err(io::Error::other(format!(
                        "backup failed: {error}; rollback failed: {rollback}; preserved files: {}",
                        backup.display()
                    )));
                }
            }
            return Err(error);
        }
        moved.push((source, target));
    }
    tracing::warn!(path = %path.display(), backup = %backup.display(), "preserved abnormal application storage before rebuilding");
    Ok(Some(backup))
}

/// Busy, permission, disk-full and I/O errors must never move a live database.
pub fn is_rebuildable_storage_error(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(sqlite) = error.downcast_ref::<rusqlite::Error>() {
            return match sqlite {
                rusqlite::Error::SqlInputError { msg, .. } => [
                    "no such table",
                    "no such column",
                    "has no column",
                    "malformed",
                ]
                .iter()
                .any(|part| msg.contains(part)),
                rusqlite::Error::SqliteFailure(code, Some(message))
                    if code.code == rusqlite::ErrorCode::Unknown =>
                {
                    [
                        "no such table",
                        "no such column",
                        "has no column",
                        "malformed",
                    ]
                    .iter()
                    .any(|part| message.contains(part))
                }
                rusqlite::Error::SqliteFailure(code, _) => matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseCorrupt
                        | rusqlite::ErrorCode::NotADatabase
                        | rusqlite::ErrorCode::SchemaChanged
                ),
                rusqlite::Error::InvalidColumnName(_)
                | rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::FromSqlConversionFailure(..) => true,
                _ => false,
            };
        }
        if let Some(io) = error.downcast_ref::<io::Error>() {
            if io.kind() == io::ErrorKind::InvalidData {
                return true;
            }
            if let Some(inner) = io.get_ref() {
                current = Some(inner);
                continue;
            }
        }
        current = error.source();
    }
    false
}

/// The operation must release its connections before returning an error.
pub fn with_database_rebuild<T>(
    path: &Path,
    mut initialize: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    // Serialize initialization and repair across processes. Ordinary database
    // access must not call this helper or rename storage held by other readers.
    if let Some(parent) = path.parent() {
        ensure_storage_directory(parent)?;
    }
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".rebuild.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(PathBuf::from(lock_path))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            backup_database(path)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            backup_database(path)?;
        }
        _ => {}
    }
    match initialize() {
        Ok(value) => Ok(value),
        Err(error) if is_rebuildable_storage_error(&error) => {
            tracing::warn!(%error, path = %path.display(), "recreating abnormal application database");
            backup_database(path)?;
            initialize()
        }
        Err(error) => Err(error),
    }
}

pub fn ensure_storage_directory(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() && !path.is_dir() {
        backup_storage_file(path)?;
    }
    fs::create_dir_all(path)
}

/// JSON owned by the application: preserve malformed input, then persist defaults.
pub fn read_or_create_json<T>(path: &Path, default: impl FnOnce() -> T) -> io::Result<T>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    if let Some(parent) = path.parent() {
        ensure_storage_directory(parent)?;
    }
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => return Ok(value),
            Err(_) => {
                backup_storage_file(path)?;
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) if error.kind() == io::ErrorKind::IsADirectory => {
            backup_storage_file(path)?;
        }
        Err(error) => return Err(error),
    }
    let value = default();
    let bytes = serde_json::to_vec_pretty(&value).map_err(io::Error::other)?;
    super::atomic_write_bytes(path, &bytes)?;
    Ok(value)
}

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;
    use crate::memo_file::{prepare_database_directory, MemoFile, NotebookConfig};

    #[test]
    fn preserves_complete_sqlite_group() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            fs::write(
                temp.path().join(format!("local.db{suffix}")),
                suffix.as_bytes(),
            )
            .unwrap();
        }
        let backup = backup_database(&path).unwrap().unwrap();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            assert_eq!(
                fs::read(backup.join(format!("local.db{suffix}"))).unwrap(),
                suffix.as_bytes()
            );
            assert!(!temp.path().join(format!("local.db{suffix}")).exists());
        }
    }

    #[test]
    fn canonical_database_does_not_receive_legacy_wal() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        fs::write(temp.path().join("local.db"), b"legacy").unwrap();
        fs::write(temp.path().join("local.db-wal"), b"legacy wal").unwrap();
        fs::write(temp.path().join("db/local.db"), b"canonical").unwrap();
        prepare_database_directory(temp.path(), &["local.db"]).unwrap();
        assert_eq!(
            fs::read(temp.path().join("db/local.db")).unwrap(),
            b"canonical"
        );
        assert!(!temp.path().join("db/local.db-wal").exists());
        assert_eq!(
            fs::read(temp.path().join("local.db-wal")).unwrap(),
            b"legacy wal"
        );
    }

    #[test]
    fn invalid_registry_is_never_replaced_with_an_empty_database() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        fs::write(&path, b"broken registry").unwrap();
        fs::write(temp.path().join("local.db"), b"legacy input").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        for _ in 0..2 {
            assert!(memo.initialize_registry_storage().is_err());
            assert_eq!(fs::read(&path).unwrap(), b"broken registry");
            assert_eq!(
                fs::read(temp.path().join("local.db")).unwrap(),
                b"legacy input"
            );
            assert!(!temp.path().join("db/rebuild-backups").exists());
        }
    }

    #[test]
    fn malformed_registry_schema_rolls_back_without_losing_rows() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks(id TEXT); INSERT INTO notebooks VALUES ('keep');",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_registry_storage().is_err());
        let conn = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT id FROM notebooks", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        let columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "partially added columns must roll back");
        assert!(!path.parent().unwrap().join("rebuild-backups").exists());
    }

    #[test]
    fn missing_previously_initialized_registry_is_not_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        fs::remove_dir_all(temp.path().join("db")).unwrap();
        assert!(memo.initialize_current_registry_storage().is_err());
        assert!(!memo.registry_db_path().exists());
    }

    #[test]
    fn legacy_registry_snapshot_preserves_wal_and_target_wins_on_retry() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("local.db");
        let conn = rusqlite::Connection::open(&legacy).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, path TEXT UNIQUE NOT NULL,
            is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO notebooks VALUES ('keep', 'Original', 'icon', '/offline/notes', 1, 123, 456);").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        assert!(legacy.exists());
        assert!(temp.path().join("local.db-wal").exists());
        let rows = memo.read_notebook_configs().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "keep");
        assert_eq!(rows[0].path, "/offline/notes");
        assert_eq!(rows[0].icon.as_deref(), Some("icon"));
        assert_eq!(rows[0].created_at, 123);
        conn.execute("UPDATE notebooks SET name='stale source'", [])
            .unwrap();
        memo.initialize_registry_storage().unwrap();
        assert_eq!(memo.read_notebook_configs().unwrap()[0].name, "Original");
        fs::remove_file(memo.registry_db_path()).unwrap();
        assert!(
            memo.initialize_registry_storage().is_err(),
            "do not restore a stale legacy registry over a lost initialized target"
        );
        assert!(!memo.registry_db_path().exists());
        assert!(legacy.exists());
    }

    #[test]
    fn migration_rejects_changes_to_existing_notebook_fields() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT, icon TEXT, path TEXT,
            is_default INTEGER, created_at INTEGER, updated_at INTEGER);
            INSERT INTO notebooks VALUES ('keep','Original',NULL,'/offline',1,123,456);
            CREATE TRIGGER unexpected_migration_effect AFTER UPDATE ON notebooks BEGIN
                UPDATE notebooks SET name='unexpected change' WHERE id=NEW.id;
            END;",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        let error = memo.initialize_current_registry_storage().unwrap_err();
        assert!(error.to_string().contains("changed existing registry data"));
        let conn = rusqlite::Connection::open(path).unwrap();
        assert_eq!(
            conn.query_row("SELECT name FROM notebooks", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks') WHERE name='sort'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(temp.path().join("db/registry-backups").is_dir());
    }

    #[test]
    fn broken_optional_setup_table_does_not_replace_notebook_registry() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        let conn = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        conn.execute_batch(
            "INSERT INTO notebooks (id,name,path,is_default,sort,pinned,created_at,updated_at)
            VALUES ('keep','Name','/offline',1,30,1,123,456);
            DROP TABLE notebook_setup_jobs;
            CREATE TABLE notebook_setup_jobs (notebook_id TEXT);",
        )
        .unwrap();
        drop(conn);
        for _ in 0..2 {
            memo.initialize_current_registry_storage().unwrap();
            let rows = memo.read_notebook_configs().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, "keep");
            assert_eq!(rows[0].path, "/offline");
            assert_eq!(rows[0].sort, 30);
            assert!(memo.read_notebook_pin_states().unwrap().contains("keep"));
        }
    }

    #[test]
    fn repeated_optional_upgrade_failure_reuses_a_validated_registry_backup() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        let conn = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        conn.execute_batch(
            "INSERT INTO notebooks (id,name,path,is_default,sort,pinned,created_at,updated_at)
            VALUES ('keep','Original','/offline',1,30,1,123,456);
            DROP TABLE notebook_setup_jobs; CREATE TABLE notebook_setup_jobs(notebook_id TEXT);",
        )
        .unwrap();
        for _ in 0..3 {
            memo.initialize_current_registry_storage().unwrap();
        }
        let backups = temp.path().join("db/registry-backups");
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 1);
        // A changed identity state requires a separate preserved snapshot.
        conn.execute("UPDATE notebooks SET name='Changed'", [])
            .unwrap();
        memo.initialize_current_registry_storage().unwrap();
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 2);
        assert_eq!(memo.read_notebook_configs().unwrap()[0].name, "Changed");
    }

    #[test]
    fn unavailable_optional_backup_does_not_block_registry_access() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        let conn = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        conn.execute_batch(
            "INSERT INTO notebooks (id,name,path,is_default,sort,pinned,created_at,updated_at)
            VALUES ('keep','Original','/offline',1,30,1,123,456);
            DROP TABLE notebook_setup_jobs; CREATE TABLE notebook_setup_jobs(notebook_id TEXT);",
        )
        .unwrap();
        fs::write(
            temp.path().join("db/registry-backups"),
            b"blocked backup directory",
        )
        .unwrap();
        memo.initialize_current_registry_storage().unwrap();
        assert_eq!(memo.read_notebook_configs().unwrap()[0].id, "keep");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebook_setup_jobs')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn unavailable_backup_blocks_core_schema_changes_without_modifying_notebooks() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        let conn = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY,name TEXT,icon TEXT,path TEXT,
            is_default INTEGER,created_at INTEGER,updated_at INTEGER);
            INSERT INTO notebooks VALUES ('keep','Original',NULL,'/offline',1,123,456);",
        )
        .unwrap();
        fs::write(
            temp.path().join("db/registry-backups"),
            b"blocked backup directory",
        )
        .unwrap();
        assert!(memo.initialize_current_registry_storage().is_err());
        assert_eq!(
            conn.query_row("SELECT name FROM notebooks", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks') WHERE name='sort'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn unrelated_existing_database_is_not_initialized_as_an_empty_registry() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('keep');",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_current_registry_storage().is_err());
        let conn = rusqlite::Connection::open(path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='notebooks'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT value FROM retained", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    #[test]
    fn corrupt_legacy_registry_and_orphan_wal_require_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("local.db");
        fs::write(&legacy, b"broken source").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_registry_storage().is_err());
        assert_eq!(fs::read(&legacy).unwrap(), b"broken source");
        assert!(!memo.registry_db_path().exists());
        fs::remove_file(&legacy).unwrap();
        fs::write(temp.path().join("db/local.db-wal"), b"preserve wal").unwrap();
        assert!(memo.initialize_registry_storage().is_err());
        assert_eq!(
            fs::read(temp.path().join("db/local.db-wal")).unwrap(),
            b"preserve wal"
        );
        assert!(!memo.registry_db_path().exists());
    }

    #[test]
    fn malformed_json_is_preserved_and_defaults_are_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("preference.json");
        fs::write(&path, b"{broken").unwrap();
        let value: serde_json::Value =
            read_or_create_json(&path, || serde_json::json!({"language":"zh-CN"})).unwrap();
        assert_eq!(value["language"], "zh-CN");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            value
        );
        assert!(temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn busy_database_is_not_moved_or_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        fs::write(&path, b"keep").unwrap();
        let result: io::Result<()> = with_database_rebuild(&path, || {
            Err(io::Error::other(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            )))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        assert!(!temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn notebook_database_rebuild_keeps_markdown_and_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join(".flowix")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("kept.md"), b"# Keep this note\n").unwrap();
        fs::write(root.join("attachments/kept.bin"), b"attachment").unwrap();
        fs::write(
            root.join(".flowix/notebook.db"),
            b"invalid notebook database",
        )
        .unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.write_notebook_configs(&[NotebookConfig {
            id: "nb_kept".into(),
            name: "Kept".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: false,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        // Database repair runs during schema initialization before indexing.
        memo.initialize_note_index_schema("nb_kept").unwrap();
        memo.reconcile_note_index_blocking("nb_kept").unwrap();
        assert_eq!(
            fs::read(root.join("kept.md")).unwrap(),
            b"# Keep this note\n"
        );
        assert_eq!(
            fs::read(root.join("attachments/kept.bin")).unwrap(),
            b"attachment"
        );
        assert!(root.join(".flowix/rebuild-backups").exists());
    }
}

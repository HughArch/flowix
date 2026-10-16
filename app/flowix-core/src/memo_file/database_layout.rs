//! User-level SQLite database layout helpers.
//!
//! Databases used to live directly under `~/.flowix/`. They now live under
//! `~/.flowix/db/`. Publish a complete SQLite snapshot under a layout lock;
//! interruption leaves the original database and its WAL together for retry.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use fs2::FileExt;

pub const DATABASE_DIRECTORY_NAME: &str = "db";

/// Create `db/` and snapshot existing named databases from the config root.
/// The source is retained with its sidecars. An existing canonical database
/// wins, leaving the complete legacy copy untouched.
pub fn prepare_database_directory(
    config_dir: &Path,
    database_names: &[&str],
) -> io::Result<PathBuf> {
    super::ensure_storage_directory(config_dir)?;
    let lock_path = config_dir.join(".database-layout.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        super::backup_storage_file(&lock_path)?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)?;
    FileExt::lock_exclusive(&lock)?;

    let result = (|| {
        let database_dir = config_dir.join(DATABASE_DIRECTORY_NAME);
        super::ensure_storage_directory(&database_dir)?;
        for name in database_names {
            validate_database_name(name)?;
            move_database_with_sidecars(config_dir, &database_dir, name)?;
        }
        Ok(database_dir)
    })();

    let unlock_result = FileExt::unlock(&lock);
    match (result, unlock_result) {
        (Ok(path), Ok(())) => Ok(path),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn validate_database_name(name: &str) -> io::Result<()> {
    let path = Path::new(name);
    if name.is_empty()
        || path.components().count() != 1
        || !path.file_name().is_some_and(|n| n == name)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid database filename: {name}"),
        ));
    }
    Ok(())
}

fn move_database_with_sidecars(root: &Path, database_dir: &Path, name: &str) -> io::Result<()> {
    let source = root.join(name);
    let destination = database_dir.join(name);

    // The canonical database wins as a complete group. Never attach sidecars
    // from an older copy, even when the two main files happen to be identical.
    if fs::symlink_metadata(&destination).is_ok() {
        return Ok(());
    }
    // Orphan WAL files cannot belong to a new main database.
    super::backup_database(&destination)?;
    if !source.is_file() {
        return Ok(());
    }
    // VACUUM INTO includes committed WAL contents in a standalone database.
    // Only publish after SQLite has closed the snapshot. Never split the
    // source main file from its WAL, even if the process exits mid-migration.
    let temporary = database_dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let snapshot = (|| -> io::Result<()> {
        let conn = rusqlite::Connection::open_with_flags(
            &source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).map_err(io::Error::other)?;
        conn.execute("VACUUM INTO ?1", [temporary.to_string_lossy().as_ref()])
            .map_err(io::Error::other)?;
        drop(conn);
        fs::File::open(&temporary)?.sync_all()?;
        fs::rename(&temporary, &destination)
    })();
    if let Err(error) = snapshot {
        let _ = fs::remove_file(&temporary);
        if super::is_rebuildable_storage_error(&error) {
            super::backup_database(&source)?;
            return Ok(()); // The normal initializer creates an empty canonical DB.
        }
        return Err(error);
    }
    Ok(())
}

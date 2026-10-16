use super::*;

impl SyncStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SyncError> {
        let store = Self::new_uninitialized(path);
        store.initialize_schema()?;
        Ok(store)
    }

    pub fn new_uninitialized(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn initialize_schema(&self) -> Result<(), SyncError> {
        flowix_core::memo_file::with_database_rebuild(&self.path, || {
            let connection = self.open().map_err(std::io::Error::other)?;
            Self::initialize_v2_schema(&connection).map_err(std::io::Error::other)?;
            connection
                .query_row(
                    "SELECT blocked FROM session_restore_policy WHERE singleton=1",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .map_err(|error| SyncError::InvalidState(format!("initialize sync database: {error}")))
    }

    pub(super) fn open(&self) -> Result<Connection, SyncError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                SyncError::InvalidState(format!("create sync directory: {error}"))
            })?;
        }
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(connection)
    }
}

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;

    #[test]
    fn invalid_sync_database_is_backed_up_and_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        std::fs::write(&path, b"invalid sync database").unwrap();
        let store = SyncStore::new(&path).unwrap();
        assert!(!store.session_restore_blocked().unwrap());
        assert!(temp.path().join("rebuild-backups").exists());
    }
}

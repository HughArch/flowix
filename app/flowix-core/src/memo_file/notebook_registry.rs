//! Device-local notebook registry database and its process-local cache.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use super::notebook::sqlite_to_io;
use super::types::NotebookConfig;

pub(super) struct NotebookRegistry {
    pub(super) config_dir: PathBuf,
    pub(super) configs_cache: std::sync::RwLock<Option<Vec<NotebookConfig>>>,
}

impl NotebookRegistry {
    pub(super) fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            configs_cache: std::sync::RwLock::new(None),
        }
    }

    pub(super) fn db_path(&self) -> PathBuf {
        self.config_dir.join("db").join("local.db")
    }

    pub(super) fn open(&self) -> std::io::Result<Connection> {
        self.open_with_legacy_migrations(false)
    }

    pub(super) fn open_for_initialization(&self) -> std::io::Result<Connection> {
        self.open_with_legacy_migrations(true)
    }

    fn open_with_legacy_migrations(
        &self,
        run_legacy_migrations: bool,
    ) -> std::io::Result<Connection> {
        if let Some(parent) = self.db_path().parent() {
            fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(self.db_path()).map_err(sqlite_to_io)?;
        conn.busy_timeout(Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        let notebooks_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='notebooks')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        let has_sort_column = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "sort");
        let has_pinned_column = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "pinned");
        if notebooks_table_exists && !has_sort_column && !run_legacy_migrations {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "notebook registry requires version initialization",
            ));
        }
        if notebooks_table_exists && !has_sort_column {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS notebooks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    icon TEXT,
                    path TEXT NOT NULL UNIQUE,
                    is_default INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(sqlite_to_io)?;
            conn.execute_batch("ALTER TABLE notebooks ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;")
            .map_err(sqlite_to_io)?;
        }
        if notebooks_table_exists && !has_pinned_column {
            if !run_legacy_migrations {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "notebook registry requires pinned-column migration",
                ));
            }
            conn.execute_batch("ALTER TABLE notebooks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));")
                .map_err(sqlite_to_io)?;
        }
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS notebooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT,
                path TEXT NOT NULL UNIQUE,
                is_default INTEGER NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notebooks_is_default
                ON notebooks(is_default);
            CREATE INDEX IF NOT EXISTS idx_notebooks_sort
                ON notebooks(sort);
            CREATE INDEX IF NOT EXISTS idx_notebooks_pinned_sort
                ON notebooks(pinned DESC, sort ASC);
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebook_setup_jobs (
                notebook_id TEXT PRIMARY KEY REFERENCES notebooks(id) ON DELETE CASCADE,
                template_id TEXT,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                message TEXT,
                report_json TEXT,
                overwrite_existing INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                run_id TEXT NOT NULL DEFAULT '',
                job_id TEXT NOT NULL DEFAULT '',
                execution_requested INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS local_migrations (
                migration_key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        let has_setup_report = conn
            .prepare("PRAGMA table_info(notebook_setup_jobs)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "report_json");
        if !has_setup_report && !run_legacy_migrations {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "notebook setup registry requires version initialization",
            ));
        }
        if !has_setup_report {
            conn.execute_batch("ALTER TABLE notebook_setup_jobs ADD COLUMN report_json TEXT;")
                .map_err(sqlite_to_io)?;
        }
        let has_setup_overwrite = conn
            .prepare("PRAGMA table_info(notebook_setup_jobs)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "overwrite_existing");
        if !has_setup_overwrite && !run_legacy_migrations {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "notebook setup registry requires version initialization",
            ));
        }
        if !has_setup_overwrite {
            conn.execute_batch(
                "ALTER TABLE notebook_setup_jobs ADD COLUMN overwrite_existing INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(sqlite_to_io)?;
        }
        for (column, declaration) in [
            ("revision", "INTEGER NOT NULL DEFAULT 0"),
            ("run_id", "TEXT NOT NULL DEFAULT ''"),
            ("job_id", "TEXT NOT NULL DEFAULT ''"),
            ("execution_requested", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            let has_column = conn
                .prepare("PRAGMA table_info(notebook_setup_jobs)")
                .map_err(sqlite_to_io)?
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(sqlite_to_io)?
                .filter_map(Result::ok)
                .any(|name| name == column);
            if !has_column && !run_legacy_migrations {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("notebook setup registry requires version initialization ({column})"),
                ));
            }
            if !has_column {
                conn.execute_batch(&format!(
                    "ALTER TABLE notebook_setup_jobs ADD COLUMN {column} {declaration};"
                ))
                .map_err(sqlite_to_io)?;
            }
        }
        conn.execute(
            "UPDATE notebook_setup_jobs SET job_id = lower(hex(randomblob(16))) WHERE job_id = ''",
            [],
        )
        .map_err(sqlite_to_io)?;
        let migration_tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let execution_request_migration: Option<String> = migration_tx
            .query_row(
                "SELECT value FROM app_state WHERE key = 'notebook_setup_execution_request_migrated'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        if execution_request_migration.is_none() {
            migration_tx
                .execute(
                    "UPDATE notebook_setup_jobs SET execution_requested = 1 WHERE status IN ('pending', 'running')",
                    [],
                )
                .map_err(sqlite_to_io)?;
            migration_tx
                .execute(
                    "INSERT INTO app_state (key, value, updated_at) VALUES ('notebook_setup_execution_request_migrated', '1', 0)",
                    [],
                )
                .map_err(sqlite_to_io)?;
        }
        migration_tx.commit().map_err(sqlite_to_io)?;
        conn.execute(
            "INSERT OR IGNORE INTO app_state (key, value, updated_at) SELECT 'notebook_setup_revision', CAST(COALESCE(MAX(revision), 0) AS TEXT), 0 FROM notebook_setup_jobs",
            [],
        )
        .map_err(sqlite_to_io)?;
        if notebooks_table_exists && !has_sort_column {
            let tx = conn.transaction().map_err(sqlite_to_io)?;
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM notebooks WHERE sort = 0 \
                     ORDER BY created_at ASC, name COLLATE NOCASE ASC",
                )
                .map_err(sqlite_to_io)?;
            let ids: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            drop(stmt);
            for (index, id) in ids.iter().enumerate() {
                tx.execute(
                    "UPDATE notebooks SET sort = ?1 WHERE id = ?2 AND sort = 0",
                    params![((index as i64) + 1) * 10, id],
                )
                .map_err(sqlite_to_io)?;
            }
            tx.commit().map_err(sqlite_to_io)?;
        }
        Ok(conn)
    }
}

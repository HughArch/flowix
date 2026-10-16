//! Device-local notebook registry database and its process-local cache.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{params, Connection};

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
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notebooks_is_default
                ON notebooks(is_default);
            CREATE INDEX IF NOT EXISTS idx_notebooks_sort
                ON notebooks(sort);
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
                completed_files INTEGER NOT NULL DEFAULT 0,
                total_files INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                report_json TEXT,
                overwrite_existing INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
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

    pub(super) fn import_legacy_registry(&self, conn: &mut Connection) -> std::io::Result<()> {
        super::initialize_local_migration_table(conn)?;
        let imported: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_migrations WHERE migration_key = 'registry_v1')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if imported {
            return Ok(());
        }
        let legacy_path = self.config_dir.join("db").join("index.db");
        if !legacy_path.is_file() {
            conn.execute(
                "INSERT OR IGNORE INTO local_migrations (migration_key, completed_at) VALUES ('registry_v1', CAST(strftime('%s','now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(sqlite_to_io)?;
            return Ok(());
        }
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let imported: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_migrations WHERE migration_key = 'registry_v1')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if imported {
            return Ok(());
        }
        tx.execute(
            "ATTACH DATABASE ?1 AS old_registry",
            [legacy_path.to_string_lossy().as_ref()],
        )
        .map_err(sqlite_to_io)?;
        let has_table = |name: &str| -> std::io::Result<bool> {
            tx.query_row("SELECT EXISTS(SELECT 1 FROM old_registry.sqlite_master WHERE type = 'table' AND name = ?1)", [name], |row| row.get(0)).map_err(sqlite_to_io)
        };
        if has_table("notebooks")? {
            let has_sort: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('notebooks', 'old_registry') WHERE name = 'sort')", [], |row| row.get(0)).map_err(sqlite_to_io)?;
            let sort = if has_sort {
                "COALESCE(sort, 0)"
            } else {
                "ROW_NUMBER() OVER (ORDER BY created_at, name COLLATE NOCASE) * 10"
            };
            let conflicts: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM old_registry.notebooks old JOIN main.notebooks current ON old.id=current.id OR old.path=current.path WHERE old.id<>current.id OR old.path<>current.path)", [], |row| row.get(0)).map_err(sqlite_to_io)?;
            if conflicts {
                return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "legacy notebook registry conflicts with local.db; both databases were preserved"));
            }
            tx.execute_batch(&format!("INSERT OR IGNORE INTO notebooks (id,name,icon,path,is_default,sort,created_at,updated_at) SELECT id,name,icon,path,is_default,{sort},created_at,updated_at FROM old_registry.notebooks;")).map_err(sqlite_to_io)?;
            let old_count: i64 = tx
                .query_row("SELECT COUNT(*) FROM old_registry.notebooks", [], |row| {
                    row.get(0)
                })
                .map_err(sqlite_to_io)?;
            let imported_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM old_registry.notebooks old JOIN main.notebooks current ON old.id=current.id AND old.path=current.path",
                    [],
                    |row| row.get(0),
                )
                .map_err(sqlite_to_io)?;
            if old_count != imported_count {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "legacy notebook registry verification failed; source data was preserved",
                ));
            }
        } else {
            let has_tables: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM old_registry.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                    [],
                    |row| row.get(0),
                )
                .map_err(sqlite_to_io)?;
            if has_tables {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "legacy index database has an unsupported registry schema; source data was preserved",
                ));
            }
        }
        tx.execute(
            "INSERT INTO local_migrations (migration_key, completed_at) VALUES ('registry_v1', CAST(strftime('%s','now') AS INTEGER) * 1000)",
            [],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_registry_rows_without_rewriting_old_index() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = Connection::open(temp.path().join("index.db")).unwrap();
        legacy.execute_batch("CREATE TABLE notebooks (id TEXT PRIMARY KEY,name TEXT,icon TEXT,path TEXT,is_default INTEGER,sort INTEGER,created_at INTEGER,updated_at INTEGER);
            INSERT INTO notebooks VALUES ('old','Old',NULL,'/old',1,30,1,2);
            CREATE TABLE app_state (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
            INSERT INTO app_state VALUES ('selected_notebook_id','old',2);
            CREATE TABLE notebook_setup_jobs (notebook_id TEXT PRIMARY KEY,template_id TEXT,status TEXT,stage TEXT,completed_files INTEGER,total_files INTEGER,message TEXT,updated_at INTEGER);
            INSERT INTO notebook_setup_jobs VALUES ('old','template','pending','queued',0,1,NULL,2);").unwrap();
        drop(legacy);
        let registry = NotebookRegistry::new(temp.path().to_path_buf());
        let conn = registry.open().unwrap();
        let selected: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_state WHERE key='selected_notebook_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(selected, 0);
        let setup_jobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM notebook_setup_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(setup_jobs, 0);
        conn.execute("DELETE FROM notebooks WHERE id='old'", [])
            .unwrap();
        drop(conn);
        let conn = registry.open().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM notebooks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let legacy = Connection::open(temp.path().join("db/index.db")).unwrap();
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM notebooks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(temp.path().join("db/local.db").is_file());
    }
}

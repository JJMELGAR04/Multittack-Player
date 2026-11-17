//! LIVEPLAYER persistence layer.
//!
//! - SQLite is compiled into the binary (`rusqlite` "bundled"): end users need
//!   no external database installation on any platform.
//! - Schema changes are forward-only migrations tracked with
//!   `PRAGMA user_version`. Each migration runs in a transaction.
//! - The database is owned by the Rust backend; the UI never touches it.

mod songs;

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

pub use songs::{NewTrack, SECTION_KINDS, SectionRecord, SongRecord, SongSummary, SongTempo, TrackRecord};

/// Ordered list of migrations. Index + 1 == resulting schema version.
/// Never edit a migration that has shipped; append a new one instead.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_foundation.sql"),
    include_str!("../migrations/0002_songs.sql"),
];

pub const LATEST_SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("error de SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("no se pudo crear la carpeta de datos {path}: {source}")]
    CreateDir { path: PathBuf, source: std::io::Error },
    #[error("la base de datos tiene el esquema v{found}, más nuevo que el soportado (v{supported})")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("datos no válidos: {0}")]
    Invalid(String),
    #[error("no existe: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    pub path: String,
    pub schema_version: u32,
    pub tables: Vec<String>,
    pub sqlite_version: String,
}

pub struct Database {
    pub(crate) conn: Connection,
    path: PathBuf,
}

impl Database {
    /// Opens (creating if needed) the database file and applies migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|source| DbError::CreateDir { path: dir.to_path_buf(), source })?;
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::init(conn, path)
    }

    /// In-memory database (tests).
    pub fn open_in_memory() -> Result<Self, DbError> {
        Self::init(Connection::open_in_memory()?, PathBuf::from(":memory:"))
    }

    fn init(conn: Connection, path: PathBuf) -> Result<Self, DbError> {
        // WAL keeps reads from blocking writes and is resilient to crashes
        // (important for a live tool). Ignored for in-memory databases.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        let mut db = Self { conn, path };
        db.migrate()?;
        Ok(db)
    }

    pub fn schema_version(&self) -> Result<u32, DbError> {
        Ok(self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
    }

    fn migrate(&mut self) -> Result<(), DbError> {
        let current = self.schema_version()?;
        if current > LATEST_SCHEMA_VERSION {
            return Err(DbError::SchemaTooNew { found: current, supported: LATEST_SCHEMA_VERSION });
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let version = index as u32 + 1;
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn status(&self) -> Result<DatabaseStatus, DbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let tables = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        Ok(DatabaseStatus {
            path: self.path.display().to_string(),
            schema_version: self.schema_version()?,
            tables,
            sqlite_version: rusqlite::version().to_string(),
        })
    }

    /// Generic key/value settings (JSON-encoded values).
    pub fn set_setting(&self, key: &str, json_value: &str) -> Result<(), DbError> {
        self.conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            (key, json_value),
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, DbError> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_in_memory() {
        let db = Database::open_in_memory().unwrap();
        let status = db.status().unwrap();
        assert_eq!(status.schema_version, LATEST_SCHEMA_VERSION);
        assert_eq!(status.tables, vec!["app_settings", "song_sections", "song_tracks", "songs"]);
    }

    #[test]
    fn settings_round_trip_and_upsert() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.get_setting("theme").unwrap(), None);
        db.set_setting("theme", "\"dark\"").unwrap();
        db.set_setting("theme", "\"darker\"").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("\"darker\""));
    }

    #[test]
    fn file_database_persists_and_reopens_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("liveplayer.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.set_setting("k", "1").unwrap();
        }
        let db = Database::open(&path).unwrap(); // second open: no re-migration
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert_eq!(db.get_setting("k").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn rejects_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION + 1).unwrap();
        }
        assert!(matches!(Database::open(&path), Err(DbError::SchemaTooNew { .. })));
    }
}

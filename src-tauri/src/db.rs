use crate::error::AppResult;
use rusqlite::{Connection, OptionalExtension};
use std::{path::PathBuf, time::Duration};

/// Handle to the local SQLite index. Connections are cheap, so every command
/// opens its own; WAL mode plus a busy timeout lets scans write while the UI reads.
#[derive(Clone)]
pub struct Db {
    path: PathBuf,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_scanned_at INTEGER
);
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,
  file_name   TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  extension   TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  width       INTEGER,
  height      INTEGER,
  file_size   INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  added_at    INTEGER NOT NULL,
  screenshot  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS media_captured_idx ON media(captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS media_added_idx    ON media(added_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS media_source_idx   ON media(source_id);
CREATE INDEX IF NOT EXISTS media_folder_idx   ON media(folder_path);
CREATE INDEX IF NOT EXISTS media_type_idx     ON media(media_type);
-- Favorites live apart from the index so they survive rescans and re-adding a source.
CREATE TABLE IF NOT EXISTS favorites (
  path       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

const SCHEMA_VERSION: i64 = 2;

impl Db {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn connect(&self) -> AppResult<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
        Ok(connection)
    }

    /// Create or upgrade the schema. Safe to call on every launch.
    pub fn migrate(&self) -> AppResult<()> {
        let mut connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        let _mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
        let transaction = connection.transaction()?;
        let legacy = is_legacy_schema(&transaction)?;
        if legacy {
            // Version 0 stored dates as text and kept favorites on the media row.
            // The media index is derived data and is rebuilt by the next scan.
            transaction.execute_batch(
                "DROP INDEX IF EXISTS media_captured_idx;
                 DROP INDEX IF EXISTS media_source_idx;
                 DROP INDEX IF EXISTS media_folder_idx;
                 DROP INDEX IF EXISTS media_favorite_idx;
                 ALTER TABLE media RENAME TO media_legacy;
                 ALTER TABLE sources RENAME TO sources_legacy;",
            )?;
        }
        transaction.execute_batch(SCHEMA)?;
        if legacy {
            transaction.execute_batch(
                "INSERT INTO sources(id, path, name, created_at)
                   SELECT id, path, name, COALESCE(CAST(strftime('%s', created_at) AS INTEGER), strftime('%s','now'))
                   FROM sources_legacy;
                 INSERT OR IGNORE INTO favorites(path, created_at)
                   SELECT path, CAST(strftime('%s','now') AS INTEGER) FROM media_legacy WHERE favorite = 1;
                 DROP TABLE media_legacy;
                 DROP TABLE sources_legacy;",
            )?;
        }
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        Ok(())
    }
}

fn is_legacy_schema(connection: &Connection) -> AppResult<bool> {
    let has_media: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='media'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_media.is_none() {
        return Ok(false);
    }
    let mut statement = connection.prepare("PRAGMA table_info(media)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == "favorite"))
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// A migrated database inside a temp directory that lives as long as the guard.
    pub fn temp_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::new(dir.path().join("frame-test.db"));
        db.migrate().unwrap();
        (dir, db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let (_dir, db) = test_support::temp_db();
        db.migrate().unwrap();
        let connection = db.connect().unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_legacy_schema_keeping_sources_and_favorites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, last_scanned_at TEXT);
                     CREATE TABLE media (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, folder_path TEXT NOT NULL, extension TEXT NOT NULL, media_type TEXT NOT NULL, width INTEGER, height INTEGER, file_size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at TEXT NOT NULL, added_at TEXT NOT NULL, last_seen TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, screenshot INTEGER NOT NULL DEFAULT 0);
                     CREATE INDEX media_captured_idx ON media(captured_at DESC);
                     INSERT INTO sources(path,name,created_at) VALUES('D:\\Photos','Photos','2026-10-01T10:00:00+00:00');
                     INSERT INTO media(source_id,path,file_name,folder_path,extension,media_type,file_size,modified_at,captured_at,added_at,last_seen,favorite) VALUES(1,'D:\\Photos\\a.jpg','a.jpg','D:\\Photos','jpg','photo',10,1,'x','x','x',1);",
                )
                .unwrap();
        }
        let db = Db::new(path);
        db.migrate().unwrap();
        let connection = db.connect().unwrap();
        let sources: i64 = connection
            .query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))
            .unwrap();
        let favorites: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM favorites WHERE path='D:\\Photos\\a.jpg'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let media: i64 = connection
            .query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0))
            .unwrap();
        assert_eq!((sources, favorites, media), (1, 1, 0));
    }
}

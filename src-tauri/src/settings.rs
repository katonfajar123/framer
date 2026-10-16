use crate::{db::Db, error::AppResult};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use tauri::State;

/// Settings that ship with sensible defaults. Anything missing from the table
/// falls back to these values, so a fresh install needs no setup.
pub const DEFAULTS: &[(&str, &str)] = &[
    ("theme", "system"),
    ("gridSize", "184"),
    ("cacheLimitMb", "2048"),
    ("watchFolders", "true"),
    ("scanOnLaunch", "true"),
    ("sidebarCollapsed", "false"),
    ("thumbFit", "false"),
    ("timelineGrouping", "day"),
    ("lastView", "all"),
    ("lastFolder", ""),
];

pub fn get(db: &Db, key: &str) -> AppResult<String> {
    let connection = db.connect()?;
    let stored: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(stored.unwrap_or_else(|| {
        DEFAULTS
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| (*value).to_owned())
            .unwrap_or_default()
    }))
}

pub fn get_bool(db: &Db, key: &str) -> bool {
    get(db, key).map(|value| value == "true").unwrap_or(false)
}

pub fn get_u64(db: &Db, key: &str) -> u64 {
    get(db, key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> AppResult<HashMap<String, String>> {
    let connection = db.connect()?;
    let mut settings: HashMap<String, String> = DEFAULTS
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    let mut statement = connection.prepare("SELECT key, value FROM settings")?;
    for row in statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (key, value) = row?;
        settings.insert(key, value);
    }
    Ok(settings)
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<'_, Db>) -> AppResult<()> {
    if !DEFAULTS.iter().any(|(name, _)| *name == key) {
        return Err(format!("Unknown setting: {key}").into());
    }
    db.connect()?.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::temp_db;

    #[test]
    fn defaults_apply_until_overridden() {
        let (_dir, db) = temp_db();
        assert_eq!(get(&db, "theme").unwrap(), "system");
        assert!(get_bool(&db, "watchFolders"));
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('watchFolders','false')",
                [],
            )
            .unwrap();
        assert!(!get_bool(&db, "watchFolders"));
        assert_eq!(get_u64(&db, "cacheLimitMb"), 2048);
    }
}

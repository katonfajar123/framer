use crate::{
    db::{now_secs, Db},
    error::{blocking, AppError, AppResult},
    paths::{self, like_escape},
    scan::{self, ScanRegistry, SourceRow},
    thumbs::Thumbs,
    watch::Watchers,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub available: bool,
    pub media_count: i64,
    pub last_scanned_at: Option<i64>,
    pub scanning: bool,
}

pub fn list_rows(db: &Db) -> AppResult<Vec<SourceRow>> {
    let connection = db.connect()?;
    let mut statement =
        connection.prepare("SELECT id, path, name FROM sources ORDER BY created_at, id")?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceRow {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn find(db: &Db, id: i64) -> Option<SourceRow> {
    let connection = db.connect().ok()?;
    connection
        .query_row(
            "SELECT id, path, name FROM sources WHERE id = ?",
            [id],
            |row| {
                Ok(SourceRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
}

fn records(db: &Db, registry: &ScanRegistry) -> AppResult<Vec<SourceRecord>> {
    let connection = db.connect()?;
    let mut statement = connection.prepare(
        "SELECT s.id, s.path, s.name, COUNT(m.id), s.last_scanned_at
         FROM sources s LEFT JOIN media m ON m.source_id = s.id
         GROUP BY s.id ORDER BY s.created_at, s.id",
    )?;
    let rows = statement
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let path: String = row.get(1)?;
            Ok(SourceRecord {
                id,
                available: Path::new(&path).is_dir(),
                path,
                name: row.get(2)?,
                media_count: row.get(3)?,
                last_scanned_at: row.get(4)?,
                scanning: registry.is_active(id),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Let the webview load original files from this folder through the `asset:` protocol.
pub fn allow_in_webview(app: &AppHandle, path: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(path, true);
}

/// Error text when `candidate` overlaps an existing source, or `None` when it is fine.
pub fn overlap_message(
    existing: &[SourceRow],
    candidate: &Path,
    ignoring: Option<i64>,
) -> Option<String> {
    for source in existing.iter().filter(|source| Some(source.id) != ignoring) {
        if !paths::paths_overlap(Path::new(&source.path), candidate) {
            continue;
        }
        let inside =
            paths::path_key(candidate).starts_with(&paths::path_key(Path::new(&source.path)));
        return Some(if inside {
            format!(
                "That folder is already included in “{}” ({}).",
                source.name, source.path
            )
        } else {
            format!(
                "That folder contains “{}” ({}). Remove that source first, then add the parent folder.",
                source.name, source.path
            )
        });
    }
    None
}

#[tauri::command]
pub async fn list_sources(
    db: State<'_, Db>,
    registry: State<'_, ScanRegistry>,
) -> AppResult<Vec<SourceRecord>> {
    let (db, registry) = (db.inner().clone(), registry.inner().clone());
    blocking(move || records(&db, &registry)).await
}

#[tauri::command]
pub async fn add_source(
    path: String,
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, ScanRegistry>,
    watchers: State<'_, Watchers>,
) -> AppResult<SourceRecord> {
    let (db, registry, watchers) = (
        db.inner().clone(),
        registry.inner().clone(),
        watchers.inner().clone(),
    );
    blocking(move || {
        let requested = paths::canonical(Path::new(&path))
            .map_err(|_| AppError::msg("That folder is unavailable or cannot be read."))?;
        if !requested.is_dir() {
            return Err(AppError::msg("Please choose a folder."));
        }
        if let Some(message) = overlap_message(&list_rows(&db)?, &requested, None) {
            return Err(AppError::msg(message));
        }
        let name = requested
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| paths::file_name_of(&requested.to_string_lossy()));
        let stored = requested.to_string_lossy().into_owned();
        let connection = db.connect()?;
        connection.execute(
            "INSERT INTO sources(path, name, created_at) VALUES(?, ?, ?)",
            params![stored, name, now_secs()],
        )?;
        let id = connection.last_insert_rowid();
        allow_in_webview(&app, &requested);
        let _ = watchers.attach(id, &requested);
        scan::spawn(
            app.clone(),
            db.clone(),
            registry.clone(),
            SourceRow {
                id,
                path: stored.clone(),
                name: name.clone(),
            },
        );
        let _ = app.emit("sources-changed", ());
        Ok(SourceRecord {
            id,
            path: stored,
            name,
            available: true,
            media_count: 0,
            last_scanned_at: None,
            scanning: true,
        })
    })
    .await
}

/// Remove a source from Framer. Only the index is forgotten; no file on disk is touched.
#[tauri::command]
pub async fn remove_source(
    source_id: i64,
    app: AppHandle,
    db: State<'_, Db>,
    watchers: State<'_, Watchers>,
    thumbs: State<'_, Thumbs>,
) -> AppResult<()> {
    let (db, watchers, thumbs) = (
        db.inner().clone(),
        watchers.inner().clone(),
        thumbs.inner().clone(),
    );
    blocking(move || {
        watchers.detach(source_id);
        let connection = db.connect()?;
        let ids: Vec<i64> = {
            let mut statement = connection.prepare("SELECT id FROM media WHERE source_id = ?")?;
            let rows = statement
                .query_map([source_id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        connection.execute("DELETE FROM sources WHERE id = ?", [source_id])?; // media rows cascade
        for id in ids {
            thumbs.remove_for(id);
        }
        Ok(())
    })
    .await?;
    let _ = app.emit("sources-changed", ());
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn rescan_source(
    source_id: i64,
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, ScanRegistry>,
) -> AppResult<()> {
    let source = find(db.inner(), source_id).ok_or_else(|| AppError::msg("Unknown source"))?;
    if !Path::new(&source.path).is_dir() {
        return Err(AppError::msg(
            "Source unavailable. Reconnect the drive or locate the folder.",
        ));
    }
    scan::spawn(app, db.inner().clone(), registry.inner().clone(), source);
    Ok(())
}

#[tauri::command]
pub async fn rescan_all(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, ScanRegistry>,
) -> AppResult<()> {
    for source in list_rows(db.inner())? {
        if Path::new(&source.path).is_dir() {
            scan::spawn(
                app.clone(),
                db.inner().clone(),
                registry.inner().clone(),
                source,
            );
        }
    }
    Ok(())
}

/// Point an existing source at a new location (a drive letter changed, a folder moved).
/// Everything indexed under it, including favorites, follows along.
#[tauri::command]
pub async fn relink_source(
    source_id: i64,
    path: String,
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, ScanRegistry>,
    watchers: State<'_, Watchers>,
) -> AppResult<SourceRecord> {
    let (db, registry, watchers) = (
        db.inner().clone(),
        registry.inner().clone(),
        watchers.inner().clone(),
    );
    let record = blocking({
        let (db, app) = (db.clone(), app.clone());
        move || {
            let requested = paths::canonical(Path::new(&path))
                .map_err(|_| AppError::msg("That folder is unavailable or cannot be read."))?;
            if !requested.is_dir() {
                return Err(AppError::msg("Please choose a folder."));
            }
            let current = find(&db, source_id).ok_or_else(|| AppError::msg("Unknown source"))?;
            if let Some(message) = overlap_message(&list_rows(&db)?, &requested, Some(source_id)) {
                return Err(AppError::msg(message));
            }
            let new_root = requested.to_string_lossy().into_owned();
            let mut connection = db.connect()?;
            let transaction = connection.transaction()?;
            let like = format!("{}\\%", like_escape(&current.path));
            transaction.execute(
                "UPDATE media SET path = ?1 || substr(path, length(?2) + 1),
                                  folder_path = ?1 || substr(folder_path, length(?2) + 1)
                 WHERE source_id = ?3",
                params![new_root, current.path, source_id],
            )?;
            transaction.execute(
                "UPDATE OR REPLACE favorites SET path = ?1 || substr(path, length(?2) + 1)
                 WHERE path LIKE ?3 ESCAPE '!'",
                params![new_root, current.path, like],
            )?;
            transaction.execute(
                "UPDATE sources SET path = ? WHERE id = ?",
                params![new_root, source_id],
            )?;
            transaction.commit()?;
            allow_in_webview(&app, &requested);
            Ok(SourceRow {
                id: source_id,
                path: new_root,
                name: current.name,
            })
        }
    })
    .await?;
    watchers.detach(source_id);
    let _ = watchers.attach(source_id, Path::new(&record.path));
    scan::spawn(app.clone(), db.clone(), registry.clone(), record.clone());
    let _ = app.emit("sources-changed", ());
    let _ = app.emit("library-changed", ());
    records(&db, &registry)?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| AppError::msg("Unknown source"))
}

#[derive(Debug, Serialize)]
pub struct ScanState {
    pub active: bool,
    pub paused: bool,
}

/// Lets the UI show the right sidebar controls even if it missed a progress event.
#[tauri::command]
pub fn scan_state(registry: State<'_, ScanRegistry>) -> ScanState {
    ScanState {
        active: registry.any_active(),
        paused: registry.is_paused(),
    }
}

#[tauri::command]
pub fn pause_scans(registry: State<'_, ScanRegistry>) {
    registry.pause();
}

#[tauri::command]
pub fn resume_scans(registry: State<'_, ScanRegistry>) {
    registry.resume();
}

#[tauri::command]
pub fn cancel_scans(registry: State<'_, ScanRegistry>) {
    registry.cancel_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::temp_db;

    fn row(id: i64, path: &str, name: &str) -> SourceRow {
        SourceRow {
            id,
            path: path.into(),
            name: name.into(),
        }
    }

    #[test]
    fn overlap_messages_explain_which_direction() {
        let existing = vec![row(1, r"D:\Photos", "Photos")];
        let inside = overlap_message(&existing, Path::new(r"D:\Photos\2026"), None).unwrap();
        assert!(inside.contains("already included"), "{inside}");
        let parent = overlap_message(&existing, Path::new(r"D:\"), None).unwrap();
        assert!(parent.contains("contains"), "{parent}");
        assert!(overlap_message(&existing, Path::new(r"D:\Work"), None).is_none());
        assert!(
            overlap_message(&existing, Path::new(r"D:\Photos"), Some(1)).is_none(),
            "relinking onto itself is fine"
        );
    }

    #[test]
    fn listing_reports_counts_and_availability() {
        let (dir, db) = temp_db();
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let connection = db.connect().unwrap();
        connection
            .execute(
                "INSERT INTO sources(id,path,name,created_at) VALUES(1,?,'Real',1)",
                [real.to_str().unwrap()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sources(id,path,name,created_at) VALUES(2,'Z:\\Gone','Gone',2)",
                [],
            )
            .unwrap();
        let records = records(&db, &ScanRegistry::default()).unwrap();
        assert_eq!(records.len(), 2);
        assert!(records[0].available && !records[1].available);
        assert_eq!(records[0].media_count, 0);
    }
}

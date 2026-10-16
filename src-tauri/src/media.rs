use crate::{
    db::{now_secs, Db},
    error::{blocking, AppError, AppResult},
    exif_info::{self, MetaField},
    paths::like_escape,
    search,
    thumbs::Thumbs,
};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};
use tauri::{AppHandle, Emitter, State};

const RECENT_DAYS: i64 = 30;

/// What the user is looking at: a library view, a search, a folder, a sort order.
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaFilter {
    /// all | recent | favorites | videos | screenshots
    pub view: String,
    pub query: String,
    pub folder: Option<String>,
    pub recursive: bool,
    /// "date" (newest first, default) or "name"
    pub sort: String,
}

impl MediaFilter {
    fn by_name(&self) -> bool {
        self.sort == "name"
    }

    /// Recently Added is ordered by when Framer first saw a file, everything else by capture date.
    fn time_column(&self) -> &'static str {
        if self.view == "recent" {
            "added_at"
        } else {
            "captured_at"
        }
    }

    fn order_by(&self) -> String {
        if self.by_name() {
            "m.file_name COLLATE NOCASE ASC, m.id ASC".to_owned()
        } else {
            format!("m.{} DESC, m.id DESC", self.time_column())
        }
    }

    pub fn where_clause(&self) -> (String, Vec<Value>) {
        let mut conditions = vec!["1=1".to_owned()];
        let mut params: Vec<Value> = Vec::new();
        match self.view.as_str() {
            "favorites" => {
                conditions.push("EXISTS (SELECT 1 FROM favorites f WHERE f.path = m.path)".into())
            }
            "videos" => conditions.push("m.media_type = 'video'".into()),
            "screenshots" => conditions.push("m.screenshot = 1".into()),
            "recent" => {
                conditions.push("m.added_at >= ?".into());
                params.push(Value::Integer(now_secs() - RECENT_DAYS * 86_400));
            }
            _ => {}
        }
        if let Some(folder) = self.folder.as_deref().filter(|folder| !folder.is_empty()) {
            let folder = folder.trim_end_matches(['\\', '/']);
            if self.recursive {
                conditions.push(
                    "(m.folder_path = ? COLLATE NOCASE OR m.folder_path LIKE ? ESCAPE '!')".into(),
                );
                params.push(Value::Text(folder.to_owned()));
                params.push(Value::Text(format!("{}\\%", like_escape(folder))));
            } else {
                conditions.push("m.folder_path = ? COLLATE NOCASE".into());
                params.push(Value::Text(folder.to_owned()));
            }
        }
        for term in search::parse(&self.query) {
            conditions.push(search::term_sql(&term, &mut params));
        }
        (conditions.join(" AND "), params)
    }
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: i64,
    pub source_id: i64,
    pub path: String,
    pub file_name: String,
    pub folder_path: String,
    pub extension: String,
    pub media_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub file_size: i64,
    pub modified_at: i64,
    pub captured_at: i64,
    pub added_at: i64,
    pub favorite: bool,
    pub screenshot: bool,
    /// False when the source drive/folder is currently unreachable.
    pub available: bool,
}

#[derive(Debug, Serialize)]
pub struct DayGroup {
    pub day: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLayout {
    pub total: i64,
    /// Newest day first. Empty for name-sorted (flat) listings.
    pub groups: Vec<DayGroup>,
}

const COLUMNS: &str =
    "m.id, m.source_id, m.path, m.file_name, m.folder_path, m.extension, m.media_type, \
     m.width, m.height, m.file_size, m.modified_at, m.captured_at, m.added_at, m.screenshot, \
     EXISTS (SELECT 1 FROM favorites f WHERE f.path = m.path)";

pub fn source_availability(connection: &Connection) -> AppResult<HashMap<i64, bool>> {
    let mut statement = connection.prepare("SELECT id, path FROM sources")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, path)| (id, Path::new(&path).is_dir()))
        .collect())
}

fn item_from_row(
    row: &rusqlite::Row<'_>,
    availability: &HashMap<i64, bool>,
) -> rusqlite::Result<MediaItem> {
    let source_id: i64 = row.get(1)?;
    let dimension = |index: usize| -> rusqlite::Result<Option<u32>> {
        Ok(row.get::<_, Option<i64>>(index)?.map(|value| value as u32))
    };
    Ok(MediaItem {
        id: row.get(0)?,
        source_id,
        path: row.get(2)?,
        file_name: row.get(3)?,
        folder_path: row.get(4)?,
        extension: row.get(5)?,
        media_type: row.get(6)?,
        width: dimension(7)?,
        height: dimension(8)?,
        file_size: row.get(9)?,
        modified_at: row.get(10)?,
        captured_at: row.get(11)?,
        added_at: row.get(12)?,
        screenshot: row.get::<_, i64>(13)? != 0,
        favorite: row.get::<_, i64>(14)? != 0,
        available: availability.get(&source_id).copied().unwrap_or(false),
    })
}

pub fn query_items(
    connection: &Connection,
    filter: &MediaFilter,
    offset: i64,
    limit: i64,
) -> AppResult<Vec<MediaItem>> {
    let (where_sql, mut params) = filter.where_clause();
    params.push(Value::Integer(limit.clamp(1, 2000)));
    params.push(Value::Integer(offset.max(0)));
    let sql = format!(
        "SELECT {COLUMNS} FROM media m WHERE {where_sql} ORDER BY {} LIMIT ? OFFSET ?",
        filter.order_by()
    );
    let availability = source_availability(connection)?;
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params), |row| {
        item_from_row(row, &availability)
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_item(connection: &Connection, id: i64) -> AppResult<Option<MediaItem>> {
    let availability = source_availability(connection)?;
    Ok(connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM media m WHERE m.id = ?"),
            [id],
            |row| item_from_row(row, &availability),
        )
        .optional()?)
}

pub fn layout(connection: &Connection, filter: &MediaFilter) -> AppResult<LibraryLayout> {
    let (where_sql, params) = filter.where_clause();
    if filter.by_name() {
        let total: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM media m WHERE {where_sql}"),
            params_from_iter(params),
            |row| row.get(0),
        )?;
        return Ok(LibraryLayout {
            total,
            groups: Vec::new(),
        });
    }
    let sql = format!(
        "SELECT strftime('%Y-%m-%d', m.{}, 'unixepoch', 'localtime') AS day, COUNT(*) \
         FROM media m WHERE {where_sql} GROUP BY day ORDER BY day DESC",
        filter.time_column()
    );
    let mut statement = connection.prepare(&sql)?;
    let groups = statement
        .query_map(params_from_iter(params), |row| {
            Ok(DayGroup {
                day: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let total = groups.iter().map(|group| group.count).sum();
    Ok(LibraryLayout { total, groups })
}

/// Zero-based position of a media item inside the listing described by `filter`,
/// or `None` when the item is not part of that listing.
pub fn position_of(
    connection: &Connection,
    filter: &MediaFilter,
    media_id: i64,
) -> AppResult<Option<i64>> {
    let (where_sql, params) = filter.where_clause();
    let found: Option<(i64, String)> = {
        let mut params = params.clone();
        params.push(Value::Integer(media_id));
        let sql = format!(
            "SELECT m.{}, m.file_name FROM media m WHERE {where_sql} AND m.id = ?",
            filter.time_column()
        );
        connection
            .query_row(&sql, params_from_iter(params), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?
    };
    let Some((time, name)) = found else {
        return Ok(None);
    };
    let mut params = params;
    let before = if filter.by_name() {
        params.push(Value::Text(name.clone()));
        params.push(Value::Text(name));
        params.push(Value::Integer(media_id));
        "(m.file_name COLLATE NOCASE < ? OR (m.file_name COLLATE NOCASE = ? AND m.id < ?))"
            .to_owned()
    } else {
        let column = filter.time_column();
        params.push(Value::Integer(time));
        params.push(Value::Integer(time));
        params.push(Value::Integer(media_id));
        format!("(m.{column} > ? OR (m.{column} = ? AND m.id > ?))")
    };
    let position: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM media m WHERE {where_sql} AND {before}"),
        params_from_iter(params),
        |row| row.get(0),
    )?;
    Ok(Some(position))
}

pub fn ids_in(
    connection: &Connection,
    filter: &MediaFilter,
    offset: i64,
    limit: i64,
) -> AppResult<Vec<i64>> {
    let (where_sql, mut params) = filter.where_clause();
    params.push(Value::Integer(limit.clamp(1, 200_000)));
    params.push(Value::Integer(offset.max(0)));
    let sql = format!(
        "SELECT m.id FROM media m WHERE {where_sql} ORDER BY {} LIMIT ? OFFSET ?",
        filter.order_by()
    );
    let mut statement = connection.prepare(&sql)?;
    let ids = statement
        .query_map(params_from_iter(params), |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_media(
    filter: MediaFilter,
    offset: i64,
    limit: i64,
    db: State<'_, Db>,
) -> AppResult<Vec<MediaItem>> {
    let db = db.inner().clone();
    blocking(move || query_items(&db.connect()?, &filter, offset, limit)).await
}

#[tauri::command]
pub async fn library_layout(filter: MediaFilter, db: State<'_, Db>) -> AppResult<LibraryLayout> {
    let db = db.inner().clone();
    blocking(move || layout(&db.connect()?, &filter)).await
}

#[tauri::command]
pub async fn media_position(
    filter: MediaFilter,
    media_id: i64,
    db: State<'_, Db>,
) -> AppResult<Option<i64>> {
    let db = db.inner().clone();
    blocking(move || position_of(&db.connect()?, &filter, media_id)).await
}

#[tauri::command]
pub async fn media_ids(
    filter: MediaFilter,
    offset: i64,
    limit: i64,
    db: State<'_, Db>,
) -> AppResult<Vec<i64>> {
    let db = db.inner().clone();
    blocking(move || ids_in(&db.connect()?, &filter, offset, limit)).await
}

#[tauri::command]
pub async fn get_media(media_id: i64, db: State<'_, Db>) -> AppResult<Option<MediaItem>> {
    let db = db.inner().clone();
    blocking(move || get_item(&db.connect()?, media_id)).await
}

#[tauri::command]
pub async fn media_exif(media_id: i64, db: State<'_, Db>) -> AppResult<Vec<MetaField>> {
    let db = db.inner().clone();
    blocking(move || {
        let connection = db.connect()?;
        let path: String = connection
            .query_row("SELECT path FROM media WHERE id = ?", [media_id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| AppError::msg("That item is no longer in your library"))?;
        Ok(exif_info::read_details(Path::new(&path)))
    })
    .await
}

/// Mark or unmark favorites for one or more items. Returns the new state of the first item.
#[tauri::command]
pub async fn set_favorites(ids: Vec<i64>, value: bool, db: State<'_, Db>) -> AppResult<bool> {
    let db = db.inner().clone();
    blocking(move || {
        let mut connection = db.connect()?;
        let transaction = connection.transaction()?;
        for id in &ids {
            let path: Option<String> = transaction
                .query_row("SELECT path FROM media WHERE id = ?", [id], |row| {
                    row.get(0)
                })
                .optional()?;
            let Some(path) = path else { continue };
            if value {
                transaction.execute(
                    "INSERT OR IGNORE INTO favorites(path, created_at) VALUES(?, ?)",
                    params![path, now_secs()],
                )?;
            } else {
                transaction.execute("DELETE FROM favorites WHERE path = ?", [path])?;
            }
        }
        transaction.commit()?;
        Ok(value)
    })
    .await
}

#[tauri::command]
pub async fn toggle_favorite(media_id: i64, db: State<'_, Db>) -> AppResult<bool> {
    let db = db.inner().clone();
    blocking(move || {
        let connection = db.connect()?;
        let path: String = connection
            .query_row("SELECT path FROM media WHERE id = ?", [media_id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| AppError::msg("That item is no longer in your library"))?;
        let removed = connection.execute("DELETE FROM favorites WHERE path = ?", [&path])?;
        if removed > 0 {
            return Ok(false);
        }
        connection.execute(
            "INSERT INTO favorites(path, created_at) VALUES(?, ?)",
            params![path, now_secs()],
        )?;
        Ok(true)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total: i64,
    pub favorites: i64,
    pub videos: i64,
    pub screenshots: i64,
    pub cache_bytes: u64,
}

#[tauri::command]
pub async fn library_stats(
    db: State<'_, Db>,
    thumbs: State<'_, Thumbs>,
) -> AppResult<LibraryStats> {
    let db = db.inner().clone();
    let thumbs = thumbs.inner().clone();
    blocking(move || {
        let connection = db.connect()?;
        let (total, videos, screenshots): (i64, i64, i64) = connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(media_type = 'video'), 0), COALESCE(SUM(screenshot), 0) FROM media",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let favorites: i64 = connection.query_row(
            "SELECT COUNT(*) FROM media m WHERE EXISTS (SELECT 1 FROM favorites f WHERE f.path = m.path)",
            [],
            |row| row.get(0),
        )?;
        Ok(LibraryStats { total, favorites, videos, screenshots, cache_bytes: thumbs.cache_bytes() })
    })
    .await
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> AppResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")))
            .spawn()?;
    }
    #[cfg(not(windows))]
    {
        let parent = Path::new(&path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        std::process::Command::new("xdg-open").arg(parent).spawn()?;
    }
    Ok(())
}

/// Move files to the Windows Recycle Bin. This is deliberately a different command from
/// removing a source from Framer: here the real files leave their folders (recoverably).
#[tauri::command]
pub async fn trash_media(
    ids: Vec<i64>,
    app: AppHandle,
    db: State<'_, Db>,
    thumbs: State<'_, Thumbs>,
) -> AppResult<usize> {
    let db = db.inner().clone();
    let thumbs = thumbs.inner().clone();
    let removed = blocking(move || {
        let mut connection = db.connect()?;
        let mut targets: Vec<(i64, String)> = Vec::new();
        for id in &ids {
            if let Some(path) = connection
                .query_row("SELECT path FROM media WHERE id = ?", [id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?
            {
                targets.push((*id, path));
            }
        }
        let existing: Vec<&String> = targets
            .iter()
            .map(|(_, path)| path)
            .filter(|path| Path::new(path.as_str()).exists())
            .collect();
        if !existing.is_empty() {
            trash::delete_all(existing.iter().map(|path| path.as_str())).map_err(|error| {
                AppError::msg(format!("Couldn't move to the Recycle Bin: {error}"))
            })?;
        }
        let transaction = connection.transaction()?;
        for (id, path) in &targets {
            transaction.execute("DELETE FROM media WHERE id = ?", [id])?;
            transaction.execute("DELETE FROM favorites WHERE path = ?", [path])?;
            thumbs.remove_for(*id);
        }
        transaction.commit()?;
        Ok(targets.len())
    })
    .await?;
    let _ = app.emit("library-changed", ());
    Ok(removed)
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    pub struct Row<'a> {
        pub path: &'a str,
        pub captured_at: i64,
        pub added_at: i64,
        pub media_type: &'a str,
        pub screenshot: bool,
    }

    pub fn insert_source(connection: &Connection, id: i64, path: &str) {
        connection
            .execute(
                "INSERT INTO sources(id, path, name, created_at) VALUES(?, ?, 'src', 0)",
                params![id, path],
            )
            .unwrap();
    }

    pub fn insert(connection: &Connection, source_id: i64, row: Row<'_>) -> i64 {
        let file_name = crate::paths::file_name_of(row.path);
        let folder = crate::paths::parent_of(row.path).unwrap();
        let extension = file_name.rsplit('.').next().unwrap().to_lowercase();
        connection
            .execute(
                "INSERT INTO media(source_id, path, file_name, folder_path, extension, media_type, width, height, \
                 file_size, modified_at, captured_at, added_at, screenshot) VALUES(?,?,?,?,?,?,100,100,10,0,?,?,?)",
                params![source_id, row.path, file_name, folder, extension, row.media_type, row.captured_at, row.added_at, row.screenshot as i64],
            )
            .unwrap();
        connection.last_insert_rowid()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::db::test_support::temp_db;
    use chrono::{Local, TimeZone};

    fn ts(year: i32, month: u32, day: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, 12, 0, 0)
            .unwrap()
            .timestamp()
    }

    fn row(path: &str, captured_at: i64) -> Row<'_> {
        Row {
            path,
            captured_at,
            added_at: now_secs(),
            media_type: "photo",
            screenshot: false,
        }
    }

    fn filter(view: &str, query: &str) -> MediaFilter {
        MediaFilter {
            view: view.into(),
            query: query.into(),
            ..Default::default()
        }
    }

    fn names(items: &[MediaItem]) -> Vec<&str> {
        items.iter().map(|item| item.file_name.as_str()).collect()
    }

    #[test]
    fn search_understands_dates_formats_and_folder_names() {
        let (_dir, db) = temp_db();
        let connection = db.connect().unwrap();
        insert_source(&connection, 1, r"D:\Photos");
        insert(
            &connection,
            1,
            row(r"D:\Photos\Bali\sunset.jpg", ts(2026, 10, 24)),
        );
        insert(
            &connection,
            1,
            row(r"D:\Photos\Bali\temple.PNG", ts(2026, 10, 25)),
        );
        insert(
            &connection,
            1,
            row(r"D:\Photos\Home\cat.jpg", ts(2025, 9, 1)),
        );

        let search = |query: &str| {
            let items = query_items(&connection, &filter("all", query), 0, 50).unwrap();
            items
                .into_iter()
                .map(|item| item.file_name)
                .collect::<Vec<_>>()
        };
        assert_eq!(search("sunset.jpg"), vec!["sunset.jpg"]);
        assert_eq!(search("Bali"), vec!["temple.PNG", "sunset.jpg"]);
        assert_eq!(search("October 2026"), vec!["temple.PNG", "sunset.jpg"]);
        assert_eq!(search("PNG"), vec!["temple.PNG"]);
        assert_eq!(search("2025"), vec!["cat.jpg"]);
        assert_eq!(search("2026-10-25"), vec!["temple.PNG"]);
        assert_eq!(search("bali october png"), vec!["temple.PNG"]);
        assert!(search("nothing-matches").is_empty());
        assert_eq!(search("100%").len(), 0, "wildcards must be escaped");
    }

    #[test]
    fn views_filter_and_order_correctly() {
        let (_dir, db) = temp_db();
        let connection = db.connect().unwrap();
        insert_source(&connection, 1, r"D:\Photos");
        let a = insert(&connection, 1, row(r"D:\Photos\a.jpg", ts(2026, 1, 1)));
        insert(&connection, 1, row(r"D:\Photos\b.jpg", ts(2026, 3, 1)));
        insert(
            &connection,
            1,
            Row {
                media_type: "video",
                ..row(r"D:\Photos\c.mp4", ts(2026, 2, 1))
            },
        );
        insert(
            &connection,
            1,
            Row {
                screenshot: true,
                ..row(r"D:\Photos\Screenshots\d.png", ts(2026, 4, 1))
            },
        );
        insert(
            &connection,
            1,
            Row {
                added_at: 1,
                ..row(r"D:\Photos\old.jpg", ts(2020, 1, 1))
            },
        );

        let list =
            |view: &str| names_owned(&query_items(&connection, &filter(view, ""), 0, 50).unwrap());
        fn names_owned(items: &[MediaItem]) -> Vec<String> {
            items.iter().map(|item| item.file_name.clone()).collect()
        }
        assert_eq!(
            list("all"),
            vec!["d.png", "b.jpg", "c.mp4", "a.jpg", "old.jpg"]
        );
        assert_eq!(list("videos"), vec!["c.mp4"]);
        assert_eq!(list("screenshots"), vec!["d.png"]);
        assert!(
            !list("recent").contains(&"old.jpg".to_owned()),
            "added long ago"
        );
        assert!(list("favorites").is_empty());

        connection
            .execute(
                "INSERT INTO favorites(path, created_at) VALUES(?, 0)",
                [r"D:\Photos\a.jpg"],
            )
            .unwrap();
        assert_eq!(list("favorites"), vec!["a.jpg"]);
        assert!(get_item(&connection, a).unwrap().unwrap().favorite);
    }

    #[test]
    fn layout_groups_by_local_day_and_position_matches_listing() {
        let (_dir, db) = temp_db();
        let connection = db.connect().unwrap();
        insert_source(&connection, 1, r"D:\Photos");
        let mut ids = Vec::new();
        for (index, day) in [3, 3, 2, 1, 1, 1].iter().enumerate() {
            ids.push(insert(
                &connection,
                1,
                row(
                    &format!(r"D:\Photos\p{index}.jpg"),
                    ts(2026, 10, *day) + index as i64,
                ),
            ));
        }
        let layout = layout(&connection, &filter("all", "")).unwrap();
        let counts: Vec<(&str, i64)> = layout
            .groups
            .iter()
            .map(|g| (g.day.as_str(), g.count))
            .collect();
        assert_eq!(
            counts,
            vec![("2026-10-03", 2), ("2026-10-02", 1), ("2026-10-01", 3)]
        );
        assert_eq!(layout.total, 6);

        let listing = query_items(&connection, &filter("all", ""), 0, 50).unwrap();
        for (expected, item) in listing.iter().enumerate() {
            let position = position_of(&connection, &filter("all", ""), item.id).unwrap();
            assert_eq!(position, Some(expected as i64), "item {}", item.file_name);
        }
        assert_eq!(
            position_of(&connection, &filter("videos", ""), ids[0]).unwrap(),
            None
        );
    }

    #[test]
    fn folder_filter_is_direct_or_recursive() {
        let (_dir, db) = temp_db();
        let connection = db.connect().unwrap();
        insert_source(&connection, 1, r"D:\Photos");
        insert(
            &connection,
            1,
            row(r"D:\Photos\Trips\a.jpg", ts(2026, 1, 1)),
        );
        insert(
            &connection,
            1,
            row(r"D:\Photos\Trips\Bali\b.jpg", ts(2026, 1, 2)),
        );
        insert(
            &connection,
            1,
            row(r"D:\Photos\Trips2\c.jpg", ts(2026, 1, 3)),
        );

        let mut folder = MediaFilter {
            folder: Some(r"D:\Photos\Trips".into()),
            sort: "name".into(),
            ..Default::default()
        };
        assert_eq!(
            names(&query_items(&connection, &folder, 0, 50).unwrap()),
            vec!["a.jpg"]
        );
        folder.recursive = true;
        assert_eq!(
            names(&query_items(&connection, &folder, 0, 50).unwrap()),
            vec!["a.jpg", "b.jpg"]
        );
        assert_eq!(layout(&connection, &folder).unwrap().total, 2);
        assert!(layout(&connection, &folder).unwrap().groups.is_empty());
        assert_eq!(position_of(&connection, &folder, 2).unwrap(), Some(1));
    }
}

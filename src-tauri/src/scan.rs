use crate::{
    db::{now_secs, Db},
    error::{AppError, AppResult},
    exif_info,
};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use walkdir::{DirEntry, WalkDir};

/// New rows are committed in batches so photos show up while the scan is still running.
const BATCH_SIZE: usize = 100;
const MAX_BATCH_AGE: Duration = Duration::from_millis(500);
const PROGRESS_EVERY: usize = 40;

#[derive(Debug, Clone)]
pub struct SourceRow {
    pub id: i64,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub source_id: i64,
    pub source_name: String,
    /// Supported files looked at so far.
    pub scanned: usize,
    /// Files that were new or changed and (re)indexed.
    pub indexed: usize,
    pub current_file: String,
    /// scanning | paused | finished | cancelled | failed
    pub state: &'static str,
    pub message: Option<String>,
}

#[derive(Default)]
struct ScanShared {
    active: Mutex<HashSet<i64>>,
    paused: AtomicBool,
    cancel_epoch: AtomicU64,
}

/// Tracks running scans and the global pause / cancel controls shown in the sidebar.
#[derive(Clone, Default)]
pub struct ScanRegistry {
    shared: Arc<ScanShared>,
}

pub struct ScanTicket {
    registry: ScanRegistry,
    source_id: i64,
    epoch: u64,
}

impl ScanRegistry {
    /// Claim a source for scanning. `None` means a scan of it is already running.
    pub fn begin(&self, source_id: i64) -> Option<ScanTicket> {
        if !self.shared.active.lock().insert(source_id) {
            return None;
        }
        Some(ScanTicket {
            registry: self.clone(),
            source_id,
            epoch: self.shared.cancel_epoch.load(Ordering::SeqCst),
        })
    }

    pub fn is_active(&self, source_id: i64) -> bool {
        self.shared.active.lock().contains(&source_id)
    }

    pub fn any_active(&self) -> bool {
        !self.shared.active.lock().is_empty()
    }

    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.shared.paused.load(Ordering::SeqCst)
    }

    /// Stop every scan that is running right now. Scans started later are unaffected.
    pub fn cancel_all(&self) {
        self.shared.cancel_epoch.fetch_add(1, Ordering::SeqCst);
        self.resume();
    }
}

impl ScanTicket {
    fn cancelled(&self) -> bool {
        self.registry.shared.cancel_epoch.load(Ordering::SeqCst) != self.epoch
    }
}

impl Drop for ScanTicket {
    fn drop(&mut self) {
        let mut active = self.registry.shared.active.lock();
        active.remove(&self.source_id);
        // A pause only means something while a scan is running; never leave it armed for the next one.
        if active.is_empty() {
            self.registry.shared.paused.store(false, Ordering::SeqCst);
        }
    }
}

/// Where scan notifications go. The app emits Tauri events; tests record them.
pub trait ScanEvents {
    fn progress(&self, progress: &ScanProgress);
    fn library_changed(&self);
}

pub struct TauriEvents(pub AppHandle);

impl ScanEvents for TauriEvents {
    fn progress(&self, progress: &ScanProgress) {
        let _ = self.0.emit("scan-progress", progress);
    }
    fn library_changed(&self) {
        let _ = self.0.emit("library-changed", ());
    }
}

pub fn media_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" | "png" | "webp" | "gif" => Some("photo"),
        "mp4" | "mov" | "m4v" | "webm" => Some("video"),
        _ => None,
    }
}

fn is_screenshot(file_name: &str, folder: &str) -> bool {
    let name = file_name.to_ascii_lowercase();
    if name.contains("screenshot") || name.contains("screen shot") || name.contains("screen_shot") {
        return true;
    }
    folder.split(['\\', '/']).any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "screenshots" | "screen shots"
        )
    })
}

fn skip_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    if entry.file_type().is_dir() {
        return name.starts_with('.')
            || name.eq_ignore_ascii_case("$RECYCLE.BIN")
            || name.eq_ignore_ascii_case("System Volume Information")
            || name == "@eaDir";
    }
    name.starts_with("._") // macOS resource forks
}

fn epoch(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

struct Known {
    id: i64,
    size: i64,
    modified: i64,
}

struct NewRow {
    path: String,
    file_name: String,
    folder: String,
    extension: String,
    kind: &'static str,
    width: Option<u32>,
    height: Option<u32>,
    size: i64,
    modified: i64,
    captured: i64,
    screenshot: bool,
}

fn flush(connection: &mut Connection, source_id: i64, rows: &mut Vec<NewRow>) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let added_at = now_secs();
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO media(source_id, path, file_name, folder_path, extension, media_type, width, height, \
                               file_size, modified_at, captured_at, added_at, screenshot)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               source_id = excluded.source_id, file_name = excluded.file_name, folder_path = excluded.folder_path,
               extension = excluded.extension, media_type = excluded.media_type, width = excluded.width,
               height = excluded.height, file_size = excluded.file_size, modified_at = excluded.modified_at,
               captured_at = excluded.captured_at, screenshot = excluded.screenshot",
        )?;
        for row in rows.iter() {
            statement.execute(params![
                source_id,
                row.path,
                row.file_name,
                row.folder,
                row.extension,
                row.kind,
                row.width,
                row.height,
                row.size,
                row.modified,
                row.captured,
                added_at,
                row.screenshot as i64
            ])?;
        }
    }
    transaction.commit()?;
    rows.clear();
    Ok(())
}

fn load_known(connection: &Connection, source_id: i64) -> AppResult<HashMap<String, Known>> {
    let mut statement = connection
        .prepare("SELECT id, path, file_size, modified_at FROM media WHERE source_id = ?")?;
    let rows = statement
        .query_map([source_id], |row| {
            Ok((
                row.get::<_, String>(1)?,
                Known {
                    id: row.get(0)?,
                    size: row.get(2)?,
                    modified: row.get(3)?,
                },
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

/// Summary of a finished scan; the app only needs the events, tests inspect the counts.
#[allow(dead_code)]
pub struct ScanOutcome {
    pub scanned: usize,
    pub indexed: usize,
    pub removed: usize,
    pub cancelled: bool,
}

/// Index one source folder. Unchanged files (same size and modified time) are skipped, so
/// re-scans triggered by the file watcher are cheap.
pub fn scan_source(
    db: &Db,
    ticket: &ScanTicket,
    source: &SourceRow,
    events: &dyn ScanEvents,
) -> AppResult<ScanOutcome> {
    let root = Path::new(&source.path);
    if !root.is_dir() {
        return Err(AppError::msg(
            "Source unavailable. Reconnect the drive or locate the folder.",
        ));
    }
    let mut connection = db.connect()?;
    let known = load_known(&connection, source.id)?;
    let mut seen: HashSet<i64> = HashSet::new();
    let mut batch: Vec<NewRow> = Vec::with_capacity(BATCH_SIZE);
    let (mut scanned, mut indexed, mut walk_errors) = (0usize, 0usize, 0usize);
    let mut last_flush = Instant::now();
    let mut cancelled = false;
    let mut last_progress = Instant::now();

    let report = |state: &'static str, scanned: usize, indexed: usize, current: &str| {
        events.progress(&ScanProgress {
            source_id: source.id,
            source_name: source.name.clone(),
            scanned,
            indexed,
            current_file: current.to_owned(),
            state,
            message: None,
        });
    };
    report("scanning", 0, 0, "");

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !skip_entry(e))
    {
        // Pause / cancel are checked between files so they react within a moment.
        let mut announced_pause = false;
        while ticket.registry.is_paused() && !ticket.cancelled() {
            // Tell the UI once when we pause, not on every poll, so its controls stay still.
            if !announced_pause {
                report("paused", scanned, indexed, "");
                announced_pause = true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if announced_pause && !ticket.cancelled() {
            report("scanning", scanned, indexed, "");
        }
        if ticket.cancelled() {
            cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                walk_errors += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(kind) = media_kind(entry.path()) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            walk_errors += 1;
            continue;
        };
        scanned += 1;
        let size = metadata.len() as i64;
        let modified = epoch(metadata.modified().unwrap_or_else(|_| SystemTime::now()));
        let path = entry.path().to_string_lossy().into_owned();

        if let Some(existing) = known.get(&path) {
            seen.insert(existing.id);
            if existing.size == size && existing.modified == modified {
                if scanned % PROGRESS_EVERY == 0
                    && last_progress.elapsed() > Duration::from_millis(120)
                {
                    report(
                        "scanning",
                        scanned,
                        indexed,
                        &entry.file_name().to_string_lossy(),
                    );
                    last_progress = Instant::now();
                }
                continue;
            }
        }

        let (mut width, mut height, mut captured) = (None, None, modified);
        if kind == "photo" {
            let basics = exif_info::read_basics(entry.path());
            if let Some(taken) = basics.captured_at {
                captured = taken;
            }
            if let Ok((w, h)) = image::image_dimensions(entry.path()) {
                // Orientations 5..=8 display the photo rotated by 90 degrees.
                let swapped = (5..=8).contains(&basics.orientation);
                (width, height) = if swapped {
                    (Some(h), Some(w))
                } else {
                    (Some(w), Some(h))
                };
            }
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let folder = entry
            .path()
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_else(|| source.path.clone());
        batch.push(NewRow {
            screenshot: is_screenshot(&file_name, &folder),
            extension: entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default(),
            path,
            file_name: file_name.clone(),
            folder,
            kind,
            width,
            height,
            size,
            modified,
            captured,
        });
        indexed += 1;

        if batch.len() >= BATCH_SIZE || (last_flush.elapsed() > MAX_BATCH_AGE && !batch.is_empty())
        {
            flush(&mut connection, source.id, &mut batch)?;
            last_flush = Instant::now();
            events.library_changed();
        }
        if scanned % PROGRESS_EVERY == 0 && last_progress.elapsed() > Duration::from_millis(120) {
            report("scanning", scanned, indexed, &file_name);
            last_progress = Instant::now();
        }
    }
    if !batch.is_empty() {
        flush(&mut connection, source.id, &mut batch)?;
    }

    let mut removed = 0;
    // Only prune the index after a complete, healthy walk of a folder that is still there.
    // A drive unplugged mid-scan must never make the whole library vanish.
    if !cancelled && walk_errors == 0 && root.is_dir() {
        let transaction = connection.transaction()?;
        for (path, entry) in &known {
            if !seen.contains(&entry.id) && !Path::new(path).exists() {
                transaction.execute("DELETE FROM media WHERE id = ?", [entry.id])?;
                removed += 1;
            }
        }
        transaction.commit()?;
    }
    if !cancelled {
        connection.execute(
            "UPDATE sources SET last_scanned_at = ? WHERE id = ?",
            params![now_secs(), source.id],
        )?;
    }
    if indexed > 0 || removed > 0 {
        events.library_changed();
    }
    report(
        if cancelled { "cancelled" } else { "finished" },
        scanned,
        indexed,
        "",
    );
    Ok(ScanOutcome {
        scanned,
        indexed,
        removed,
        cancelled,
    })
}

/// Run a scan on a background thread. Does nothing if that source is already being scanned.
pub fn spawn(app: AppHandle, db: Db, registry: ScanRegistry, source: SourceRow) {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(ticket) = registry.begin(source.id) else {
            return;
        };
        let events = TauriEvents(app);
        if let Err(error) = scan_source(&db, &ticket, &source, &events) {
            events.progress(&ScanProgress {
                source_id: source.id,
                source_name: source.name.clone(),
                scanned: 0,
                indexed: 0,
                current_file: String::new(),
                state: "failed",
                message: Some(error.to_string()),
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::temp_db;
    use image::RgbImage;
    use std::{cell::RefCell, fs};

    #[derive(Default)]
    struct Recorder {
        states: RefCell<Vec<&'static str>>,
        changes: RefCell<usize>,
    }
    impl ScanEvents for Recorder {
        fn progress(&self, progress: &ScanProgress) {
            self.states.borrow_mut().push(progress.state);
        }
        fn library_changed(&self) {
            *self.changes.borrow_mut() += 1;
        }
    }

    fn write_image(path: &Path, color: u8) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(32, 16, image::Rgb([color, 80, 120]))
            .save(path)
            .unwrap();
    }

    fn setup() -> (tempfile::TempDir, Db, SourceRow) {
        let (dir, db) = temp_db();
        let root = dir.path().join("Photos");
        fs::create_dir_all(&root).unwrap();
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO sources(id, path, name, created_at) VALUES(1, ?, 'Photos', 0)",
                [root.to_str().unwrap()],
            )
            .unwrap();
        let source = SourceRow {
            id: 1,
            path: root.to_string_lossy().into_owned(),
            name: "Photos".into(),
        };
        (dir, db, source)
    }

    fn count(db: &Db) -> i64 {
        db.connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0))
            .unwrap()
    }

    fn scan(
        db: &Db,
        registry: &ScanRegistry,
        source: &SourceRow,
        events: &Recorder,
    ) -> AppResult<ScanOutcome> {
        let ticket = registry.begin(source.id).expect("not already scanning");
        scan_source(db, &ticket, source, events)
    }

    #[test]
    fn indexes_nested_supported_files_with_dimensions_and_flags() {
        let (_dir, db, source) = setup();
        let root = Path::new(&source.path);
        write_image(&root.join("a.jpg"), 10);
        write_image(&root.join("Trips").join("Bali").join("b.PNG"), 20);
        write_image(&root.join("Screenshots").join("shot.png"), 30);
        fs::write(root.join("notes.txt"), "not media").unwrap();
        fs::write(root.join("clip.mp4"), "fake video bytes").unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        write_image(&root.join(".hidden").join("secret.jpg"), 40);

        let events = Recorder::default();
        let outcome = scan(&db, &ScanRegistry::default(), &source, &events).unwrap();
        assert_eq!((outcome.scanned, outcome.indexed), (4, 4));
        assert_eq!(count(&db), 4);
        assert_eq!(events.states.borrow().last(), Some(&"finished"));

        let connection = db.connect().unwrap();
        let (w, h, kind): (i64, i64, String) = connection
            .query_row(
                "SELECT width, height, media_type FROM media WHERE file_name = 'b.PNG'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((w, h, kind.as_str()), (32, 16, "photo"));
        let shots: i64 = connection
            .query_row("SELECT COUNT(*) FROM media WHERE screenshot = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let videos: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM media WHERE media_type = 'video'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((shots, videos), (1, 1));
    }

    #[test]
    fn rescan_skips_unchanged_adds_new_and_removes_deleted() {
        let (_dir, db, source) = setup();
        let root = Path::new(&source.path);
        write_image(&root.join("keep.jpg"), 1);
        write_image(&root.join("gone.jpg"), 2);
        let registry = ScanRegistry::default();
        scan(&db, &registry, &source, &Recorder::default()).unwrap();
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO favorites(path, created_at) VALUES(?, 0)",
                [root.join("keep.jpg").to_str().unwrap()],
            )
            .unwrap();

        fs::remove_file(root.join("gone.jpg")).unwrap();
        write_image(&root.join("new.jpg"), 3);
        let outcome = scan(&db, &registry, &source, &Recorder::default()).unwrap();
        assert_eq!(
            (outcome.scanned, outcome.indexed, outcome.removed),
            (2, 1, 1)
        );
        assert_eq!(count(&db), 2);
        // The favorite is untouched by rescans.
        let fav: i64 = db
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fav, 1);
    }

    #[test]
    fn unavailable_source_keeps_its_index() {
        let (dir, db, source) = setup();
        let root = Path::new(&source.path).to_path_buf();
        write_image(&root.join("a.jpg"), 1);
        let registry = ScanRegistry::default();
        scan(&db, &registry, &source, &Recorder::default()).unwrap();
        assert_eq!(count(&db), 1);

        fs::rename(&root, dir.path().join("Photos-unplugged")).unwrap();
        assert!(scan(&db, &registry, &source, &Recorder::default()).is_err());
        assert_eq!(
            count(&db),
            1,
            "an unplugged drive must not wipe the library"
        );
    }

    #[test]
    fn cancelling_stops_the_scan_and_keeps_what_was_found() {
        let (_dir, db, source) = setup();
        let root = Path::new(&source.path);
        for index in 0..5 {
            write_image(&root.join(format!("p{index}.jpg")), index);
        }
        let registry = ScanRegistry::default();
        let ticket = registry.begin(source.id).unwrap();
        registry.cancel_all(); // cancelled before the first file
        let outcome = scan_source(&db, &ticket, &source, &Recorder::default()).unwrap();
        assert!(outcome.cancelled);
        assert_eq!(count(&db), 0);
        drop(ticket);

        // A fresh scan after a cancel runs normally.
        let outcome = scan(&db, &registry, &source, &Recorder::default()).unwrap();
        assert!(!outcome.cancelled);
        assert_eq!(count(&db), 5);
    }

    #[test]
    fn a_second_scan_of_the_same_source_is_refused_while_one_runs() {
        let registry = ScanRegistry::default();
        let first = registry.begin(7).unwrap();
        assert!(registry.begin(7).is_none());
        assert!(registry.is_active(7));
        drop(first);
        assert!(registry.begin(7).is_some());
    }

    /// Reproducible indexing benchmark:
    /// `FRAME_BENCH_DIR=D:\Photos cargo test --lib benchmark_scan -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark; needs FRAME_BENCH_DIR"]
    fn benchmark_scan() {
        let Some(dir) = std::env::var_os("FRAME_BENCH_DIR") else {
            println!("set FRAME_BENCH_DIR to a folder of photos");
            return;
        };
        let (_tmp, db) = temp_db();
        let path = dir.to_string_lossy().into_owned();
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO sources(id, path, name, created_at) VALUES(1, ?, 'bench', 0)",
                [&path],
            )
            .unwrap();
        let source = SourceRow {
            id: 1,
            path,
            name: "bench".into(),
        };
        let registry = ScanRegistry::default();

        let started = Instant::now();
        let first = scan(&db, &registry, &source, &Recorder::default()).unwrap();
        let first_time = started.elapsed();
        let started = Instant::now();
        let second = scan(&db, &registry, &source, &Recorder::default()).unwrap();
        let second_time = started.elapsed();
        let per_file =
            |time: Duration, files: usize| time.as_secs_f64() * 1000.0 / files.max(1) as f64;
        println!(
            "first scan : {} files in {:.2?} ({:.2} ms/file)\nunchanged  : {} files in {:.2?} ({:.3} ms/file)",
            first.scanned,
            first_time,
            per_file(first_time, first.scanned),
            second.scanned,
            second_time,
            per_file(second_time, second.scanned)
        );
        assert_eq!(
            second.indexed, 0,
            "an unchanged folder must not be re-indexed"
        );
    }

    #[test]
    fn exif_date_and_orientation_drive_capture_time_and_dimensions() {
        use crate::exif_info::test_support::jpeg_with_exif;
        use image::codecs::jpeg::JpegEncoder;
        let (_dir, db, source) = setup();
        let root = Path::new(&source.path);
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&RgbImage::from_pixel(60, 30, image::Rgb([9, 9, 9])))
            .unwrap();
        fs::write(
            root.join("trip.jpg"),
            jpeg_with_exif(&bytes, 6, "2019:07:04 09:15:00", "Cam", "One"),
        )
        .unwrap();
        scan(&db, &ScanRegistry::default(), &source, &Recorder::default()).unwrap();

        let (w, h, day): (i64, i64, String) = db
            .connect()
            .unwrap()
            .query_row(
                "SELECT width, height, strftime('%Y-%m-%d', captured_at, 'unixepoch', 'localtime') FROM media",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((w, h, day.as_str()), (30, 60, "2019-07-04"));
    }
}

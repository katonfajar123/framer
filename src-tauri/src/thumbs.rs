use crate::{
    db::Db,
    error::{AppError, AppResult},
    exif_info, settings,
};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageReader};
use parking_lot::{Condvar, Mutex};
use rusqlite::OptionalExtension;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::SystemTime,
};
use tauri::{http, State};
use walkdir::WalkDir;

/// Longest edge of a cached thumbnail. 512 px stays sharp for 260 px tiles at 200% scaling.
pub const THUMB_EDGE: u32 = 512;
const THUMB_QUALITY: u8 = 82;
/// Decode at most this many images at once so scrolling never starves the UI.
const MAX_CONCURRENT: usize = 3;
/// Re-check the cache size after this many freshly generated thumbnails.
const TRIM_EVERY: usize = 150;

/// Counting semaphore that serves the *most recent* waiter first. While the user scrolls,
/// the thumbnails for rows on screen now matter more than those they scrolled past.
struct Gate {
    state: Mutex<GateState>,
    available: Condvar,
}

struct GateState {
    permits: usize,
    next_ticket: u64,
    waiting: Vec<u64>,
}

/// Thumbnail cache + generator. Cheap to clone; clones share the same state.
#[derive(Clone)]
pub struct Thumbs {
    dir: Arc<PathBuf>,
    db: Db,
    gate: Arc<Gate>,
    generated: Arc<AtomicUsize>,
}

struct Permit<'a>(&'a Gate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.0.state.lock().permits += 1;
        self.0.available.notify_all();
    }
}

impl Gate {
    fn new(permits: usize) -> Self {
        Gate {
            state: Mutex::new(GateState {
                permits,
                next_ticket: 0,
                waiting: Vec::new(),
            }),
            available: Condvar::new(),
        }
    }

    fn acquire(&self) -> Permit<'_> {
        let mut state = self.state.lock();
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.waiting.push(ticket);
        // Only the newest ticket may take a free permit.
        while !(state.permits > 0 && state.waiting.last() == Some(&ticket)) {
            self.available.wait(&mut state);
        }
        state.permits -= 1;
        state.waiting.pop();
        if state.permits > 0 && !state.waiting.is_empty() {
            self.available.notify_all();
        }
        Permit(self)
    }
}

impl Thumbs {
    pub fn new(dir: PathBuf, db: Db) -> Self {
        Self {
            dir: Arc::new(dir),
            db,
            gate: Arc::new(Gate::new(MAX_CONCURRENT)),
            generated: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn acquire(&self) -> Permit<'_> {
        self.gate.acquire()
    }

    fn cache_file(&self, id: i64, modified_at: i64, file_size: i64) -> PathBuf {
        self.dir.join(format!("{id}_{modified_at}_{file_size}.jpg"))
    }

    /// Return the cached JPEG for a media item, generating it first when needed.
    /// Cached thumbnails keep working while the source drive is unplugged.
    pub fn jpeg_for(&self, media_id: i64) -> AppResult<Vec<u8>> {
        let connection = self.db.connect()?;
        let (path, modified_at, file_size): (String, i64, i64) = connection
            .query_row(
                "SELECT path, modified_at, file_size FROM media WHERE id = ?",
                [media_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::msg("Unknown media item"))?;
        drop(connection);

        let cached = self.cache_file(media_id, modified_at, file_size);
        if let Ok(bytes) = fs::read(&cached) {
            return Ok(bytes);
        }
        let bytes = {
            let _permit = self.acquire();
            // Another request may have produced it while we waited for a permit.
            if let Ok(bytes) = fs::read(&cached) {
                return Ok(bytes);
            }
            render_thumbnail(Path::new(&path))?
        };
        self.remove_for(media_id); // drop stale versions of this item
        fs::create_dir_all(self.dir.as_ref())?;
        let temporary = cached.with_extension("tmp");
        fs::write(&temporary, &bytes)?;
        fs::rename(&temporary, &cached)?;
        if self.generated.fetch_add(1, Ordering::Relaxed) % TRIM_EVERY == TRIM_EVERY - 1 {
            self.trim_to_limit();
        }
        Ok(bytes)
    }

    /// Delete every cached version of one item.
    pub fn remove_for(&self, media_id: i64) {
        let prefix = format!("{media_id}_");
        if let Ok(entries) = fs::read_dir(self.dir.as_ref()) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    pub fn cache_bytes(&self) -> u64 {
        WalkDir::new(self.dir.as_ref())
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum()
    }

    pub fn clear(&self) -> AppResult<()> {
        if let Ok(entries) = fs::read_dir(self.dir.as_ref()) {
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }

    /// Evict least-recently-written thumbnails until the cache is under 90% of its limit.
    pub fn trim_to_limit(&self) {
        let limit = settings::get_u64(&self.db, "cacheLimitMb").saturating_mul(1024 * 1024);
        trim_directory(self.dir.as_ref(), limit);
    }
}

fn trim_directory(dir: &Path, limit_bytes: u64) {
    if limit_bytes == 0 {
        return;
    }
    let mut files: Vec<(PathBuf, u64, SystemTime)> = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    entry.into_path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= limit_bytes {
        return;
    }
    let target = limit_bytes / 10 * 9;
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Apply an EXIF orientation (1..=8) so rotated phone photos come out upright.
pub fn apply_orientation(image: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

pub fn render_thumbnail(path: &Path) -> AppResult<Vec<u8>> {
    let image = ImageReader::open(path)?.with_guessed_format()?.decode()?;
    let small = image.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let upright = apply_orientation(small, exif_info::read_basics(path).orientation);
    // JPEG has no alpha channel; flatten to RGB first.
    let rgb = DynamicImage::ImageRgb8(upright.to_rgb8());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, THUMB_QUALITY).encode_image(&rgb)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn clear_thumbnail_cache(thumbs: State<'_, Thumbs>) -> AppResult<()> {
    let thumbs = thumbs.inner().clone();
    crate::error::blocking(move || thumbs.clear()).await
}

/// Handler for the `framer-thumb://localhost/<media id>` scheme. The browser loads
/// thumbnails like ordinary images, so it handles lazy loading, cancellation and caching.
pub fn respond(thumbs: &Thumbs, request_path: &str) -> http::Response<Vec<u8>> {
    let builder = http::Response::builder().header("Access-Control-Allow-Origin", "*");
    let id = request_path.trim_matches('/').parse::<i64>();
    match id
        .map_err(|_| AppError::msg("bad id"))
        .and_then(|id| thumbs.jpeg_for(id))
    {
        Ok(bytes) => builder
            .status(200)
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_default(),
        Err(_) => builder.status(404).body(Vec::new()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::test_support::temp_db,
        exif_info::test_support::jpeg_with_exif,
        media::test_support::{insert, insert_source, Row},
    };
    use image::RgbImage;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, _| image::Rgb([(x % 255) as u8, 90, 160]));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 85)
            .encode_image(&image)
            .unwrap();
        bytes
    }

    fn decode(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory(bytes).unwrap()
    }

    #[test]
    fn thumbnail_is_bounded_and_keeps_aspect_ratio() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.jpg");
        fs::write(&path, jpeg(2000, 1000)).unwrap();
        let thumb = decode(&render_thumbnail(&path).unwrap());
        assert_eq!((thumb.width(), thumb.height()), (512, 256));
    }

    #[test]
    fn exif_rotation_turns_portrait_photos_upright() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("portrait.jpg");
        // Stored landscape (600x300) with orientation 6 => displayed portrait (300x600).
        fs::write(
            &path,
            jpeg_with_exif(&jpeg(600, 300), 6, "2024:01:02 03:04:05", "Cam", "Cam 1"),
        )
        .unwrap();
        let thumb = decode(&render_thumbnail(&path).unwrap());
        assert_eq!((thumb.width(), thumb.height()), (256, 512));
    }

    #[test]
    fn png_with_alpha_becomes_a_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alpha.png");
        image::RgbaImage::from_pixel(40, 40, image::Rgba([10, 200, 10, 128]))
            .save(&path)
            .unwrap();
        assert!(render_thumbnail(&path).unwrap().starts_with(&[0xFF, 0xD8]));
    }

    #[test]
    fn cache_serves_after_source_disappears_and_trims_old_files() {
        let (dir, db) = temp_db();
        let photos = dir.path().join("photos");
        fs::create_dir_all(&photos).unwrap();
        let file = photos.join("a.jpg");
        fs::write(&file, jpeg(300, 200)).unwrap();
        let connection = db.connect().unwrap();
        insert_source(&connection, 1, photos.to_str().unwrap());
        let id = insert(
            &connection,
            1,
            Row {
                path: file.to_str().unwrap(),
                captured_at: 0,
                added_at: 0,
                media_type: "photo",
                screenshot: false,
            },
        );
        let thumbs = Thumbs::new(dir.path().join("cache"), db);
        let first = thumbs.jpeg_for(id).unwrap();

        fs::remove_file(&file).unwrap(); // simulate an unplugged drive
        assert_eq!(thumbs.jpeg_for(id).unwrap(), first);
        assert!(thumbs.cache_bytes() > 0);

        trim_directory(&dir.path().join("cache"), 1);
        assert_eq!(thumbs.cache_bytes(), 0, "evicted when over the limit");
        assert!(
            thumbs.jpeg_for(id).is_err(),
            "no cache and no file => unavailable"
        );
    }

    #[test]
    fn newest_request_gets_the_next_free_permit() {
        use std::{sync::mpsc, thread, time::Duration};
        let gate = Arc::new(Gate::new(1));
        let held = gate.acquire(); // occupy the only permit
        let (done, finished) = mpsc::channel();
        let mut workers = Vec::new();
        for id in 0..4 {
            let (gate, done) = (gate.clone(), done.clone());
            workers.push(thread::spawn(move || {
                let _permit = gate.acquire();
                done.send(id).unwrap();
                thread::sleep(Duration::from_millis(30));
            }));
            thread::sleep(Duration::from_millis(60)); // make arrival order deterministic
        }
        drop(held);
        let order: Vec<i32> = (0..4)
            .map(|_| finished.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        workers
            .into_iter()
            .for_each(|worker| worker.join().unwrap());
        assert_eq!(order, vec![3, 2, 1, 0], "last in, first served");
    }

    #[test]
    fn respond_rejects_garbage_paths() {
        let (dir, db) = temp_db();
        let thumbs = Thumbs::new(dir.path().join("cache"), db);
        assert_eq!(respond(&thumbs, "/not-a-number").status(), 404);
        assert_eq!(respond(&thumbs, "/999").status(), 404);
    }
}

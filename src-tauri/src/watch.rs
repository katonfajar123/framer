use crate::{
    db::Db,
    error::{AppError, AppResult},
    scan::{self, ScanRegistry},
    settings, sources,
};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// How long a folder must stay quiet before it is rescanned, so copying 500 photos
/// triggers one scan instead of 500.
const QUIET_PERIOD: Duration = Duration::from_millis(1500);

#[derive(Default)]
struct Inner {
    watchers: Mutex<HashMap<i64, RecommendedWatcher>>,
    dirty: Mutex<HashMap<i64, Instant>>,
}

/// File-system watchers, one per source folder.
#[derive(Clone, Default)]
pub struct Watchers {
    inner: Arc<Inner>,
}

impl Watchers {
    pub fn attach(&self, source_id: i64, path: &Path) -> AppResult<()> {
        let inner = self.inner.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if !matches!(event.kind, EventKind::Access(_)) {
                        inner.dirty.lock().insert(source_id, Instant::now());
                    }
                }
            })
            .map_err(|error| AppError::msg(error.to_string()))?;
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|error| AppError::msg(error.to_string()))?;
        self.inner.watchers.lock().insert(source_id, watcher);
        Ok(())
    }

    pub fn detach(&self, source_id: i64) {
        self.inner.watchers.lock().remove(&source_id);
        self.inner.dirty.lock().remove(&source_id);
    }

    pub fn is_attached(&self, source_id: i64) -> bool {
        self.inner.watchers.lock().contains_key(&source_id)
    }

    pub fn attached_ids(&self) -> Vec<i64> {
        self.inner.watchers.lock().keys().copied().collect()
    }

    /// Sources whose folders changed and have been quiet for `quiet`.
    pub fn take_due(&self, quiet: Duration) -> Vec<i64> {
        let mut dirty = self.inner.dirty.lock();
        let due: Vec<i64> = dirty
            .iter()
            .filter(|(_, changed)| changed.elapsed() >= quiet)
            .map(|(id, _)| *id)
            .collect();
        for id in &due {
            dirty.remove(id);
        }
        due
    }

    pub fn clear_dirty(&self) {
        self.inner.dirty.lock().clear();
    }
}

/// Background loop: debounces file changes into rescans, and notices when a drive is
/// unplugged or plugged back in. Runs for the lifetime of the app.
pub fn spawn_monitor(app: AppHandle, db: Db, registry: ScanRegistry, watchers: Watchers) {
    std::thread::spawn(move || {
        let mut availability: HashMap<i64, bool> = HashMap::new();
        let mut tick: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            tick += 1;
            let watching = settings::get_bool(&db, "watchFolders");

            if watching {
                for id in watchers.take_due(QUIET_PERIOD) {
                    if let Some(source) = sources::find(&db, id) {
                        scan::spawn(app.clone(), db.clone(), registry.clone(), source);
                    }
                }
            } else {
                watchers.clear_dirty();
            }

            if !tick.is_multiple_of(3) {
                continue;
            }
            let Ok(all) = sources::list_rows(&db) else {
                continue;
            };
            let mut changed = false;
            for source in &all {
                let available = Path::new(&source.path).is_dir();
                let previous = availability.insert(source.id, available);
                if previous.is_some() && previous != Some(available) {
                    changed = true;
                    if available && watching {
                        // Drive is back: pick up whatever changed while it was away.
                        scan::spawn(app.clone(), db.clone(), registry.clone(), source.clone());
                    }
                }
                let attached = watchers.is_attached(source.id);
                if available && watching && !attached {
                    let _ = watchers.attach(source.id, Path::new(&source.path));
                } else if (!available || !watching) && attached {
                    watchers.detach(source.id);
                }
            }
            // Forget sources that were removed.
            let ids: Vec<i64> = all.iter().map(|source| source.id).collect();
            availability.retain(|id, _| ids.contains(id));
            for id in watchers.attached_ids() {
                if !ids.contains(&id) {
                    watchers.detach(id);
                }
            }
            if changed {
                let _ = app.emit("sources-changed", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_are_debounced_per_source() {
        let watchers = Watchers::default();
        {
            let mut dirty = watchers.inner.dirty.lock();
            dirty.insert(1, Instant::now() - Duration::from_secs(5));
            dirty.insert(2, Instant::now());
        }
        assert_eq!(watchers.take_due(QUIET_PERIOD), vec![1]);
        assert!(watchers.take_due(QUIET_PERIOD).is_empty(), "taken once");
        watchers.clear_dirty();
        assert!(watchers.take_due(Duration::ZERO).is_empty());
    }

    #[test]
    fn watching_a_real_folder_marks_it_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let watchers = Watchers::default();
        watchers.attach(9, dir.path()).unwrap();
        assert!(watchers.is_attached(9));
        std::fs::write(dir.path().join("new.jpg"), b"x").unwrap();
        let mut seen = false;
        for _ in 0..40 {
            if !watchers.take_due(Duration::ZERO).is_empty() {
                seen = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(seen, "file creation should be reported by the OS watcher");
        watchers.detach(9);
        assert!(!watchers.is_attached(9));
    }
}

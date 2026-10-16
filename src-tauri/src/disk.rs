//! Read-only disk usage analysis. This module never deletes or mutates user files.

use crate::error::{blocking, AppError, AppResult};
use serde::Serialize;
use std::{
    cmp::Reverse,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Instant, UNIX_EPOCH},
};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LARGE_FILE_MIN: u64 = 100 * 1024 * 1024;
const VERY_LARGE_FILE: u64 = 1024 * 1024 * 1024;
const MAX_FOLDERS_RETURNED: usize = 50_000;
const MAX_LARGE_FILES: usize = 150;

#[derive(Default)]
pub struct DiskScanner {
    generation: Arc<AtomicU64>,
    scanning: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRoot {
    pub name: String,
    pub path: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub removable: bool,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderUsage {
    pub path: String,
    pub parent: Option<String>,
    pub name: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub depth: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub extension: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRecommendation {
    pub category: String,
    pub title: String,
    pub explanation: String,
    pub path: String,
    pub size_bytes: u64,
    /// `low` means usually regeneratable; `review` means Framer cannot know its importance.
    pub risk: String,
    pub file_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskAnalysis {
    pub root: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub inaccessible_count: u64,
    pub folders: Vec<FolderUsage>,
    pub largest_files: Vec<LargeFile>,
    pub recommendations: Vec<CleanupRecommendation>,
    pub elapsed_ms: u128,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskScanProgress {
    root: String,
    current_path: String,
    file_count: u64,
    scanned_bytes: u64,
    finished: bool,
    cancelled: bool,
}

#[derive(Default, Clone, Copy)]
struct Aggregate {
    bytes: u64,
    files: u64,
}

#[tauri::command]
pub fn list_disks() -> Vec<DiskRoot> {
    Disks::new_with_refreshed_list()
        .iter()
        .map(|disk| DiskRoot {
            name: disk.name().to_string_lossy().into_owned(),
            path: disk.mount_point().to_string_lossy().into_owned(),
            total_bytes: disk.total_space(),
            free_bytes: disk.available_space(),
            removable: disk.is_removable(),
            kind: format!("{:?}", disk.kind()),
        })
        .collect()
}

#[tauri::command]
pub async fn analyze_disk(
    path: String,
    app: AppHandle,
    scanner: State<'_, DiskScanner>,
) -> AppResult<DiskAnalysis> {
    let root = dunce::canonicalize(&path)
        .map_err(|_| AppError::msg("That drive or folder is unavailable"))?;
    if !root.is_dir() {
        return Err(AppError::msg("Choose a drive or folder to analyze"));
    }
    let generation = scanner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    scanner.scanning.store(true, Ordering::SeqCst);
    let active_generation = scanner.generation.clone();
    let scanning = scanner.scanning.clone();
    blocking(move || {
        let result = scan(root, &app, generation, &active_generation);
        if active_generation.load(Ordering::SeqCst) == generation {
            scanning.store(false, Ordering::SeqCst);
        }
        result
    })
    .await
}

#[tauri::command]
pub fn cancel_disk_scan(scanner: State<'_, DiskScanner>) {
    scanner.generation.fetch_add(1, Ordering::SeqCst);
    scanner.scanning.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn open_disk_path(path: String) -> AppResult<()> {
    let target =
        dunce::canonicalize(&path).map_err(|_| AppError::msg("That path is unavailable"))?;
    #[cfg(windows)]
    {
        let mut explorer = std::process::Command::new("explorer.exe");
        if target.is_file() {
            explorer.raw_arg(format!(r#"/select,"{}""#, target.display()));
        } else {
            explorer.arg(target);
        }
        explorer.spawn()?;
    }
    #[cfg(not(windows))]
    std::process::Command::new("xdg-open").arg(target).spawn()?;
    Ok(())
}

fn scan(
    root: PathBuf,
    app: &AppHandle,
    generation: u64,
    active_generation: &AtomicU64,
) -> AppResult<DiskAnalysis> {
    let started = Instant::now();
    let mut aggregates: HashMap<PathBuf, Aggregate> = HashMap::new();
    let mut largest_files = Vec::new();
    let mut inaccessible = 0u64;
    let mut file_count = 0u64;
    let mut total_bytes = 0u64;
    let mut last_progress = Instant::now();
    let mut cancelled = false;

    for entry in WalkDir::new(&root).follow_links(false).into_iter() {
        if active_generation.load(Ordering::Relaxed) != generation {
            cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                inaccessible += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                inaccessible += 1;
                continue;
            }
        };
        let bytes = metadata.len();
        file_count += 1;
        total_bytes = total_bytes.saturating_add(bytes);
        if bytes >= LARGE_FILE_MIN {
            largest_files.push(file_record(entry.path(), &metadata));
        }
        let mut ancestor = entry.path().parent();
        while let Some(folder) = ancestor {
            if !folder.starts_with(&root) {
                break;
            }
            let aggregate = aggregates.entry(folder.to_path_buf()).or_default();
            aggregate.bytes = aggregate.bytes.saturating_add(bytes);
            aggregate.files += 1;
            if folder == root {
                break;
            }
            ancestor = folder.parent();
        }
        if file_count.is_multiple_of(750) || last_progress.elapsed().as_millis() > 500 {
            last_progress = Instant::now();
            let _ = app.emit(
                "disk-scan-progress",
                DiskScanProgress {
                    root: path_string(&root),
                    current_path: path_string(entry.path()),
                    file_count,
                    scanned_bytes: total_bytes,
                    finished: false,
                    cancelled: false,
                },
            );
        }
    }

    largest_files.sort_by_key(|file| Reverse(file.size_bytes));
    largest_files.truncate(MAX_LARGE_FILES);
    let recommendations = recommendations(&root, &aggregates, &largest_files);
    let mut folders: Vec<_> = aggregates
        .into_iter()
        .map(|(path, value)| folder_record(&root, path, value))
        .collect();
    folders.sort_by_key(|folder| {
        (
            folder.depth,
            Reverse(folder.size_bytes),
            folder.name.clone(),
        )
    });
    let truncated = folders.len() > MAX_FOLDERS_RETURNED;
    folders.truncate(MAX_FOLDERS_RETURNED);
    let result = DiskAnalysis {
        root: path_string(&root),
        total_bytes,
        file_count,
        inaccessible_count: inaccessible,
        folders,
        largest_files,
        recommendations,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
        cancelled,
    };
    let _ = app.emit(
        "disk-scan-progress",
        DiskScanProgress {
            root: result.root.clone(),
            current_path: String::new(),
            file_count,
            scanned_bytes: total_bytes,
            finished: true,
            cancelled,
        },
    );
    Ok(result)
}

fn file_record(path: &Path, metadata: &fs::Metadata) -> LargeFile {
    LargeFile {
        path: path_string(path),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size_bytes: metadata.len(),
        modified_at: metadata
            .modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        extension: path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase(),
    }
}

fn folder_record(root: &Path, path: PathBuf, aggregate: Aggregate) -> FolderUsage {
    let parent = if path == root {
        None
    } else {
        path.parent().map(path_string)
    };
    let depth = path
        .strip_prefix(root)
        .map(|relative| relative.components().count())
        .unwrap_or_default();
    FolderUsage {
        name: path
            .file_name()
            .filter(|name| !name.is_empty())
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: path_string(&path),
        parent,
        size_bytes: aggregate.bytes,
        file_count: aggregate.files,
        depth,
    }
}

fn recommendations(
    _root: &Path,
    aggregates: &HashMap<PathBuf, Aggregate>,
    largest: &[LargeFile],
) -> Vec<CleanupRecommendation> {
    let mut result = Vec::new();
    for (path, aggregate) in aggregates {
        if aggregate.bytes < 50 * 1024 * 1024 {
            continue;
        }
        let lower = path_string(path).to_ascii_lowercase();
        let (category, title, explanation) = if is_temp_or_cache(&lower) {
            ("temporary", "Temporary or cache data", "Usually regenerated by Windows or applications. Close related apps and review the folder before cleaning it.")
        } else if lower.ends_with("\\downloads") && aggregate.bytes >= 500 * 1024 * 1024 {
            ("downloads", "Large Downloads folder", "Downloads often contains installers and archives you may no longer need. Review each item; personal files may still be important.")
        } else {
            continue;
        };
        result.push(CleanupRecommendation {
            category: category.into(),
            title: title.into(),
            explanation: explanation.into(),
            path: path_string(path),
            size_bytes: aggregate.bytes,
            risk: if category == "temporary" {
                "low".into()
            } else {
                "review".into()
            },
            file_count: aggregate.files,
        });
    }
    for file in largest
        .iter()
        .filter(|file| file.size_bytes >= VERY_LARGE_FILE)
        .take(12)
    {
        result.push(CleanupRecommendation { category:"large-file".into(), title:"Very large file".into(), explanation:"Framer cannot determine whether this file is important. Open its location and review it before taking action.".into(), path:file.path.clone(), size_bytes:file.size_bytes, risk:"review".into(), file_count:1 });
    }
    result.sort_by_key(|item| (item.risk != "low", Reverse(item.size_bytes)));
    result.dedup_by(|left, right| left.path.eq_ignore_ascii_case(&right.path));
    result.truncate(30);
    result
}

fn is_temp_or_cache(lower_path: &str) -> bool {
    lower_path.ends_with("\\appdata\\local\\temp")
        || lower_path.ends_with("\\windows\\temp")
        || lower_path.ends_with("\\cache")
        || lower_path.ends_with("\\code cache")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_explicit_cache_paths_as_low_risk() {
        assert!(is_temp_or_cache(r"c:\users\me\appdata\local\temp"));
        assert!(is_temp_or_cache(r"c:\app\cache"));
        assert!(!is_temp_or_cache(r"c:\app\cache\images"));
        assert!(!is_temp_or_cache(r"d:\photos\important"));
    }

    #[test]
    fn folder_record_preserves_hierarchy() {
        let root = Path::new(r"C:\");
        let item = folder_record(
            root,
            PathBuf::from(r"C:\Users\Me"),
            Aggregate {
                bytes: 42,
                files: 2,
            },
        );
        assert_eq!(item.parent.as_deref(), Some(r"C:\Users"));
        assert_eq!(item.depth, 2);
    }
}

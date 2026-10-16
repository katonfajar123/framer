//! Read-only disk usage analysis. This module never deletes or mutates user files.

use crate::error::{blocking, AppError, AppResult};
use serde::Serialize;
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
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
use std::{
    ffi::c_void,
    iter,
    os::windows::{ffi::OsStrExt, process::CommandExt},
};

const LARGE_FILE_MIN: u64 = 100 * 1024 * 1024;
const VERY_LARGE_FILE: u64 = 1024 * 1024 * 1024;
const MAX_FOLDERS_RETURNED: usize = 50_000;
const MAX_LARGE_FILES: usize = 150;
const PROBE_BATCH: usize = 256;
const MAX_PROBE_THREADS: usize = 8;

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
    /// Bytes physically allocated on the volume. `size_bytes` is kept as the display value.
    pub logical_bytes: u64,
    pub file_count: u64,
    pub depth: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub logical_bytes: u64,
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
    pub logical_bytes: u64,
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
    logical_bytes: u64,
    files: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, Eq, Hash, PartialEq)]
struct FileId {
    volume_serial: u32,
    file_index: u64,
}

#[cfg(not(windows))]
type FileId = u64;

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct ByHandleFileInformation {
    dwFileAttributes: u32,
    ftCreationTimeLowDateTime: u32,
    ftCreationTimeHighDateTime: u32,
    ftLastAccessTimeLowDateTime: u32,
    ftLastAccessTimeHighDateTime: u32,
    ftLastWriteTimeLowDateTime: u32,
    ftLastWriteTimeHighDateTime: u32,
    dwVolumeSerialNumber: u32,
    nFileSizeHigh: u32,
    nFileSizeLow: u32,
    nNumberOfLinks: u32,
    nFileIndexHigh: u32,
    nFileIndexLow: u32,
}

#[cfg(windows)]
#[repr(C)]
struct FileCompressionInfo {
    compressed_file_size: i64,
    compression_format: u16,
    compression_unit_shift: u8,
    chunk_shift: u8,
    cluster_shift: u8,
    reserved: [u8; 3],
}

/// What a single open handle can tell us about a file.
#[derive(Default)]
struct FileProbe {
    id: Option<FileId>,
    /// The value `GetCompressedFileSizeW` reports; `None` when the filesystem cannot say.
    allocated: Option<u64>,
}

#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        lpFileName: *const u16,
        dwDesiredAccess: u32,
        dwShareMode: u32,
        lpSecurityAttributes: *mut c_void,
        dwCreationDisposition: u32,
        dwFlagsAndAttributes: u32,
        hTemplateFile: *mut c_void,
    ) -> *mut c_void;
    fn CloseHandle(hObject: *mut c_void) -> i32;
    fn GetFileInformationByHandle(
        hFile: *mut c_void,
        lpFileInformation: *mut ByHandleFileInformation,
    ) -> i32;
    fn GetFileInformationByHandleEx(
        hFile: *mut c_void,
        FileInformationClass: i32,
        lpFileInformation: *mut c_void,
        dwBufferSize: u32,
    ) -> i32;
    fn GetCompressedFileSizeW(lpFileName: *const u16, lpFileSizeHigh: *mut u32) -> u32;
    fn GetLastError() -> u32;
    fn GetDiskFreeSpaceW(
        lpRootPathName: *const u16,
        lpSectorsPerCluster: *mut u32,
        lpBytesPerSector: *mut u32,
        lpNumberOfFreeClusters: *mut u32,
        lpTotalNumberOfClusters: *mut u32,
    ) -> i32;
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
    let mut logical_bytes = 0u64;
    let mut seen_file_ids = HashSet::<FileId>::new();
    let cluster_size = allocation_unit_size(&root).unwrap_or(4 * 1024);
    let mut last_progress = Instant::now();
    let mut cancelled = false;
    let probe_threads = std::thread::available_parallelism()
        .map_or(4, |count| count.get())
        .clamp(2, MAX_PROBE_THREADS);

    // Walking is cheap, opening each file is not. Files are collected into batches whose
    // handles are opened in parallel, then accounted for in walk order so hard-link
    // de-duplication and totals stay deterministic.
    let mut batch: Vec<(PathBuf, fs::Metadata)> = Vec::with_capacity(PROBE_BATCH);
    let mut flush = |batch: &mut Vec<(PathBuf, fs::Metadata)>| {
        let probes = probe_batch(batch, probe_threads);
        for ((path, metadata), probe) in batch.drain(..).zip(probes) {
            if let Some(file_id) = probe.id {
                if !seen_file_ids.insert(file_id) {
                    continue;
                }
            }
            let logical = metadata.len();
            let bytes = probe
                .allocated
                .unwrap_or_else(|| allocated_size(&path, logical, cluster_size));
            file_count += 1;
            total_bytes = total_bytes.saturating_add(bytes);
            logical_bytes = logical_bytes.saturating_add(logical);
            if bytes >= LARGE_FILE_MIN {
                largest_files.push(file_record(&path, &metadata, bytes));
            }
            let mut ancestor = path.parent();
            while let Some(folder) = ancestor {
                if !folder.starts_with(&root) {
                    break;
                }
                let aggregate = aggregates.entry(folder.to_path_buf()).or_default();
                aggregate.bytes = aggregate.bytes.saturating_add(bytes);
                aggregate.logical_bytes = aggregate.logical_bytes.saturating_add(logical);
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
                        current_path: path_string(&path),
                        file_count,
                        scanned_bytes: total_bytes,
                        finished: false,
                        cancelled: false,
                    },
                );
            }
        }
    };

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_traverse)
    {
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
        // On Windows walkdir keeps the metadata from the directory listing, so this costs no I/O.
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                inaccessible += 1;
                continue;
            }
        };
        if is_reparse_point(&metadata) || !metadata.is_file() {
            continue;
        }
        batch.push((entry.into_path(), metadata));
        if batch.len() >= PROBE_BATCH {
            flush(&mut batch);
        }
    }
    if !cancelled {
        flush(&mut batch);
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
        logical_bytes,
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

/// Never enter Windows reparse points (symlinks, junctions, mount points) and leave only
/// the Windows system directory out of a whole-drive analysis. Program Files and ProgramData
/// remain part of the scan.
fn should_traverse(entry: &walkdir::DirEntry) -> bool {
    if is_windows_system_directory(entry.path()) {
        return false;
    }
    if entry.file_type().is_symlink() {
        return false;
    }
    entry
        .metadata()
        .map(|metadata| !is_reparse_point(&metadata))
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_windows_system_directory(path: &Path) -> bool {
    use std::path::Component;

    let mut components = path.components();
    matches!(components.next(), Some(Component::Prefix(_)))
        && matches!(components.next(), Some(Component::RootDir))
        && matches!(components.next(), Some(Component::Normal(name)) if name.eq_ignore_ascii_case("Windows"))
        && components.next().is_none()
}

#[cfg(not(windows))]
fn is_windows_system_directory(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

/// Opening a file is by far the most expensive step of the scan, so the hard-link identity
/// and the allocated size are both read through one handle.
#[cfg(windows)]
fn probe_file(path: &Path) -> FileProbe {
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_ALL: u32 = 0x7;
    const OPEN_EXISTING: u32 = 3;
    const FILE_COMPRESSION_INFO_CLASS: i32 = 8;
    const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;

    let wide = wide_path(path);
    // SAFETY: the path is NUL-terminated; no security attributes or template handle are supplied.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_ALL,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return FileProbe::default();
    }

    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::zeroed();
    // SAFETY: `handle` is valid and `information` points at writable, correctly sized memory.
    let id = if unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) } != 0 {
        // SAFETY: a non-zero return guarantees initialization.
        let information = unsafe { information.assume_init() };
        Some(FileId {
            volume_serial: information.dwVolumeSerialNumber,
            file_index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    } else {
        None
    };

    let mut compression = std::mem::MaybeUninit::<FileCompressionInfo>::zeroed();
    // SAFETY: `handle` is valid and the buffer size matches FILE_COMPRESSION_INFO.
    let allocated = if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FILE_COMPRESSION_INFO_CLASS,
            compression.as_mut_ptr().cast(),
            std::mem::size_of::<FileCompressionInfo>() as u32,
        )
    } != 0
    {
        // SAFETY: a non-zero return guarantees initialization.
        u64::try_from(unsafe { compression.assume_init() }.compressed_file_size).ok()
    } else {
        None
    };

    // SAFETY: `handle` was returned by CreateFileW and is closed exactly once here.
    let _ = unsafe { CloseHandle(handle) };
    FileProbe { id, allocated }
}

#[cfg(not(windows))]
fn probe_file(_path: &Path) -> FileProbe {
    FileProbe::default()
}

/// Probes every file of the batch, spreading the work over `threads` threads. The result is
/// in the same order as `batch`.
fn probe_batch(batch: &[(PathBuf, fs::Metadata)], threads: usize) -> Vec<FileProbe> {
    let threads = threads.min(batch.len());
    if threads <= 1 {
        return batch.iter().map(|(path, _)| probe_file(path)).collect();
    }
    let chunk_len = batch.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let workers: Vec<_> = batch
            .chunks(chunk_len)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|(path, _)| probe_file(path))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}

#[cfg(windows)]
fn allocation_unit_size(root: &Path) -> Option<u64> {
    let wide = wide_path(root);
    let mut sectors_per_cluster = 0u32;
    let mut bytes_per_sector = 0u32;
    let mut free_clusters = 0u32;
    let mut total_clusters = 0u32;
    // SAFETY: all pointers are valid for the duration of the call and the path is NUL-terminated.
    let success = unsafe {
        GetDiskFreeSpaceW(
            wide.as_ptr(),
            &mut sectors_per_cluster,
            &mut bytes_per_sector,
            &mut free_clusters,
            &mut total_clusters,
        )
    };
    (success != 0)
        .then(|| u64::from(sectors_per_cluster) * u64::from(bytes_per_sector))
        .filter(|size| *size > 0)
}

#[cfg(not(windows))]
fn allocation_unit_size(_root: &Path) -> Option<u64> {
    None
}

#[cfg(windows)]
fn allocated_size(path: &Path, logical_bytes: u64, cluster_size: u64) -> u64 {
    let wide = wide_path(path);
    let mut high = 0u32;
    // SAFETY: the path is NUL-terminated and `high` points to writable memory.
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    // INVALID_FILE_SIZE is only an error when GetLastError reports one.
    if low != u32::MAX || unsafe { GetLastError() } == 0 {
        (u64::from(high) << 32) | u64::from(low)
    } else {
        round_up_to_cluster(logical_bytes, cluster_size)
    }
}

#[cfg(not(windows))]
fn allocated_size(_path: &Path, logical_bytes: u64, cluster_size: u64) -> u64 {
    round_up_to_cluster(logical_bytes, cluster_size)
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

fn round_up_to_cluster(bytes: u64, cluster_size: u64) -> u64 {
    if bytes == 0 || cluster_size == 0 {
        return bytes;
    }
    bytes.saturating_add(cluster_size - 1) / cluster_size * cluster_size
}

fn file_record(path: &Path, metadata: &fs::Metadata, allocated_bytes: u64) -> LargeFile {
    LargeFile {
        path: path_string(path),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size_bytes: allocated_bytes,
        logical_bytes: metadata.len(),
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
        logical_bytes: aggregate.logical_bytes,
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
                logical_bytes: 42,
                files: 2,
            },
        );
        assert_eq!(item.parent.as_deref(), Some(r"C:\Users"));
        assert_eq!(item.depth, 2);
    }

    #[test]
    fn cluster_rounding_matches_allocated_space_behavior() {
        assert_eq!(round_up_to_cluster(10, 4096), 4096);
        assert_eq!(round_up_to_cluster(4096, 4096), 4096);
        assert_eq!(round_up_to_cluster(4097, 4096), 8192);
    }

    #[cfg(windows)]
    #[test]
    fn skips_only_the_root_windows_directory() {
        assert!(is_windows_system_directory(Path::new(r"C:\Windows")));
        assert!(!is_windows_system_directory(Path::new(r"C:\Program Files")));
        assert!(!is_windows_system_directory(Path::new(r"C:\Windows\Temp")));
    }

    #[cfg(windows)]
    #[test]
    fn hard_links_resolve_to_the_same_physical_file_id() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.bin");
        let linked = temp.path().join("linked.bin");
        fs::write(&original, b"same physical bytes").unwrap();
        fs::hard_link(&original, &linked).unwrap();

        let original_id = probe_file(&original).id;
        assert!(original_id.is_some());
        assert_eq!(original_id, probe_file(&linked).id);
    }

    #[cfg(windows)]
    #[test]
    fn parallel_probe_keeps_the_order_of_the_batch() {
        let temp = tempfile::tempdir().unwrap();
        let batch: Vec<(PathBuf, fs::Metadata)> = (0..40)
            .map(|index| {
                let path = temp.path().join(format!("file-{index}.bin"));
                fs::write(&path, vec![1u8; index * 3]).unwrap();
                let metadata = fs::metadata(&path).unwrap();
                (path, metadata)
            })
            .collect();

        let parallel = probe_batch(&batch, 4);
        let sequential: Vec<_> = batch.iter().map(|(path, _)| probe_file(path)).collect();
        assert_eq!(parallel.len(), batch.len());
        for (left, right) in parallel.iter().zip(&sequential) {
            assert_eq!(left.id, right.id);
            assert_eq!(left.allocated, right.allocated);
        }
    }

    #[cfg(windows)]
    #[test]
    fn probe_reports_the_same_size_as_get_compressed_file_size() {
        let temp = tempfile::tempdir().unwrap();
        for (name, length) in [("empty.bin", 0usize), ("small.bin", 10), ("mid.bin", 5000)] {
            let path = temp.path().join(name);
            fs::write(&path, vec![7u8; length]).unwrap();
            if let Some(allocated) = probe_file(&path).allocated {
                assert_eq!(
                    allocated,
                    allocated_size(&path, length as u64, 4096),
                    "{name}"
                );
            }
        }
    }
}

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LibraryView =
  "all" | "recent" | "favorites" | "videos" | "screenshots";

export interface MediaFilter {
  view: LibraryView;
  query: string;
  folder: string | null;
  recursive: boolean;
  sort: "date" | "name";
}

export interface MediaItem {
  id: number;
  sourceId: number;
  path: string;
  fileName: string;
  folderPath: string;
  extension: string;
  mediaType: "photo" | "video";
  width: number | null;
  height: number | null;
  fileSize: number;
  modifiedAt: number;
  /** Unix seconds. */
  capturedAt: number;
  addedAt: number;
  favorite: boolean;
  screenshot: boolean;
  available: boolean;
}

export interface DayGroup {
  day: string;
  count: number;
}

export interface LibraryLayout {
  total: number;
  groups: DayGroup[];
}

export interface SourceRecord {
  id: number;
  path: string;
  name: string;
  available: boolean;
  mediaCount: number;
  lastScannedAt: number | null;
  scanning: boolean;
}

export interface FolderNode {
  path: string;
  name: string;
  parent: string | null;
  sourceId: number;
  directCount: number;
  totalCount: number;
  isRoot: boolean;
  available: boolean;
  coverId: number | null;
}

export interface ScanProgress {
  sourceId: number;
  sourceName: string;
  scanned: number;
  indexed: number;
  currentFile: string;
  state: "scanning" | "paused" | "finished" | "cancelled" | "failed";
  message: string | null;
}

export interface LibraryStats {
  total: number;
  favorites: number;
  videos: number;
  screenshots: number;
  cacheBytes: number;
}

export interface DiskRoot {
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  removable: boolean;
  kind: string;
}

export interface FolderUsage {
  path: string;
  parent: string | null;
  name: string;
  sizeBytes: number;
  logicalBytes: number;
  fileCount: number;
  depth: number;
}

export interface LargeFile {
  path: string;
  name: string;
  sizeBytes: number;
  logicalBytes: number;
  modifiedAt: number;
  extension: string;
}

export interface CleanupRecommendation {
  category: "temporary" | "downloads" | "large-file";
  title: string;
  explanation: string;
  path: string;
  sizeBytes: number;
  risk: "low" | "review";
  fileCount: number;
}

export interface DiskAnalysis {
  root: string;
  totalBytes: number;
  logicalBytes: number;
  fileCount: number;
  inaccessibleCount: number;
  folders: FolderUsage[];
  largestFiles: LargeFile[];
  recommendations: CleanupRecommendation[];
  elapsedMs: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface DiskScanProgress {
  root: string;
  currentPath: string;
  fileCount: number;
  scannedBytes: number;
  finished: boolean;
  cancelled: boolean;
}

export interface MetaField {
  label: string;
  value: string;
}

export type Settings = Record<string, string>;

/** Backend errors arrive as plain strings; surface them as real Error objects. */
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

export const api = {
  listSources: () => call<SourceRecord[]>("list_sources"),
  addSource: (path: string) => call<SourceRecord>("add_source", { path }),
  removeSource: (sourceId: number) => call<void>("remove_source", { sourceId }),
  rescanSource: (sourceId: number) => call<void>("rescan_source", { sourceId }),
  rescanAll: () => call<void>("rescan_all"),
  relinkSource: (sourceId: number, path: string) =>
    call<SourceRecord>("relink_source", { sourceId, path }),
  pauseScans: () => call<void>("pause_scans"),
  resumeScans: () => call<void>("resume_scans"),
  cancelScans: () => call<void>("cancel_scans"),
  scanState: () => call<{ active: boolean; paused: boolean }>("scan_state"),

  listMedia: (filter: MediaFilter, offset: number, limit: number) =>
    call<MediaItem[]>("list_media", { filter, offset, limit }),
  layout: (filter: MediaFilter) =>
    call<LibraryLayout>("library_layout", { filter }),
  position: (filter: MediaFilter, mediaId: number) =>
    call<number | null>("media_position", { filter, mediaId }),
  ids: (filter: MediaFilter, offset: number, limit: number) =>
    call<number[]>("media_ids", { filter, offset, limit }),
  getMedia: (mediaId: number) =>
    call<MediaItem | null>("get_media", { mediaId }),
  exif: (mediaId: number) => call<MetaField[]>("media_exif", { mediaId }),
  setFavorites: (ids: number[], value: boolean) =>
    call<boolean>("set_favorites", { ids, value }),
  toggleFavorite: (mediaId: number) =>
    call<boolean>("toggle_favorite", { mediaId }),
  stats: () => call<LibraryStats>("library_stats"),
  reveal: (path: string) => call<void>("reveal_in_explorer", { path }),
  trash: (ids: number[]) => call<number>("trash_media", { ids }),
  folderTree: () => call<FolderNode[]>("folder_tree"),

  settings: () => call<Settings>("get_settings"),
  setSetting: (key: string, value: string) =>
    call<void>("set_setting", { key, value }),
  clearCache: () => call<void>("clear_thumbnail_cache"),
  listDisks: () => call<DiskRoot[]>("list_disks"),
  analyzeDisk: (path: string) => call<DiskAnalysis>("analyze_disk", { path }),
  cancelDiskScan: () => call<void>("cancel_disk_scan"),
  openDiskPath: (path: string) => call<void>("open_disk_path", { path }),
};

/** `framer-thumb://` thumbnail for a media item; the version busts the cache when the file changes. */
export function thumbUrl(item: Pick<MediaItem, "id" | "modifiedAt">): string {
  return `${convertFileSrc(String(item.id), "framer-thumb")}?v=${item.modifiedAt}`;
}

export function thumbUrlForId(id: number): string {
  return convertFileSrc(String(id), "framer-thumb");
}

/** Original file, loaded straight from disk through Tauri's scoped asset protocol. */
export function originalUrl(item: Pick<MediaItem, "path">): string {
  return convertFileSrc(item.path);
}

export type AppEvent =
  | "scan-progress"
  | "library-changed"
  | "sources-changed"
  | "disk-scan-progress";

export function onEvent<T = unknown>(
  name: AppEvent,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (event) => handler(event.payload));
}

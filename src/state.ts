import type {
  FolderNode,
  LibraryStats,
  LibraryView,
  ScanProgress,
  Settings,
  SourceRecord,
} from "./lib/api";

export type ViewId = LibraryView | "folders" | "sources" | "disk" | "settings";

export interface Route {
  view: ViewId;
  /** Folder being browsed (folders view only). */
  folder?: string;
  /** Media item to scroll to and select once the view has loaded. */
  focusId?: number;
}

export type BusEvent =
  "route" | "sources" | "stats" | "folders" | "scan" | "settings" | "library";

type Listener = () => void;

class Bus {
  private listeners = new Map<BusEvent, Set<Listener>>();

  on(event: BusEvent, listener: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event: BusEvent): void {
    this.listeners.get(event)?.forEach((listener) => listener());
  }
}

export const bus = new Bus();

export const state = {
  route: { view: "all" } as Route,
  sources: [] as SourceRecord[],
  stats: {
    total: 0,
    favorites: 0,
    videos: 0,
    screenshots: 0,
    cacheBytes: 0,
  } as LibraryStats,
  folders: [] as FolderNode[],
  settings: {} as Settings,
  scan: {
    progress: new Map<number, ScanProgress>(),
    startedAt: new Map<number, number>(),
    paused: false,
    /** Set briefly after a scan that changed the library, for the "Library updated" note. */
    lastSummary: null as null | { indexed: number; at: number },
  },
};

export function routeKey(route: Route): string {
  return route.view === "folders"
    ? `folders:${route.folder ?? ""}`
    : route.view;
}

export const GRID_MIN = 120;
export const GRID_MAX = 260;

export function gridSize(): number {
  const value = Number(state.settings.gridSize);
  return Number.isFinite(value)
    ? Math.min(GRID_MAX, Math.max(GRID_MIN, value))
    : 184;
}

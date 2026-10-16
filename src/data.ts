import { api } from "./lib/api";
import { bus, state } from "./state";

/** Small loaders that refresh shared state and tell interested views about it. */

export async function refreshSources(): Promise<void> {
  state.sources = await api.listSources();
  bus.emit("sources");
}

export async function refreshStats(): Promise<void> {
  state.stats = await api.stats();
  bus.emit("stats");
}

export async function refreshFolders(): Promise<void> {
  state.folders = await api.folderTree();
  bus.emit("folders");
}

export async function refreshSettings(): Promise<void> {
  state.settings = await api.settings();
  bus.emit("settings");
}

const saveTimers = new Map<string, number>();

/** Apply a setting immediately and persist it shortly after, so dragging a slider is cheap. */
export async function saveSetting(key: string, value: string): Promise<void> {
  state.settings = { ...state.settings, [key]: value };
  bus.emit("settings");
  window.clearTimeout(saveTimers.get(key));
  saveTimers.set(
    key,
    window.setTimeout(() => void api.setSetting(key, value).catch(() => undefined), 200),
  );
}

/** Counts and folder structure changed (for example after favoriting); the open view is already current. */
export async function refreshCounts(): Promise<void> {
  await Promise.all([refreshStats(), refreshFolders()]);
}

/** Files were added or removed behind the open view's back (a scan, a new source): views reload. */
export async function refreshLibrary(): Promise<void> {
  await Promise.all([refreshStats(), refreshFolders(), refreshSources()]);
  bus.emit("library");
}

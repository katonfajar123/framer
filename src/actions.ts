import { open } from "@tauri-apps/plugin-dialog";
import { refreshLibrary } from "./data";
import { api, type SourceRecord } from "./lib/api";
import { navigate } from "./router";
import { state } from "./state";
import { confirmDialog } from "./ui/dialog";
import { toast } from "./ui/toast";

/** Pick a folder with the native Windows dialog and start indexing it in place. */
export async function addFolder(): Promise<void> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Choose a photo folder",
  });
  if (!chosen || Array.isArray(chosen)) return;
  try {
    const hadSources = state.sources.length > 0;
    await api.addSource(chosen);
    await refreshLibrary();
    toast("Folder added. Photos appear as they are indexed.");
    if (!hadSources || state.route.view === "sources")
      navigate({ view: hadSources ? "sources" : "all" });
  } catch (error) {
    toast(String(error), "error");
  }
}

/** Point a source at a new location after a drive letter changed or a folder moved. */
export async function locateFolder(source: SourceRecord): Promise<void> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: `Locate “${source.name}”`,
  });
  if (!chosen || Array.isArray(chosen)) return;
  try {
    await api.relinkSource(source.id, chosen);
    await refreshLibrary();
    toast(`“${source.name}” now points to ${chosen}`);
  } catch (error) {
    toast(String(error), "error");
  }
}

/** Forget a source. Only Framer's index is removed; files on disk are never touched. */
export async function removeSource(source: SourceRecord): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Remove “${source.name}” from Framer?`,
    message:
      `Framer will stop watching ${source.path} and forget its ${source.mediaCount.toLocaleString()} indexed items. ` +
      "Your original files stay exactly where they are, and favorites are kept if you add the folder again.",
    confirmLabel: "Remove from Framer",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.removeSource(source.id);
    await refreshLibrary();
    toast("Source removed. No files were deleted.");
  } catch (error) {
    toast(String(error), "error");
  }
}

export async function rescan(source: SourceRecord): Promise<void> {
  try {
    await api.rescanSource(source.id);
  } catch (error) {
    toast(String(error), "error");
  }
}

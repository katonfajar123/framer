import { refreshSources } from "./data";
import type { ScanProgress } from "./lib/api";
import { bus, state } from "./state";
import { toast } from "./ui/toast";

const SUMMARY_MS = 4000;

/** Fold backend scan events into shared state for the sidebar status and the sources page. */
export function handleScanProgress(progress: ScanProgress): void {
  const { scan } = state;
  const active = progress.state === "scanning" || progress.state === "paused";
  const known = scan.progress.has(progress.sourceId);
  if (active) {
    scan.progress.set(progress.sourceId, progress);
    if (!scan.startedAt.has(progress.sourceId)) scan.startedAt.set(progress.sourceId, Date.now());
  } else {
    scan.progress.delete(progress.sourceId);
    scan.startedAt.delete(progress.sourceId);
    if (progress.state === "finished" && progress.indexed > 0) {
      scan.lastSummary = { indexed: progress.indexed, at: Date.now() };
      window.setTimeout(() => {
        if (scan.lastSummary && Date.now() - scan.lastSummary.at >= SUMMARY_MS - 50) {
          scan.lastSummary = null;
          bus.emit("scan");
        }
      }, SUMMARY_MS);
    }
    if (progress.state === "failed" && progress.message) toast(progress.message, "error");
  }
  scan.paused = [...scan.progress.values()].some((entry) => entry.state === "paused");
  bus.emit("scan");
  if (known !== active) void refreshSources(); // the "scanning" flag on source rows changed
}

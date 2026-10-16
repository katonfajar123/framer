import type { DiskAnalysis, DiskScanProgress } from "../lib/api";

export type DiskTab = "folders" | "files" | "recommendations";

export interface DiskSessionState {
  analysis: DiskAnalysis | null;
  /** Epoch milliseconds when `analysis` finished. */
  completedAt: number | null;
  scanning: boolean;
  progress: DiskScanProgress | null;
  currentPath: string;
  tab: DiskTab;
}

export interface DiskSessionDeps {
  analyze(path: string): Promise<DiskAnalysis>;
  cancel(): void;
  notify(message: string, kind?: "info" | "error"): void;
  now?(): number;
}

/** `progress` only needs a text update, `state` needs a full re-render. */
export type DiskSessionChange = "state" | "progress";

/**
 * Keeps the Disk Usage scan and its result alive while the view itself is created and
 * destroyed by the shell. Leaving the screen neither cancels a running scan nor throws away
 * a finished one.
 */
export function createDiskSession(deps: DiskSessionDeps) {
  const now = deps.now ?? Date.now;
  const listeners = new Set<(change: DiskSessionChange) => void>();
  let state: DiskSessionState = {
    analysis: null,
    completedAt: null,
    scanning: false,
    progress: null,
    currentPath: "",
    tab: "folders",
  };
  /** Bumped on every start and cancel so a late answer from an older scan is ignored. */
  let run = 0;

  const update = (patch: Partial<DiskSessionState>, change: DiskSessionChange = "state") => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(change);
  };

  return {
    get state(): DiskSessionState {
      return state;
    },

    subscribe(listener: (change: DiskSessionChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(path: string): Promise<void> {
      const id = ++run;
      update({ scanning: true, progress: null, analysis: null, completedAt: null });
      try {
        const result = await deps.analyze(path);
        if (id !== run) return;
        if (result.cancelled) {
          deps.notify("Disk analysis cancelled");
          return;
        }
        update({
          analysis: result,
          completedAt: now(),
          currentPath: result.root,
          tab: "folders",
        });
      } catch (error) {
        if (id === run) deps.notify(String(error), "error");
      } finally {
        if (id === run) update({ scanning: false, progress: null });
      }
    },

    cancel(): void {
      if (!state.scanning) return;
      run += 1;
      deps.cancel();
      update({ scanning: false, progress: null });
      deps.notify("Disk analysis cancelled");
    },

    reportProgress(next: DiskScanProgress): void {
      if (!state.scanning) return;
      update({ progress: next }, "progress");
    },

    setPath(path: string): void {
      update({ currentPath: path });
    },

    setTab(tab: DiskTab): void {
      update({ tab });
    },

    /** Back to the drive picker. */
    reset(): void {
      update({ analysis: null, completedAt: null, currentPath: "", tab: "folders" });
    },
  };
}

export type DiskSession = ReturnType<typeof createDiskSession>;

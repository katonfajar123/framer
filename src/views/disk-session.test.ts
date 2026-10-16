import { describe, expect, it, vi } from "vitest";
import type { DiskAnalysis, DiskScanProgress } from "../lib/api";
import { createDiskSession } from "./disk-session";

const analysis = (root: string, patch: Partial<DiskAnalysis> = {}): DiskAnalysis => ({
  root,
  totalBytes: 10,
  logicalBytes: 10,
  fileCount: 1,
  inaccessibleCount: 0,
  folders: [],
  largestFiles: [],
  recommendations: [],
  elapsedMs: 5,
  truncated: false,
  cancelled: false,
  ...patch,
});

const progress = (fileCount: number): DiskScanProgress => ({
  root: "C:\\",
  currentPath: "C:\\a",
  fileCount,
  scannedBytes: fileCount * 10,
  finished: false,
  cancelled: false,
});

/** A promise the test resolves by hand, to model a scan that takes a while. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(analyze = vi.fn(async (path: string) => analysis(path))) {
  const cancel = vi.fn();
  const notify = vi.fn();
  const session = createDiskSession({ analyze, cancel, notify, now: () => 1_000 });
  return { session, analyze, cancel, notify };
}

describe("disk session", () => {
  it("keeps a finished scan when the view is destroyed and created again", async () => {
    const { session, analyze } = setup();
    const firstView = vi.fn();
    const stopFirstView = session.subscribe(firstView);

    await session.start("C:\\");
    stopFirstView();

    const secondView = vi.fn();
    session.subscribe(secondView);
    expect(session.state.analysis?.root).toBe("C:\\");
    expect(session.state.scanning).toBe(false);
    expect(session.state.completedAt).toBe(1_000);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("finishes a scan that was started before the view was destroyed", async () => {
    const pending = deferred<DiskAnalysis>();
    const { session, cancel } = setup(vi.fn(() => pending.promise));
    const view = vi.fn();
    const stopView = session.subscribe(view);

    const started = session.start("D:\\");
    expect(session.state.scanning).toBe(true);
    stopView();
    expect(cancel).not.toHaveBeenCalled();

    pending.resolve(analysis("D:\\"));
    await started;
    expect(session.state.analysis?.root).toBe("D:\\");
    expect(session.state.scanning).toBe(false);
  });

  it("reports progress only while scanning", async () => {
    const pending = deferred<DiskAnalysis>();
    const { session } = setup(vi.fn(() => pending.promise));
    const changes: string[] = [];
    session.subscribe((change) => changes.push(change));

    session.reportProgress(progress(1));
    expect(session.state.progress).toBeNull();

    const started = session.start("C:\\");
    session.reportProgress(progress(750));
    expect(session.state.progress?.fileCount).toBe(750);
    expect(changes).toContain("progress");

    pending.resolve(analysis("C:\\"));
    await started;
    session.reportProgress(progress(1_500));
    expect(session.state.progress).toBeNull();
  });

  it("ignores the late answer of a scan that was cancelled", async () => {
    const pending = deferred<DiskAnalysis>();
    const { session, cancel, notify } = setup(vi.fn(() => pending.promise));

    const started = session.start("C:\\");
    session.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(session.state.scanning).toBe(false);

    pending.resolve(analysis("C:\\"));
    await started;
    expect(session.state.analysis).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Disk analysis cancelled");
  });

  it("does nothing when cancelling while idle", () => {
    const { session, cancel, notify } = setup();
    session.cancel();
    expect(cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops a result the backend marks as cancelled", async () => {
    const { session, notify } = setup(
      vi.fn(async (path: string) => analysis(path, { cancelled: true })),
    );
    await session.start("C:\\");
    expect(session.state.analysis).toBeNull();
    expect(session.state.scanning).toBe(false);
    expect(notify).toHaveBeenCalledWith("Disk analysis cancelled");
  });

  it("reports an error and leaves the scanning state", async () => {
    const { session, notify } = setup(
      vi.fn(async () => {
        throw new Error("That drive or folder is unavailable");
      }),
    );
    await session.start("Z:\\");
    expect(session.state.scanning).toBe(false);
    expect(session.state.analysis).toBeNull();
    expect(notify).toHaveBeenCalledWith("Error: That drive or folder is unavailable", "error");
  });

  it("lets the newest scan win when a second one starts", async () => {
    const first = deferred<DiskAnalysis>();
    const second = deferred<DiskAnalysis>();
    const analyze = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { session } = setup(analyze);

    const one = session.start("C:\\");
    const two = session.start("D:\\");
    second.resolve(analysis("D:\\"));
    await two;
    first.resolve(analysis("C:\\"));
    await one;

    expect(session.state.analysis?.root).toBe("D:\\");
    expect(session.state.scanning).toBe(false);
  });

  it("scans again from the same root and clears the old result first", async () => {
    const pending = deferred<DiskAnalysis>();
    const analyze = vi
      .fn()
      .mockResolvedValueOnce(analysis("C:\\"))
      .mockReturnValueOnce(pending.promise);
    const { session } = setup(analyze);

    await session.start("C:\\");
    const again = session.start(session.state.analysis!.root);
    expect(session.state.analysis).toBeNull();
    expect(session.state.scanning).toBe(true);

    pending.resolve(analysis("C:\\", { fileCount: 2 }));
    await again;
    expect(session.state.analysis?.fileCount).toBe(2);
  });

  it("remembers the folder and tab the user was looking at", async () => {
    const { session } = setup();
    await session.start("C:\\");
    session.setPath("C:\\Users");
    session.setTab("files");
    expect(session.state.currentPath).toBe("C:\\Users");
    expect(session.state.tab).toBe("files");
  });

  it("returns to the drive picker on reset", async () => {
    const { session } = setup();
    await session.start("C:\\");
    session.reset();
    expect(session.state.analysis).toBeNull();
    expect(session.state.currentPath).toBe("");
  });

  it("stops notifying a view that unsubscribed", async () => {
    const { session } = setup();
    const view = vi.fn();
    const stop = session.subscribe(view);
    stop();
    await session.start("C:\\");
    expect(view).not.toHaveBeenCalled();
  });
});

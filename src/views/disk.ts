import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  onEvent,
  type CleanupRecommendation,
  type DiskAnalysis,
  type DiskRoot,
  type DiskScanProgress,
  type FolderUsage,
  type LargeFile,
} from "../lib/api";
import { h, mount } from "../lib/dom";
import {
  folderName,
  formatBytes,
  formatCount,
  formatDateTime,
  plural,
  timeAgo,
} from "../lib/format";
import { icon } from "../lib/icons";
import { toast } from "../ui/toast";
import { createDiskSession, type DiskTab } from "./disk-session";
import type { View } from "./view";

type Tab = DiskTab;

/** Lives as long as the app, so a scan and its result survive switching to other screens. */
const session = createDiskSession({
  analyze: (path) => api.analyzeDisk(path),
  cancel: () => void api.cancelDiskScan(),
  notify: (message, kind) => toast(message, kind),
});

let listeningForProgress = false;
function listenForProgress(): void {
  if (listeningForProgress) return;
  listeningForProgress = true;
  void onEvent<DiskScanProgress>("disk-scan-progress", (next) =>
    session.reportProgress(next),
  ).catch(() => {
    listeningForProgress = false;
  });
}

const key = (path: string) =>
  path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const percent = (value: number, total: number) =>
  Math.max(0, Math.min(100, total ? (value / total) * 100 : 0));

function driveCard(
  drive: DiskRoot,
  analyze: (path: string) => void,
): HTMLElement {
  const used = drive.totalBytes - drive.freeBytes;
  const usedPercent = percent(used, drive.totalBytes);
  const label = drive.path.replace(/[\\/]+$/, "") || drive.path;
  return h(
    "button",
    {
      class: "disk-card",
      type: "button",
      title: `Analyze ${drive.path}`,
      onclick: () => analyze(drive.path),
    },
    h(
      "div",
      { class: "disk-card-icon" },
      icon(drive.removable ? "unplug" : "drive", 23),
    ),
    h(
      "div",
      { class: "disk-card-copy" },
      h("strong", null, label),
      h(
        "span",
        null,
        drive.name && drive.name !== label
          ? drive.name
          : drive.removable
            ? "Removable drive"
            : "Local disk",
      ),
      h(
        "div",
        {
          class: "disk-meter",
          aria: { label: `${usedPercent.toFixed(0)} percent used` },
        },
        h("i", { style: `width:${usedPercent}%` }),
      ),
      h(
        "small",
        null,
        `${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)}`,
      ),
    ),
    icon("chevron-right", 17),
  );
}

function scanningView(
  progress: DiskScanProgress | null,
  cancel: () => void,
): HTMLElement {
  return h(
    "div",
    { class: "disk-scanning", role: "status", aria: { live: "polite" } },
    h("div", { class: "scan-orbit" }, icon("disk", 34)),
    h("h1", null, "Analyzing disk usage"),
    h(
      "p",
      null,
      "Framer counts unique files and allocated space only. C:\\Windows, links, and junctions are excluded.",
    ),
    h(
      "div",
      { class: "disk-scan-stats" },
      h(
        "strong",
        null,
        progress ? plural(progress.fileCount, "file") : "Preparing scan…",
      ),
      h("span", null, progress ? formatBytes(progress.scannedBytes) : ""),
    ),
    h(
      "div",
      { class: "disk-scan-path", title: progress?.currentPath ?? "" },
      progress?.currentPath ?? "Opening folder…",
    ),
    h("div", { class: "disk-indeterminate" }, h("i")),
    h(
      "button",
      { class: "subtle", type: "button", onclick: cancel },
      "Cancel Scan",
    ),
  );
}

function breadcrumb(
  analysis: DiskAnalysis,
  current: string,
  go: (path: string) => void,
): HTMLElement {
  const byPath = new Map(
    analysis.folders.map((folder) => [key(folder.path), folder]),
  );
  const chain: FolderUsage[] = [];
  let folder = byPath.get(key(current));
  while (folder) {
    chain.unshift(folder);
    folder = folder.parent ? byPath.get(key(folder.parent)) : undefined;
  }
  if (!chain.length)
    chain.push({
      path: analysis.root,
      parent: null,
      name: folderName(analysis.root),
      sizeBytes: analysis.totalBytes,
      logicalBytes: analysis.logicalBytes,
      fileCount: analysis.fileCount,
      depth: 0,
    });
  return h(
    "nav",
    {
      class: "breadcrumb disk-breadcrumb",
      aria: { label: "Analyzed folder path" },
    },
    ...chain.flatMap((item, index) => [
      index
        ? h("span", { class: "crumb-sep" }, icon("chevron-right", 12))
        : null,
      index === chain.length - 1
        ? h(
            "span",
            { class: "crumb-current", aria: { current: "page" } },
            item.name,
          )
        : h(
            "button",
            { type: "button", onclick: () => go(item.path) },
            item.name,
          ),
    ]),
  );
}

function folderTable(
  analysis: DiskAnalysis,
  current: string,
  go: (path: string) => void,
): HTMLElement {
  const currentKey = key(current);
  const currentFolder = analysis.folders.find(
    (folder) => key(folder.path) === currentKey,
  );
  const total = currentFolder?.sizeBytes ?? analysis.totalBytes;
  const children = analysis.folders
    .filter((folder) => folder.parent && key(folder.parent) === currentKey)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (!children.length) {
    return h(
      "div",
      { class: "disk-empty" },
      icon("folder-tree", 34),
      h("strong", null, "No subfolders found"),
      h(
        "span",
        null,
        "This folder's space is used by files directly inside it.",
      ),
    );
  }
  return h(
    "div",
    { class: "usage-table" },
    h(
      "div",
      { class: "usage-head" },
      h("span", null, "Folder"),
      h("span", null, "Files"),
      h("span", null, "Size"),
    ),
    ...children.map((folder) =>
      h(
        "button",
        {
          class: "usage-row",
          type: "button",
          title: folder.path,
          onclick: () => go(folder.path),
        },
        h(
          "span",
          { class: "usage-folder" },
          icon("folder", 18),
          h("span", null, folder.name),
          icon("chevron-right", 14),
        ),
        h("span", { class: "usage-files" }, formatCount(folder.fileCount)),
        h(
          "span",
          { class: "usage-size" },
          h("b", null, formatBytes(folder.sizeBytes)),
          h("small", null, `${percent(folder.sizeBytes, total).toFixed(1)}%`),
        ),
        h(
          "span",
          { class: "usage-bar" },
          h("i", { style: `width:${percent(folder.sizeBytes, total)}%` }),
        ),
      ),
    ),
  );
}

function fileTable(
  files: LargeFile[],
  reveal: (path: string) => void,
): HTMLElement {
  if (!files.length)
    return h(
      "div",
      { class: "disk-empty" },
      icon("file-warning", 34),
      h("strong", null, "No files over 100 MB"),
      h(
        "span",
        null,
        "This scan did not find unusually large individual files.",
      ),
    );
  return h(
    "div",
    { class: "large-files" },
    ...files.map((file, index) =>
      h(
        "div",
        { class: "large-file-row" },
        h("span", { class: "file-rank" }, String(index + 1)),
        h(
          "div",
          { class: "file-copy" },
          h("strong", { title: file.name }, file.name),
          h("span", { title: file.path }, file.path),
          h("small", null, `Modified ${formatDateTime(file.modifiedAt)}`),
        ),
        h(
          "div",
          { class: "file-size" },
          h("b", null, formatBytes(file.sizeBytes)),
          file.logicalBytes !== file.sizeBytes
            ? h("small", null, `${formatBytes(file.logicalBytes)} logical`)
            : null,
        ),
        h(
          "button",
          {
            class: "icon-button",
            type: "button",
            title: "Open location",
            aria: { label: `Open location of ${file.name}` },
            onclick: () => reveal(file.path),
          },
          icon("external", 16),
        ),
      ),
    ),
  );
}

function recommendationCard(
  item: CleanupRecommendation,
  reveal: (path: string) => void,
): HTMLElement {
  return h(
    "article",
    { class: `recommendation ${item.risk}` },
    h(
      "div",
      { class: "recommendation-icon" },
      icon(item.risk === "low" ? "refresh" : "file-warning", 20),
    ),
    h(
      "div",
      { class: "recommendation-copy" },
      h(
        "div",
        { class: "recommendation-title" },
        h("strong", null, item.title),
        h(
          "span",
          { class: `risk ${item.risk}` },
          item.risk === "low" ? "Usually safe to review" : "Review carefully",
        ),
      ),
      h("p", null, item.explanation),
      h("small", { title: item.path }, item.path),
      h(
        "div",
        { class: "recommendation-meta" },
        h("b", null, formatBytes(item.sizeBytes)),
        h("span", null, plural(item.fileCount, "file")),
      ),
    ),
    h(
      "button",
      { class: "subtle", type: "button", onclick: () => reveal(item.path) },
      icon("external", 15),
      "Open Location",
    ),
  );
}

export function createDiskView(scroller: HTMLElement): View {
  let disks: DiskRoot[] = [];
  let disposed = false;
  listenForProgress();

  const reveal = (path: string) =>
    void api.openDiskPath(path).catch((error) => toast(String(error), "error"));
  const cancel = () => session.cancel();
  const analyze = (path: string) => {
    void session.start(path);
  };
  const chooseFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a drive or folder to analyze",
    });
    if (selected) analyze(selected);
  };
  const go = (path: string) => session.setPath(path);

  const renderLanding = () =>
    h(
      "div",
      { class: "page disk-page" },
      h(
        "div",
        { class: "page-heading" },
        h(
          "div",
          null,
          h("h1", null, "Disk Usage"),
          h(
            "p",
            null,
            "Analyze apps, ProgramData, and personal files. C:\\Windows is excluded.",
          ),
        ),
        h(
          "button",
          { class: "subtle", type: "button", onclick: chooseFolder },
          icon("folder-search", 16),
          "Analyze Folder…",
        ),
      ),
      h(
        "div",
        { class: "disk-privacy" },
        icon("shield", 18),
        h(
          "p",
          null,
          h("strong", null, "Read-only analysis."),
          " Framer reads names, sizes, and modified dates locally. It counts hard links once, skips links and junctions, excludes C:\\Windows, and never uploads, moves, or deletes anything.",
        ),
      ),
      h("h2", { class: "disk-section-title" }, "Drives on this PC"),
      disks.length
        ? h(
            "div",
            { class: "disk-grid" },
            ...disks.map((drive) => driveCard(drive, analyze)),
          )
        : h(
            "div",
            { class: "disk-empty" },
            icon("drive", 34),
            h("strong", null, "No drives detected"),
          ),
    );

  const renderResults = (result: DiskAnalysis) => {
    const { currentPath, tab, completedAt } = session.state;
    const drive = disks.find((item) =>
      key(result.root).startsWith(key(item.path)),
    );
    const capacity = drive?.totalBytes ?? result.totalBytes;
    const used = drive ? drive.totalBytes - drive.freeBytes : result.totalBytes;
    const children = result.folders.filter(
      (folder) => folder.parent && key(folder.parent) === key(currentPath),
    );
    const largestChild = children.reduce<FolderUsage | null>(
      (largest, folder) =>
        !largest || folder.sizeBytes > largest.sizeBytes ? folder : largest,
      null,
    );
    const body =
      tab === "folders"
        ? folderTable(result, currentPath, go)
        : tab === "files"
          ? fileTable(result.largestFiles, reveal)
          : h(
              "div",
              { class: "recommendations" },
              result.recommendations.length
                ? result.recommendations.map((item) =>
                    recommendationCard(item, reveal),
                  )
                : h(
                    "div",
                    { class: "disk-empty" },
                    icon("shield", 34),
                    h("strong", null, "No responsible cleanup suggestions"),
                    h(
                      "span",
                      null,
                      "Framer won't guess that personal or system files are disposable.",
                    ),
                  ),
            );
    return h(
      "div",
      { class: "page disk-page results" },
      h(
        "div",
        { class: "page-heading" },
        h(
          "div",
          null,
          h("h1", null, "Disk Usage"),
          h("p", { title: result.root }, result.root),
        ),
        h(
          "div",
          { class: "heading-actions" },
          h(
            "button",
            {
              class: "subtle",
              type: "button",
              onclick: () => reveal(currentPath),
            },
            icon("external", 15),
            "Open in Explorer",
          ),
          h(
            "button",
            {
              class: "subtle",
              type: "button",
              onclick: () => analyze(result.root),
            },
            "Scan Again",
          ),
          h(
            "button",
            {
              class: "subtle",
              type: "button",
              onclick: () => session.reset(),
            },
            "Analyze Another",
          ),
        ),
      ),
      h(
        "div",
        { class: "disk-summary" },
        h(
          "div",
          { class: "usage-ring", style: `--usage:${percent(used, capacity)}%` },
          h("span", null, `${percent(used, capacity).toFixed(0)}%`),
          h("small", null, "used"),
        ),
        h(
          "div",
          { class: "summary-stat" },
          h("span", null, "Allocated on disk"),
          h("strong", null, formatBytes(result.totalBytes)),
          h(
            "small",
            null,
            `${formatBytes(result.logicalBytes)} logical · ${plural(result.fileCount, "unique file")}`,
          ),
        ),
        h(
          "div",
          { class: "summary-stat" },
          h("span", null, "Largest area here"),
          h(
            "strong",
            null,
            largestChild ? formatBytes(largestChild.sizeBytes) : "—",
          ),
          h("small", null, largestChild?.name ?? "No subfolder"),
        ),
        h(
          "div",
          { class: "summary-stat" },
          h("span", null, "Scan quality"),
          h(
            "strong",
            null,
            result.inaccessibleCount
              ? `${formatCount(result.inaccessibleCount)} skipped`
              : "Complete",
          ),
          h(
            "small",
            null,
            `${(result.elapsedMs / 1000).toFixed(1)} seconds${result.truncated ? " · folder list capped" : ""}${completedAt ? ` · scanned ${timeAgo(completedAt / 1000)}` : ""}`,
          ),
        ),
      ),
      breadcrumb(result, currentPath, go),
      h(
        "div",
        { class: "disk-tabs", role: "tablist" },
        ...(
          [
            ["folders", "Folders", "folder-tree"],
            ["files", "Largest Files", "file-warning"],
            ["recommendations", "Recommendations", "shield"],
          ] as [Tab, string, "folder-tree" | "file-warning" | "shield"][]
        ).map(([id, label, iconName]) =>
          h(
            "button",
            {
              class: tab === id ? "active" : "",
              type: "button",
              role: "tab",
              aria: { selected: tab === id },
              onclick: () => session.setTab(id),
            },
            icon(iconName, 16),
            label,
            id === "recommendations" && result.recommendations.length
              ? h("b", null, String(result.recommendations.length))
              : null,
          ),
        ),
      ),
      body,
      tab === "recommendations"
        ? h(
            "p",
            { class: "recommendation-disclaimer" },
            icon("info", 14),
            "Recommendations are hints, not deletion decisions. Open the location, identify the owning app or project, and back up anything important first.",
          )
        : null,
    );
  };

  function render(): void {
    const { scanning, analysis, progress } = session.state;
    if (scanning) mount(scroller, scanningView(progress, cancel));
    else if (analysis) mount(scroller, renderResults(analysis));
    else mount(scroller, renderLanding());
  }

  /** Progress arrives often, so only the three changing texts are touched. */
  function showProgress(): void {
    const next = session.state.progress;
    if (!next) return;
    const files = scroller.querySelector<HTMLElement>(
      ".disk-scan-stats strong",
    );
    const bytes = scroller.querySelector<HTMLElement>(".disk-scan-stats span");
    const path = scroller.querySelector<HTMLElement>(".disk-scan-path");
    if (files) files.textContent = plural(next.fileCount, "file");
    if (bytes) bytes.textContent = formatBytes(next.scannedBytes);
    if (path) {
      path.textContent = next.currentPath;
      path.title = next.currentPath;
    }
  }

  const unsubscribe = session.subscribe((change) => {
    if (disposed) return;
    if (change === "progress") showProgress();
    else render();
  });

  render();
  void api
    .listDisks()
    .then((items) => {
      if (!disposed) {
        disks = items;
        render();
      }
    })
    .catch((error) => toast(String(error), "error"));

  return {
    gallery: false,
    dispose: () => {
      disposed = true;
      unsubscribe();
      mount(scroller);
    },
  };
}

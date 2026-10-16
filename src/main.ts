import "./styles/base.css";
import "./styles/layout.css";
import "./styles/gallery.css";
import "./styles/viewer.css";
import "./styles/pages.css";
import "./styles/components.css";

import {
  refreshFolders,
  refreshLibrary,
  refreshSettings,
  refreshSources,
  refreshStats,
} from "./data";
import { api, onEvent, type ScanProgress } from "./lib/api";
import { escapeHtml } from "./lib/format";
import { navigate } from "./router";
import { handleScanProgress } from "./scan-status";
import { startShell } from "./shell";
import { state, type ViewId } from "./state";
import { applyTheme } from "./theme";

const VIEWS: ViewId[] = [
  "all",
  "recent",
  "favorites",
  "videos",
  "screenshots",
  "folders",
  "sources",
  "disk",
  "settings",
];

/** Run `fn` at most once per `wait` ms, and always once more after the last call. */
function throttle(fn: () => void, wait: number): () => void {
  let timer = 0;
  let pending = false;
  const fire = () => {
    timer = 0;
    if (pending) {
      pending = false;
      fn();
      timer = window.setTimeout(fire, wait);
    }
  };
  return () => {
    pending = true;
    if (!timer) fire();
  };
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app")!;
  await refreshSettings();
  applyTheme();
  await Promise.all([refreshSources(), refreshStats(), refreshFolders()]);
  startShell(root);

  const libraryChanged = throttle(() => void refreshLibrary(), 700);
  await Promise.all([
    onEvent<ScanProgress>("scan-progress", handleScanProgress),
    onEvent("library-changed", libraryChanged),
    onEvent("sources-changed", () => void refreshSources()),
  ]);
  void api.scanState().then((scan) => {
    state.scan.paused = scan.paused;
  });

  // Open where the user left off.
  const view = VIEWS.includes(state.settings.lastView as ViewId)
    ? (state.settings.lastView as ViewId)
    : "all";
  const folder =
    view === "folders" && state.settings.lastFolder
      ? state.settings.lastFolder
      : undefined;
  navigate({ view, folder });
}

boot().catch((error) => {
  document.querySelector("#app")!.innerHTML =
    `<div class="fatal"><h1>Framer couldn't start</h1><p>${escapeHtml(String(error))}</p></div>`;
});

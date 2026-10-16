import { addFolder } from "./actions";
import { refreshSources, saveSetting } from "./data";
import { api, type FolderNode, type LibraryView } from "./lib/api";
import { clear, debounce, h, isTyping, mount } from "./lib/dom";
import { formatCount, plural } from "./lib/format";
import { icon, type IconName } from "./lib/icons";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  navigate,
  setMounter,
} from "./router";
import {
  bus,
  GRID_MAX,
  GRID_MIN,
  gridSize,
  state,
  type Route,
  type ViewId,
} from "./state";
import { applyTheme } from "./theme";
import { viewer } from "./views/gallery";
import {
  chainFor,
  childrenOf,
  createFoldersView,
  pathKey,
} from "./views/folders";
import { createLibraryView } from "./views/library";
import { createSettingsView } from "./views/settings";
import { createSourcesView } from "./views/sources";
import { createDiskView } from "./views/disk";
import type { View } from "./views/view";
import { createWelcomeView } from "./views/welcome";

const TITLES: Record<ViewId, string> = {
  all: "Library",
  recent: "Recently Added",
  favorites: "Favorites",
  videos: "Videos",
  screenshots: "Screenshots",
  folders: "Folders",
  sources: "Sources",
  disk: "Disk Usage",
  settings: "Settings",
};

interface NavEntry {
  view: LibraryView;
  label: string;
  icon: IconName;
  count?: () => number;
}

const LIBRARY_NAV: NavEntry[] = [
  {
    view: "all",
    label: "All Photos",
    icon: "images",
    count: () => state.stats.total,
  },
  { view: "recent", label: "Recently Added", icon: "clock" },
  {
    view: "favorites",
    label: "Favorites",
    icon: "heart",
    count: () => state.stats.favorites,
  },
  {
    view: "videos",
    label: "Videos",
    icon: "film",
    count: () => state.stats.videos,
  },
  {
    view: "screenshots",
    label: "Screenshots",
    icon: "screenshot",
    count: () => state.stats.screenshots,
  },
];

const GALLERY_VIEWS: ViewId[] = [
  "all",
  "recent",
  "favorites",
  "videos",
  "screenshots",
  "folders",
];

let currentView: View | null = null;
let showingWelcome = false;
const expanded = new Set<string>();

// Elements created once by buildShell().
let frame: HTMLElement;
let nav: HTMLElement;
let scanSlot: HTMLElement;
let content: HTMLElement;
let titleEl: HTMLElement;
let searchBox: HTMLElement;
let searchInput: HTMLInputElement;
let sizeControl: HTMLElement;
let sizeInput: HTMLInputElement;
let fitButton: HTMLButtonElement;
let backButton: HTMLButtonElement;
let forwardButton: HTMLButtonElement;

function navButton(
  view: ViewId,
  iconName: IconName,
  label: string,
  count?: number | null,
): HTMLButtonElement {
  const active = state.route.view === view;
  return h(
    "button",
    {
      class: `nav-item${active ? " active" : ""}`,
      type: "button",
      title: label,
      aria: { current: active ? "page" : undefined },
      onclick: (event: MouseEvent) => {
        (event.currentTarget as HTMLElement).blur();
        navigate({ view });
      },
    },
    icon(iconName, 17),
    h("span", { class: "nav-label" }, label),
    typeof count === "number" && count > 0
      ? h("b", { class: "nav-count" }, formatCount(count))
      : null,
  );
}

function section(label: string, ...children: (Node | null)[]): HTMLElement {
  return h(
    "div",
    { class: "nav-section" },
    h("p", { class: "nav-heading" }, label),
    ...children,
  );
}

// ---- folder tree ---------------------------------------------------------------------

function treeRows(
  parent: string | null,
  depth: number,
  activeKey: string,
  activeChain: Set<string>,
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const node of childrenOf(state.folders, parent)) {
    const key = pathKey(node.path);
    const kids = childrenOf(state.folders, node.path);
    const open = expanded.has(key) || activeChain.has(key);
    rows.push(treeRow(node, kids.length > 0, open, depth, key === activeKey));
    if (kids.length && open)
      rows.push(...treeRows(node.path, depth + 1, activeKey, activeChain));
  }
  return rows;
}

function treeRow(
  node: FolderNode,
  hasChildren: boolean,
  open: boolean,
  depth: number,
  active: boolean,
): HTMLElement {
  const toggle = hasChildren
    ? h(
        "button",
        {
          class: `tree-toggle${open ? " open" : ""}`,
          type: "button",
          tabIndex: -1,
          aria: {
            label: open ? `Collapse ${node.name}` : `Expand ${node.name}`,
          },
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            const key = pathKey(node.path);
            if (expanded.has(key) || open) expanded.delete(key);
            else expanded.add(key);
            // an ancestor of the open folder stays open; collapse is a visual hint only for others
            renderNav();
          },
        },
        icon("chevron-right", 12),
      )
    : h("span", { class: "tree-toggle spacer" });
  return h(
    "div",
    {
      class: `tree-row${active ? " active" : ""}${node.available ? "" : " offline"}`,
      style: `padding-left:${8 + depth * 14}px`,
    },
    toggle,
    h(
      "button",
      {
        class: "tree-label",
        type: "button",
        title: node.path,
        aria: { current: active ? "page" : undefined },
        onclick: (event: MouseEvent) => {
          (event.currentTarget as HTMLElement).blur();
          navigate({ view: "folders", folder: node.path });
        },
      },
      icon(node.available ? (active ? "folder-open" : "folder") : "unplug", 15),
      h("span", null, node.name),
      node.totalCount ? h("b", null, formatCount(node.totalCount)) : null,
    ),
  );
}

function folderTree(): HTMLElement | null {
  if (
    state.route.view !== "folders" ||
    state.sources.length === 0 ||
    state.folders.length === 0
  )
    return null;
  const folder = state.route.folder;
  const chain = folder ? chainFor(state.folders, folder) : [];
  const activeChain = new Set(
    chain.slice(0, -1).map((node) => pathKey(node.path)),
  );
  const roots = childrenOf(state.folders, null);
  // Show a lone source root expanded by default so the structure is visible right away.
  if (roots.length === 1) expanded.add(pathKey(roots[0].path));
  return h(
    "div",
    { class: "tree", role: "tree", aria: { label: "Folders" } },
    ...treeRows(null, 0, folder ? pathKey(folder) : "", activeChain),
  );
}

// ---- sidebar -------------------------------------------------------------------------

function renderNav(): void {
  clear(nav);
  nav.append(
    section(
      "LIBRARY",
      ...LIBRARY_NAV.map((entry) =>
        navButton(entry.view, entry.icon, entry.label, entry.count?.()),
      ),
    ),
    section(
      "BROWSE",
      navButton("folders", "folder", "Folders"),
      folderTree(),
      navButton("sources", "drive", "Sources", state.sources.length),
      navButton("disk", "disk", "Disk Usage"),
    ),
    section(
      "COLLECTIONS",
      h(
        "button",
        {
          class: "nav-item disabled",
          type: "button",
          disabled: true,
          title: "Albums arrive in a later release",
        },
        icon("album", 17),
        h("span", { class: "nav-label" }, "My Albums"),
        h("b", { class: "nav-soon" }, "Soon"),
      ),
    ),
  );
  nav.querySelector(".tree-row.active")?.scrollIntoView({ block: "nearest" });
}

interface ScanWidget {
  root: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  toggle: HTMLButtonElement;
  paused: boolean;
}

let scanWidget: ScanWidget | null = null;
let scanSummary: HTMLElement | null = null;

/** Built once and then updated in place, so its buttons never move out from under the pointer. */
function createScanWidget(): ScanWidget {
  const title = h("strong");
  const detail = h("small");
  const toggle = h("button", {
    class: "icon-button small",
    type: "button",
    onclick: () => {
      const next = !state.scan.paused;
      state.scan.paused = next;
      void (next ? api.pauseScans() : api.resumeScans());
      renderScanStatus();
    },
  });
  const root = h(
    "div",
    { class: "scan-status", role: "status", aria: { live: "polite" } },
    h(
      "div",
      { class: "scan-head" },
      title,
      h(
        "span",
        { class: "scan-actions" },
        toggle,
        h(
          "button",
          {
            class: "icon-button small",
            type: "button",
            title: "Cancel",
            aria: { label: "Cancel indexing" },
            onclick: () => void api.cancelScans(),
          },
          icon("close", 13),
        ),
      ),
    ),
    h("div", { class: "progress" }, h("i")),
    detail,
  );
  return { root, title, detail, toggle, paused: false };
}

function renderScanStatus(): void {
  const entries = [...state.scan.progress.values()];
  const now = Date.now();
  const noteworthy = entries.some(
    (entry) =>
      entry.state === "paused" ||
      entry.indexed > 0 ||
      now - (state.scan.startedAt.get(entry.sourceId) ?? now) > 1500,
  );
  if (entries.length && noteworthy) {
    const widget = (scanWidget ??= createScanWidget());
    const paused = state.scan.paused;
    const indexed = entries.reduce((sum, entry) => sum + entry.indexed, 0);
    const scanned = entries.reduce((sum, entry) => sum + entry.scanned, 0);
    widget.root.classList.toggle("paused", paused);
    widget.title.textContent = paused
      ? "Indexing paused"
      : `Indexing ${entries.length > 1 ? plural(entries.length, "folder") : entries[0].sourceName}`;
    widget.detail.textContent = `${formatCount(scanned)} checked · ${formatCount(indexed)} new`;
    if (widget.paused !== paused || !widget.toggle.firstChild) {
      widget.paused = paused;
      widget.toggle.title = paused ? "Resume" : "Pause";
      widget.toggle.setAttribute(
        "aria-label",
        paused ? "Resume indexing" : "Pause indexing",
      );
      widget.toggle.replaceChildren(icon(paused ? "play" : "pause", 13));
    }
    if (widget.root.parentElement !== scanSlot) mount(scanSlot, widget.root);
    scanSummary = null;
    return;
  }
  const summary = state.scan.lastSummary;
  if (summary && entries.length === 0) {
    if (!scanSummary) {
      scanSummary = h(
        "div",
        { class: "scan-status done", role: "status" },
        h("strong", null, "Library updated"),
        h("small", null, ""),
      );
      mount(scanSlot, scanSummary);
    }
    scanSummary.querySelector("small")!.textContent =
      `${plural(summary.indexed, "item")} added or changed`;
    return;
  }
  scanSummary = null;
  mount(scanSlot);
}

function buildShell(root: HTMLElement): void {
  nav = h("nav", { class: "nav", aria: { label: "Library" } });
  scanSlot = h("div", { class: "scan-slot" });
  content = h("div", { class: "content", id: "content", tabIndex: -1 });
  titleEl = h("div", { class: "toolbar-title" });
  backButton = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      title: "Back (Alt+←)",
      aria: { label: "Back" },
      onclick: goBack,
    },
    icon("chevron-left", 17),
  );
  forwardButton = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      title: "Forward (Alt+→)",
      aria: { label: "Forward" },
      onclick: goForward,
    },
    icon("chevron-right", 17),
  );

  const onSearch = debounce(
    (value: string) => currentView?.setSearch?.(value),
    180,
  );
  searchInput = h("input", {
    id: "search",
    type: "search",
    placeholder: "Search",
    autocomplete: "off",
    spellcheck: false,
    aria: { label: "Search" },
    oninput: () => onSearch(searchInput.value),
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (searchInput.value) {
          searchInput.value = "";
          currentView?.setSearch?.("");
        }
        searchInput.blur();
      }
    },
  });
  searchBox = h(
    "label",
    { class: "search" },
    icon("search", 15),
    searchInput,
    h("kbd", null, "Ctrl F"),
  );
  sizeInput = h("input", {
    type: "range",
    min: String(GRID_MIN),
    max: String(GRID_MAX),
    value: String(gridSize()),
    aria: { label: "Thumbnail size" },
    oninput: () => void saveSetting("gridSize", sizeInput.value),
  });
  fitButton = h(
    "button",
    {
      class: "icon-button",
      id: "thumb-fit",
      type: "button",
      title: "Show whole photos in thumbnails",
      aria: { label: "Show whole photos in thumbnails", pressed: false },
      onclick: () =>
        void saveSetting(
          "thumbFit",
          String(state.settings.thumbFit !== "true"),
        ),
    },
    icon("fit", 17),
  );
  sizeControl = h(
    "div",
    { class: "grid-control" },
    h(
      "label",
      { title: "Thumbnail size", class: "grid-slider" },
      icon("grid", 15),
      sizeInput,
    ),
    fitButton,
  );

  const sidebar = h(
    "aside",
    { class: "sidebar" },
    h(
      "div",
      { class: "brand" },
      h("div", { class: "brand-icon" }, icon("image", 18)),
      h("span", null, "Framer"),
    ),
    nav,
    h(
      "div",
      { class: "sidebar-bottom" },
      scanSlot,
      h(
        "button",
        {
          class: "nav-item",
          id: "nav-settings",
          type: "button",
          title: "Settings",
          onclick: (event: MouseEvent) => {
            (event.currentTarget as HTMLElement).blur();
            navigate({ view: "settings" });
          },
        },
        icon("settings", 17),
        h("span", { class: "nav-label" }, "Settings"),
      ),
      h(
        "p",
        { class: "privacy-note" },
        icon("shield", 13),
        h("span", null, "Your files stay yours."),
      ),
    ),
  );

  const toolbar = h(
    "header",
    { class: "toolbar" },
    h(
      "div",
      { class: "toolbar-left" },
      h(
        "button",
        {
          class: "icon-button",
          type: "button",
          title: "Toggle sidebar",
          aria: { label: "Toggle sidebar" },
          onclick: toggleSidebar,
        },
        icon("sidebar", 18),
      ),
      h("div", { class: "history-buttons" }, backButton, forwardButton),
    ),
    titleEl,
    h(
      "div",
      { class: "toolbar-actions" },
      searchBox,
      sizeControl,
      h(
        "button",
        {
          class: "icon-button",
          id: "add-folder",
          type: "button",
          title: "Add folder",
          aria: { label: "Add folder" },
          onclick: () => void addFolder(),
        },
        icon("folder-plus", 18),
      ),
    ),
  );

  frame = h(
    "div",
    { class: "frame" },
    sidebar,
    h("main", null, toolbar, content),
  );
  mount(
    root,
    frame,
    h("div", { id: "overlay-root" }),
    h("div", { id: "toast-root", aria: { live: "polite" } }),
  );
  applySidebar();
}

function toggleSidebar(): void {
  void saveSetting(
    "sidebarCollapsed",
    String(state.settings.sidebarCollapsed !== "true"),
  );
}

function applySidebar(): void {
  frame.classList.toggle(
    "sidebar-collapsed",
    state.settings.sidebarCollapsed === "true",
  );
  const fit = state.settings.thumbFit === "true";
  document.documentElement.dataset.thumbFit = String(fit);
  fitButton.classList.toggle("active", fit);
  fitButton.setAttribute("aria-pressed", String(fit));
}

// ---- routing -------------------------------------------------------------------------

function createView(route: Route): View {
  const needsLibrary = GALLERY_VIEWS.includes(route.view);
  showingWelcome = needsLibrary && state.sources.length === 0;
  if (showingWelcome) return createWelcomeView(content);
  switch (route.view) {
    case "sources":
      return createSourcesView(content);
    case "settings":
      return createSettingsView(content);
    case "disk":
      return createDiskView(content);
    case "folders":
      return createFoldersView(content, route);
    default:
      return createLibraryView(content, route);
  }
}

function mountRoute(route: Route): void {
  currentView?.dispose();
  currentView = null;
  clear(content);
  content.scrollTop = 0;
  searchInput.value = "";
  currentView = createView(route);
  updateChrome();
  void saveSetting("lastView", route.view);
  void saveSetting("lastFolder", route.folder ?? "");
}

function updateChrome(): void {
  const route = state.route;
  const folderTitle =
    route.view === "folders" && route.folder
      ? chainFor(state.folders, route.folder).at(-1)?.name
      : undefined;
  titleEl.textContent = folderTitle ?? TITLES[route.view];
  const gallery = Boolean(currentView?.gallery);
  searchBox.hidden = !gallery;
  sizeControl.hidden = !gallery;
  backButton.disabled = !canGoBack();
  forwardButton.disabled = !canGoForward();
  renderNav();
}

// ---- startup -------------------------------------------------------------------------

export function startShell(root: HTMLElement): void {
  buildShell(root);
  setMounter(mountRoute);

  let lastTile = gridSize();
  bus.on("settings", () => {
    applyTheme();
    applySidebar();
    const size = gridSize();
    if (size !== lastTile) {
      lastTile = size;
      sizeInput.value = String(size);
      currentView?.onTileSizeChanged?.();
    }
  });
  bus.on("sources", () => {
    const wantsWelcome =
      GALLERY_VIEWS.includes(state.route.view) && state.sources.length === 0;
    if (wantsWelcome !== showingWelcome) mountRoute(state.route);
    else currentView?.onStateChanged?.();
    renderNav();
  });
  bus.on("stats", () => {
    renderNav();
    currentView?.onStateChanged?.();
  });
  bus.on("folders", () => {
    renderNav();
    updateChrome();
  });
  bus.on("library", () => currentView?.onLibraryChanged?.());
  bus.on("route", updateChrome);
  bus.on("scan", renderScanStatus);

  document.addEventListener("keydown", onKeyDown);
  // Coming back to the window is the moment a drive may have been plugged in or removed.
  window.addEventListener("focus", () => void refreshSources());
}

function onKeyDown(event: KeyboardEvent): void {
  if (
    viewer.isOpen ||
    document.querySelector(".context-menu, .dialog-backdrop")
  )
    return;
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === "f" && currentView?.gallery) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    goBack();
    return;
  }
  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    goForward();
    return;
  }
  if (isTyping(event.target)) return;
  if (currentView?.handleKey?.(event)) {
    // Space/Enter must not also "click" whichever sidebar button still has focus.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
}

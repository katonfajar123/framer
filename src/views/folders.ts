import { thumbUrlForId, type FolderNode } from "../lib/api";
import { h, mount } from "../lib/dom";
import { folderName, formatCount, plural } from "../lib/format";
import { icon } from "../lib/icons";
import { navigate } from "../router";
import { gridSize, state, type Route } from "../state";
import { emptyState } from "./empty";
import { Gallery, showInTimeline } from "./gallery";
import type { View } from "./view";

export function pathKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function childrenOf(folders: FolderNode[], path: string | null): FolderNode[] {
  const key = path === null ? null : pathKey(path);
  return folders
    .filter((node) => (key === null ? node.isRoot : node.parent !== null && pathKey(node.parent) === key))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** Ancestors from the source root down to (and including) `path`. */
export function chainFor(folders: FolderNode[], path: string): FolderNode[] {
  const byKey = new Map(folders.map((node) => [pathKey(node.path), node]));
  const chain: FolderNode[] = [];
  let current = byKey.get(pathKey(path));
  while (current) {
    chain.unshift(current);
    current = current.parent ? byKey.get(pathKey(current.parent)) : undefined;
  }
  return chain;
}

function folderCard(node: FolderNode): HTMLElement {
  let cover: HTMLImageElement | null = null;
  if (node.coverId) {
    const image = h("img", { src: thumbUrlForId(node.coverId), alt: "", decoding: "async", draggable: false });
    image.addEventListener("error", () => image.remove());
    cover = image;
  }
  return h(
    "button",
    {
      class: `folder-card${node.available ? "" : " offline"}`,
      type: "button",
      title: node.path,
      onclick: () => navigate({ view: "folders", folder: node.path }),
    },
    h("span", { class: "folder-cover" }, icon(node.available ? "folder" : "unplug", 32), cover),
    h("strong", null, node.name),
    h("span", { class: "folder-meta" }, node.available ? plural(node.totalCount, "item") : `${plural(node.totalCount, "item")} · offline`),
    node.isRoot ? h("small", null, node.path) : null,
  );
}

function breadcrumb(folders: FolderNode[], path: string): HTMLElement {
  const chain = chainFor(folders, path);
  const crumbs = chain.length ? chain : [{ path, name: folderName(path) } as FolderNode];
  const items: (HTMLElement | SVGElement)[] = [
    h("button", { type: "button", onclick: () => navigate({ view: "folders" }) }, "Folders"),
  ];
  crumbs.forEach((node, index) => {
    items.push(h("span", { class: "crumb-sep" }, icon("chevron-right", 12)));
    const last = index === crumbs.length - 1;
    items.push(
      last
        ? h("span", { class: "crumb-current", aria: { current: "page" } }, node.name)
        : h("button", { type: "button", onclick: () => navigate({ view: "folders", folder: node.path }) }, node.name),
    );
  });
  return h("nav", { class: "breadcrumb", aria: { label: "Folder path" } }, ...items);
}

/** Folders root: every source as a card. */
function createRootView(scroller: HTMLElement): View {
  const render = () => {
    const roots = childrenOf(state.folders, null);
    mount(
      scroller,
      h(
        "div",
        { class: "page" },
        h("div", { class: "page-heading" }, h("div", null, h("h1", null, "Folders"), h("p", null, "Browse the organization already on your computer")), h("span", { class: "page-count" }, plural(roots.length, "source"))),
        roots.length
          ? h("div", { class: "folder-grid" }, ...roots.map(folderCard))
          : emptyState("folder", "No folders yet", "Add a source folder and its structure appears here."),
      ),
    );
  };
  render();
  return { gallery: false, dispose: () => mount(scroller), onLibraryChanged: render, onStateChanged: render };
}

export function createFoldersView(scroller: HTMLElement, route: Route): View {
  const folder = route.folder;
  if (!folder) return createRootView(scroller);

  let query = "";
  const header = h("div", { class: "folder-header" });
  let directItems = 0;

  const renderHeader = () => {
    const children = childrenOf(state.folders, folder);
    const node = chainFor(state.folders, folder).at(-1);
    const total = node?.totalCount ?? directItems;
    const hasPhotosHeading = children.length > 0 && directItems > 0;
    mount(
      header,
      h(
        "div",
        { class: "page-heading" },
        h("div", null, breadcrumb(state.folders, folder), h("h1", null, node?.name ?? folderName(folder)), h("p", { title: folder }, query.trim() ? `Results for “${query.trim()}” in this folder` : folder)),
        h("span", { class: "page-count" }, total ? `${formatCount(total)} ${total === 1 ? "item" : "items"}` : ""),
      ),
      children.length && !query.trim() ? h("div", { class: "folder-grid compact" }, ...children.map(folderCard)) : null,
      hasPhotosHeading && !query.trim() ? h("h2", { class: "section-label" }, "Photos & videos in this folder") : null,
    );
    header.append(gallery.emptyHost);
  };

  const gallery: Gallery = new Gallery({
    scroller,
    header,
    flat: true,
    getFilter: () => ({ view: "all", query, folder, recursive: query.trim().length > 0, sort: "name" }),
    getTileSize: gridSize,
    empty: () => {
      if (query.trim()) return emptyState("search-x", "No matches here", "Try another name, or search the whole library.");
      if (childrenOf(state.folders, folder).length) return h("div");
      return emptyState("folder", "This folder is empty", "Photos and videos you add to it appear here automatically.");
    },
    locate: { label: "Show in Timeline", icon: "images", run: showInTimeline },
    onLoaded: (total) => {
      directItems = total;
      renderHeader();
    },
  });
  renderHeader();
  void gallery.load();

  return {
    gallery: true,
    dispose: () => gallery.dispose(),
    setSearch(next) {
      query = next;
      gallery.setSearchActive();
      renderHeader();
      void gallery.grid.reload();
    },
    onLibraryChanged: () => {
      renderHeader();
      void gallery.refresh();
    },
    onTileSizeChanged: () => gallery.grid.setTileSize(),
    handleKey: (event) => gallery.handleKey(event),
  };
}

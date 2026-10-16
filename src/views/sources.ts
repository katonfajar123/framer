import { addFolder, locateFolder, rescan, removeSource } from "../actions";
import { refreshSources } from "../data";
import type { SourceRecord } from "../lib/api";
import { h, mount } from "../lib/dom";
import { formatCount, plural, timeAgo } from "../lib/format";
import { icon } from "../lib/icons";
import { state } from "../state";
import { toast } from "../ui/toast";
import { emptyState } from "./empty";
import type { View } from "./view";

function statusLine(source: SourceRecord): string {
  if (!source.available)
    return "Source unavailable — reconnect the drive or locate the folder";
  if (source.scanning)
    return `${formatCount(source.mediaCount)} items · Indexing…`;
  const scanned = source.lastScannedAt
    ? ` · Updated ${timeAgo(source.lastScannedAt)}`
    : "";
  return `${plural(source.mediaCount, "item")}${scanned}`;
}

function sourceRow(source: SourceRecord): HTMLElement {
  const actions: HTMLElement[] = [];
  if (source.available) {
    actions.push(
      h(
        "button",
        { class: "subtle", type: "button", onclick: () => void rescan(source) },
        icon("refresh", 15),
        "Rescan",
      ),
    );
  } else {
    actions.push(
      h(
        "button",
        {
          class: "subtle",
          type: "button",
          onclick: async () => {
            await refreshSources();
            const fresh = state.sources.find(
              (candidate) => candidate.id === source.id,
            );
            toast(
              fresh?.available
                ? "Source reconnected"
                : "Still unavailable. Plug the drive in or locate the folder.",
            );
            if (fresh?.available) await rescan(fresh);
          },
        },
        icon("refresh", 15),
        "Reconnect",
      ),
      h(
        "button",
        {
          class: "subtle",
          type: "button",
          onclick: () => void locateFolder(source),
        },
        icon("folder-search", 15),
        "Locate Folder…",
      ),
    );
  }
  actions.push(
    h(
      "button",
      {
        class: "icon-button danger",
        type: "button",
        title: "Remove from Framer",
        aria: { label: `Remove ${source.name} from Framer` },
        onclick: () => void removeSource(source),
      },
      icon("close", 16),
    ),
  );
  return h(
    "div",
    { class: `source-row${source.available ? "" : " unavailable"}` },
    h(
      "div",
      { class: "source-icon" },
      icon(source.available ? "drive" : "unplug", 20),
    ),
    h(
      "div",
      { class: "source-text" },
      h("strong", null, source.name),
      h("span", { title: source.path }, source.path),
      h("small", null, statusLine(source)),
    ),
    h("div", { class: "source-actions" }, ...actions),
  );
}

export function createSourcesView(scroller: HTMLElement): View {
  const render = () => {
    mount(
      scroller,
      h(
        "div",
        { class: "page narrow" },
        h(
          "div",
          { class: "page-heading" },
          h(
            "div",
            null,
            h("h1", null, "Sources"),
            h("p", null, "Folders Framer watches for photos and videos"),
          ),
          h(
            "button",
            {
              class: "primary",
              type: "button",
              onclick: () => void addFolder(),
            },
            icon("folder-plus", 16),
            "Add Folder",
          ),
        ),
        state.sources.length
          ? h("div", { class: "source-list" }, ...state.sources.map(sourceRow))
          : emptyState(
              "folder-plus",
              "No source folders",
              "Add a folder to begin building your local library.",
              { label: "Add Folder", run: () => void addFolder() },
            ),
        h(
          "div",
          { class: "source-help" },
          icon("info", 16),
          h(
            "p",
            null,
            "Removing a source only removes its index from Framer. Your original files are never deleted, and subfolders are included automatically.",
          ),
        ),
      ),
    );
  };
  render();
  // Keep "Updated 3 minutes ago" honest while the page stays open.
  const timer = window.setInterval(render, 30_000);
  return {
    gallery: false,
    dispose: () => {
      window.clearInterval(timer);
      mount(scroller);
    },
    onStateChanged: render,
    onLibraryChanged: render,
  };
}

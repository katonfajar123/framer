import { saveSetting } from "../data";
import { h } from "../lib/dom";
import type { LibraryView } from "../lib/api";
import { formatCount } from "../lib/format";
import { gridSize, state, type Route } from "../state";
import { emptyState } from "./empty";
import { Gallery, showInFolder } from "./gallery";
import type { View } from "./view";

const COPY: Record<LibraryView, { title: string; subtitle: string }> = {
  all: { title: "Library", subtitle: "All your photos and videos" },
  recent: { title: "Recently Added", subtitle: "Added in the last 30 days" },
  favorites: { title: "Favorites", subtitle: "The moments you love" },
  videos: { title: "Videos", subtitle: "Every clip in your library" },
  screenshots: { title: "Screenshots", subtitle: "Captured from your screen" },
};

const EMPTY: Record<
  LibraryView,
  { icon: Parameters<typeof emptyState>[0]; title: string; text: string }
> = {
  all: {
    icon: "image-off",
    title: "Nothing here yet",
    text: "Framer is waiting for media from your source folders.",
  },
  recent: {
    icon: "clock",
    title: "Nothing new",
    text: "Photos you add to your folders in the next 30 days will show up here.",
  },
  favorites: {
    icon: "heart",
    title: "No favorites yet",
    text: "Select a photo and press F to keep it close.",
  },
  videos: {
    icon: "film",
    title: "No videos",
    text: "MP4, MOV, M4V and WebM files in your folders appear here.",
  },
  screenshots: {
    icon: "screenshot",
    title: "No screenshots",
    text: "Files named Screenshot… or kept in a Screenshots folder appear here.",
  },
};

export function createLibraryView(scroller: HTMLElement, route: Route): View {
  const section = route.view as LibraryView;
  let query = "";

  const subtitle = h("p");
  const count = h("span", { class: "page-count" });
  const grouping = () =>
    state.settings.timelineGrouping === "month" ? "month" : "day";
  const segment = (value: "day" | "month", label: string) =>
    h(
      "button",
      {
        class: "segment",
        type: "button",
        role: "radio",
        data: { value },
        onclick: () => choose(value),
      },
      label,
    );
  const dayButton = segment("day", "Days");
  const monthButton = segment("month", "Months");
  const paintSegments = () => {
    [dayButton, monthButton].forEach((button) => {
      const on = button.dataset.value === grouping();
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    });
  };
  const choose = (value: "day" | "month") => {
    if (value === grouping()) return;
    void saveSetting("timelineGrouping", value);
    paintSegments();
    gallery.grid.setTileSize(); // re-flow the same photos with the other grouping
  };
  paintSegments();
  const header = h(
    "div",
    { class: "page-heading" },
    h("div", null, h("h1", null, COPY[section].title), subtitle),
    h(
      "div",
      { class: "page-tools" },
      count,
      h(
        "div",
        { class: "segmented", role: "radiogroup", aria: { label: "Group by" } },
        dayButton,
        monthButton,
      ),
    ),
  );
  const updateSubtitle = () => {
    subtitle.textContent = query.trim()
      ? `Results for “${query.trim()}”`
      : COPY[section].subtitle;
  };
  updateSubtitle();

  const gallery = new Gallery({
    scroller,
    header,
    flat: false,
    getFilter: () => ({
      view: section,
      query,
      folder: null,
      recursive: false,
      sort: "date",
    }),
    getTileSize: gridSize,
    getGrouping: grouping,
    empty: () => {
      if (query.trim())
        return emptyState(
          "search-x",
          "No matching moments",
          "Try another file name, folder, date, or format.",
        );
      const copy = EMPTY[section];
      return emptyState(
        copy.icon,
        copy.title,
        state.sources.some((source) => source.scanning)
          ? "Indexing your folders…"
          : copy.text,
      );
    },
    locate: {
      label: "Show in Folder",
      icon: "folder-search",
      run: showInFolder,
    },
    onLoaded: (total) => {
      count.textContent = total
        ? `${formatCount(total)} ${total === 1 ? "item" : "items"}`
        : "";
    },
  });
  void gallery.load();

  return {
    gallery: true,
    dispose: () => gallery.dispose(),
    setSearch(next) {
      query = next;
      updateSubtitle();
      gallery.setSearchActive();
      void gallery.grid.reload();
    },
    onLibraryChanged: () => void gallery.refresh(),
    onTileSizeChanged: () => gallery.grid.setTileSize(),
    handleKey: (event) => gallery.handleKey(event),
  };
}

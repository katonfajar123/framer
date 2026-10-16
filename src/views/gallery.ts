import { refreshCounts } from "../data";
import { MediaGrid, type GridHost } from "../grid/media-grid";
import { api, type MediaFilter, type MediaItem } from "../lib/api";
import { h } from "../lib/dom";
import { plural } from "../lib/format";
import type { IconName } from "../lib/icons";
import { navigate } from "../router";
import { routeKey, state } from "../state";
import { confirmDialog } from "../ui/dialog";
import { showMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";
import { Viewer, type ViewerMode } from "../viewer/viewer";

/** One viewer for the whole app: opening a photo anywhere reuses it. */
export const viewer = new Viewer();

export interface GalleryConfig {
  scroller: HTMLElement;
  header: HTMLElement;
  flat: boolean;
  getFilter: () => MediaFilter;
  getTileSize: () => number;
  getGrouping?: () => "day" | "month";
  /** Shown when the listing is empty (while no search is active). */
  empty: () => HTMLElement;
  locate: { label: string; icon: IconName; run: (item: MediaItem) => void };
  onLoaded?: (total: number) => void;
}

interface Memory {
  scroll: number;
  selected: number[];
  anchor: number;
  cursor: number;
}

/** Scroll position and selection are remembered per view, so coming back feels instant. */
const memory = new Map<string, Memory>();

/**
 * Everything the Library and Folders views share: the virtual grid, the viewer, the context
 * menu and the actions behind them (favorite, reveal, move to Recycle Bin).
 */
export class Gallery {
  readonly grid: MediaGrid;
  /** Holds the empty-state message; views that rebuild their header must re-append it. */
  readonly emptyHost = h("div", { class: "gallery-empty" });
  private selectionBar = h("div", { class: "selection-bar", hidden: true });
  private key: string;
  private disposed = false;

  constructor(private config: GalleryConfig) {
    this.key = routeKey(state.route);
    config.header.append(this.emptyHost);
    const host: GridHost = {
      onOpen: (index, mode) => void this.openViewer(index, mode),
      onContextMenu: (index, x, y) => this.contextMenu(index, x, y),
      onSelectionChange: () => this.updateSelectionBar(),
      onLoaded: (total) => this.loaded(total),
    };
    this.grid = new MediaGrid({
      scroller: config.scroller,
      host,
      getFilter: config.getFilter,
      flat: config.flat,
      getTileSize: config.getTileSize,
      getGrouping: config.getGrouping,
      header: config.header,
    });
    config.scroller.parentElement?.append(this.selectionBar);
  }

  async load(): Promise<void> {
    await this.grid.reload();
    if (this.disposed) return;
    const saved = memory.get(this.key);
    if (saved && !state.route.focusId) {
      this.grid.setScroll({ top: saved.scroll });
      this.grid.restoreSelection(saved.selected, saved.anchor, saved.cursor);
    }
    if (state.route.focusId) await this.focus(state.route.focusId);
  }

  /** Reload after the library changed on disk, keeping the user's place. */
  async refresh(): Promise<void> {
    const top = this.grid.getScroll();
    await this.grid.reload();
    if (!this.disposed) this.grid.setScroll(top);
  }

  /** Scroll to an item and select it, used by "Show in Timeline" / "Show in Folder". */
  async focus(mediaId: number): Promise<void> {
    const index = await this.grid.indexOfId(mediaId);
    if (index === null || this.disposed) return;
    this.grid.scrollToIndex(index, "center");
    await this.grid.selectOnly(index, false);
  }

  setSearchActive(): void {
    this.grid.setScroll({ top: 0 });
  }

  dispose(): void {
    this.disposed = true;
    memory.set(this.key, {
      scroll: this.grid.getScroll().top,
      selected: this.grid.selectedIds(),
      anchor: -1,
      cursor: this.grid.cursorIndex,
    });
    this.selectionBar.remove();
    this.grid.dispose();
  }

  handleKey(event: KeyboardEvent): boolean {
    if (this.grid.handleKey(event)) {
      event.preventDefault();
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "f" || event.key === "F") {
      void this.favoriteSelection();
      event.preventDefault();
      return true;
    }
    if (event.key === "Delete") {
      void this.trashSelection();
      event.preventDefault();
      return true;
    }
    if (
      (event.key === "i" || event.key === "I") &&
      this.grid.cursorIndex >= 0
    ) {
      void this.openViewer(this.grid.cursorIndex, "viewer", true);
      event.preventDefault();
      return true;
    }
    return false;
  }

  // ---- loading & empty state -----------------------------------------------------------

  private loaded(total: number): void {
    this.emptyHost.replaceChildren();
    if (total === 0) this.emptyHost.append(this.config.empty());
    this.config.onLoaded?.(total);
    this.updateSelectionBar();
  }

  private updateSelectionBar(): void {
    const count = this.grid.selectedCount;
    this.selectionBar.hidden = count < 2;
    if (count < 2) return;
    this.selectionBar.replaceChildren(
      h("span", null, `${plural(count, "item")} selected`),
      h(
        "button",
        {
          class: "link",
          type: "button",
          onclick: () => void this.favoriteSelection(),
        },
        "Favorite",
      ),
      h(
        "button",
        {
          class: "link",
          type: "button",
          onclick: () => this.grid.clearSelection(),
        },
        "Clear",
      ),
    );
  }

  // ---- viewer --------------------------------------------------------------------------

  async openViewer(
    index: number,
    mode: ViewerMode,
    inspector = false,
  ): Promise<void> {
    const total = this.grid.total;
    await viewer.open(
      { itemAt: (position) => this.grid.itemAt(position) },
      index,
      total,
      mode,
      {
        onClose: (last) => {
          if (!this.disposed) {
            void this.grid.selectOnly(Math.min(last, this.grid.total - 1));
          }
        },
        onFavorite: (item) => {
          this.grid.updateItem(item.id, { favorite: item.favorite });
          void refreshCounts();
        },
        onTrash: async (item) => {
          const removed = await this.trashItems([item]);
          return removed ? this.grid.total : null;
        },
        locate: this.config.locate,
      },
      inspector,
    );
  }

  // ---- actions -------------------------------------------------------------------------

  private async favoriteSelection(): Promise<void> {
    const items = await this.grid.selectedItems();
    if (items.length === 0) return;
    const value = !items.every((item) => item.favorite);
    try {
      await api.setFavorites(
        items.map((item) => item.id),
        value,
      );
      items.forEach((item) =>
        this.grid.updateItem(item.id, { favorite: value }),
      );
      toast(
        value
          ? `Added ${plural(items.length, "item")} to Favorites`
          : `Removed ${plural(items.length, "item")} from Favorites`,
      );
      await refreshCounts();
      if (state.route.view === "favorites") await this.refresh();
    } catch (error) {
      toast(String(error), "error");
    }
  }

  /** Ask first, then move files to the Recycle Bin. Resolves true when something was removed. */
  private async trashItems(items: MediaItem[]): Promise<boolean> {
    if (items.length === 0) return false;
    const single = items.length === 1;
    const confirmed = await confirmDialog({
      title: single
        ? `Move “${items[0].fileName}” to the Recycle Bin?`
        : `Move ${items.length} items to the Recycle Bin?`,
      message:
        "The original files will leave their folders and go to the Windows Recycle Bin, where you can restore them. " +
        "This is different from removing a folder from Framer, which never touches your files.",
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!confirmed) return false;
    try {
      await api.trash(items.map((item) => item.id));
      this.grid.clearSelection();
      await this.grid.reload();
      await refreshCounts();
      toast(
        single
          ? "Moved to the Recycle Bin"
          : `Moved ${items.length} items to the Recycle Bin`,
      );
      return true;
    } catch (error) {
      toast(String(error), "error");
      return false;
    }
  }

  private async trashSelection(): Promise<void> {
    await this.trashItems(await this.grid.selectedItems());
  }

  private contextMenu(index: number, x: number, y: number): void {
    const item = this.grid.peek(index);
    if (!item) return;
    const count = this.grid.selectedCount;
    const many = count > 1;
    const everyFavorite = item.favorite && !many;
    const items: MenuItem[] = [
      {
        label: "Open",
        icon: "fullscreen",
        hint: "Enter",
        disabled: many,
        run: () => this.openViewer(index, "viewer"),
      },
      {
        label: "Quick Look",
        icon: "search",
        hint: "Space",
        disabled: many,
        run: () => this.openViewer(index, "quicklook"),
      },
      {
        label: many
          ? `Favorite ${count} items`
          : everyFavorite
            ? "Remove from Favorites"
            : "Favorite",
        icon: "heart",
        hint: "F",
        separator: true,
        run: () => this.favoriteSelection(),
      },
      {
        label: this.config.locate.label,
        icon: this.config.locate.icon,
        disabled: many,
        run: () => this.config.locate.run(item),
      },
      {
        label: "Show in File Explorer",
        icon: "external",
        disabled: many,
        run: () => api.reveal(item.path),
      },
      {
        label: "Get Info",
        icon: "info",
        hint: "I",
        disabled: many,
        run: () => this.openViewer(index, "viewer", true),
      },
      {
        label: many
          ? `Move ${count} items to Recycle Bin…`
          : "Move to Recycle Bin…",
        icon: "trash",
        hint: "Del",
        danger: true,
        separator: true,
        run: () => this.trashSelection(),
      },
    ];
    showMenu(x, y, items);
  }
}

/** Jump from any listing to the item's place in the Library timeline. */
export function showInTimeline(item: MediaItem): void {
  navigate({ view: "all", focusId: item.id });
}

/** Jump to the folder that holds the item, with the item selected. */
export function showInFolder(item: MediaItem): void {
  navigate({ view: "folders", folder: item.folderPath, focusId: item.id });
}

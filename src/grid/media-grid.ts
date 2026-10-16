import { api, thumbUrl, type LibraryLayout, type MediaFilter, type MediaItem } from "../lib/api";
import { clear, h } from "../lib/dom";
import { formatCount, plural } from "../lib/format";
import { icon } from "../lib/icons";
import { computeLayout, rowIndexAt, rowIndexForItem, stickyMonth, visibleRows, type GridLayout, type Row } from "./layout";

const PAGE_SIZE = 120;
const GAP = 4;
const SIDE_PADDING = 24;

export interface GridHost {
  onOpen(index: number, mode: "viewer" | "quicklook"): void;
  onContextMenu(index: number, x: number, y: number): void;
  onSelectionChange(): void;
  /** Called after every (re)load with the number of items in the listing. */
  onLoaded(total: number): void;
}

export interface GridOptions {
  scroller: HTMLElement;
  host: GridHost;
  getFilter: () => MediaFilter;
  /** Flat grids (folders) skip the month / day headings. */
  flat: boolean;
  getTileSize: () => number;
  /** `month` flows each month as one continuous grid instead of one block per day. */
  getGrouping?: () => "day" | "month";
  /** Rendered above the grid and scrolling with it (titles, breadcrumbs, folder cards). */
  header?: HTMLElement;
}

export interface ScrollState {
  top: number;
}

/**
 * A virtualised photo grid: only the rows near the viewport exist in the DOM, and item data
 * is fetched in pages as rows scroll into view, so a 50,000 item library costs the same as 50.
 */
export class MediaGrid {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private footer: HTMLElement;
  private sticky: HTMLElement;
  private stickyText: HTMLElement;
  private layout: GridLayout | null = null;
  private data: LibraryLayout = { total: 0, groups: [] };
  private cache = new Map<number, MediaItem>();
  private loadedPages = new Set<number>();
  private inflight = new Map<number, Promise<void>>();
  private rowElements = new Map<number, HTMLElement>();
  private generation = 0;
  private frame = 0;
  private width = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private selected = new Set<number>();
  private anchor = -1;
  private cursor = -1;

  constructor(private options: GridOptions) {
    this.body = h("div", { class: "grid-body", role: "listbox", aria: { multiselectable: true, label: "Photos and videos" } });
    this.footer = h("div", { class: "grid-footer" });
    this.stickyText = h("span");
    this.sticky = h("div", { class: "month-sticky", hidden: true, aria: { hidden: true } }, this.stickyText);
    this.root = h("div", { class: "grid-root" }, options.header ?? null, this.body, this.footer, this.sticky);
    options.scroller.append(this.root);

    options.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.body.addEventListener("click", this.onClick);
    this.body.addEventListener("dblclick", this.onDoubleClick);
    this.body.addEventListener("contextmenu", this.onContextMenu);
    this.body.addEventListener("dragstart", (event) => event.preventDefault());

    this.resizeObserver = new ResizeObserver(() => {
      const width = this.measureWidth();
      if (width !== this.width) this.relayout();
      else this.scheduleRender();
    });
    this.resizeObserver.observe(options.scroller);
    if (options.header) this.resizeObserver.observe(options.header);
  }

  // ---- lifecycle -----------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.options.scroller.removeEventListener("scroll", this.onScroll);
    this.root.remove();
  }

  /** Fetch the layout for the current filter and redraw. Selection survives; item data is refetched. */
  async reload(): Promise<void> {
    const generation = ++this.generation;
    const filter = this.options.getFilter();
    const data = await api.layout(filter);
    if (generation !== this.generation || this.disposed) return;
    this.data = this.options.flat ? { total: data.total, groups: [] } : data;
    this.cache.clear();
    this.loadedPages.clear();
    this.inflight.clear();
    this.clearRows();
    this.width = 0; // force a layout pass
    this.relayout();
    this.options.host.onLoaded(data.total);
  }

  get total(): number {
    return this.data.total;
  }

  setTileSize(): void {
    this.relayout();
  }

  getScroll(): ScrollState {
    return { top: this.options.scroller.scrollTop };
  }

  setScroll(state: ScrollState): void {
    this.options.scroller.scrollTop = state.top;
    this.scheduleRender();
  }

  // ---- layout & rendering -------------------------------------------------------------

  private measureWidth(): number {
    return Math.max(0, this.options.scroller.clientWidth - SIDE_PADDING * 2);
  }

  private relayout(): void {
    const width = this.measureWidth();
    if (width <= 0 || this.disposed) return;
    const scroller = this.options.scroller;
    const anchorIndex = this.layout && this.width ? this.firstVisibleIndex() : -1;
    const previousRow = anchorIndex >= 0 && this.layout ? this.layout.rows[rowIndexForItem(this.layout, anchorIndex)] : undefined;
    const offsetInRow = previousRow ? scroller.scrollTop - this.body.offsetTop - previousRow.top : 0;

    this.width = width;
    this.layout = computeLayout({
      width,
      targetTile: this.options.getTileSize(),
      gap: GAP,
      groups: this.options.flat ? null : this.data.groups,
      total: this.data.total,
      grouping: this.options.getGrouping?.() ?? "day",
    });
    this.body.style.height = `${this.layout.height}px`;
    this.clearRows();

    if (anchorIndex >= 0) {
      const rowIndex = rowIndexForItem(this.layout, anchorIndex);
      if (rowIndex >= 0) scroller.scrollTop = this.body.offsetTop + this.layout.rows[rowIndex].top + offsetInRow;
    }
    this.footer.textContent = this.data.total ? plural(this.data.total, "item") : "";
    this.render();
  }

  private clearRows(): void {
    this.rowElements.forEach((element) => element.remove());
    this.rowElements.clear();
  }

  private scheduleRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private onScroll = () => this.scheduleRender();

  private render(): void {
    const layout = this.layout;
    if (!layout || this.disposed) return;
    const scroller = this.options.scroller;
    const viewport = scroller.clientHeight;
    const y = Math.max(0, scroller.scrollTop - this.body.offsetTop);
    const [first, last] = visibleRows(layout, y, viewport, viewport * 0.9);

    for (const [index, element] of this.rowElements) {
      if (index < first || index > last) {
        element.remove();
        this.rowElements.delete(index);
      }
    }
    let firstItem = Infinity;
    let lastItem = -1;
    for (let index = first; index <= last; index++) {
      const row = layout.rows[index];
      if (!row) continue;
      if (row.kind === "tiles") {
        firstItem = Math.min(firstItem, row.start);
        lastItem = Math.max(lastItem, row.start + row.count - 1);
      }
      if (!this.rowElements.has(index)) {
        const element = this.createRow(row);
        this.rowElements.set(index, element);
        this.body.append(element);
      }
    }
    if (lastItem >= 0) void this.ensure(firstItem, lastItem);

    const stuck = this.options.flat ? null : stickyMonth(layout, scroller.scrollTop - this.body.offsetTop);
    this.sticky.hidden = !stuck;
    if (stuck) {
      this.stickyText.textContent = stuck.label;
      this.sticky.style.transform = `translateY(${this.body.offsetTop + stuck.top}px)`;
    }
  }

  private createRow(row: Row): HTMLElement {
    const style = `top:${row.top}px;height:${row.height}px`;
    if (row.kind === "month") {
      return h("div", { class: "row month-row", style }, h("h2", null, row.label), h("span", null, plural(row.count, "item")));
    }
    if (row.kind === "day") {
      return h("div", { class: "row day-row", style }, h("h3", null, row.label), h("span", null, formatCount(row.count)));
    }
    const layout = this.layout!;
    const element = h("div", {
      class: "row tiles-row",
      style: `${style};grid-template-columns:repeat(${row.count},${layout.tile}px);gap:${GAP}px`,
    });
    for (let offset = 0; offset < row.count; offset++) {
      const tile = h("button", { class: "tile", type: "button", role: "option", tabIndex: -1, data: { index: row.start + offset } });
      this.paintTile(tile, row.start + offset);
      element.append(tile);
    }
    return element;
  }

  private paintTile(tile: HTMLElement, index: number): void {
    const item = this.cache.get(index);
    if (!item) {
      tile.classList.add("loading");
      return;
    }
    tile.classList.remove("loading");
    if (tile.dataset.id !== String(item.id)) {
      tile.dataset.id = String(item.id);
      tile.title = item.fileName;
      tile.setAttribute("aria-label", item.fileName);
      clear(tile);
      tile.classList.remove("loaded", "broken");
      tile.append(h("span", { class: "tile-placeholder" }, icon(item.mediaType === "video" ? "film" : "image", 22)));
      if (item.mediaType === "photo") {
        const image = h("img", {
          src: thumbUrl(item),
          alt: "",
          decoding: "async",
          draggable: false,
          onload: () => tile.classList.add("loaded"),
          onerror: () => tile.classList.add("broken"),
        });
        // Scrolling back over thumbnails the browser already holds: show them at once, no re-fade.
        if (image.complete && image.naturalWidth > 0) tile.classList.add("loaded");
        tile.append(image);
      }
      tile.append(
        h("span", { class: "tile-check" }, icon("check", 13)),
        h("span", { class: "tile-favorite" }, icon("heart", 13)),
      );
      if (item.mediaType === "video") tile.append(h("span", { class: "tile-badge" }, icon("play", 10), "VIDEO"));
      if (!item.available) tile.append(h("span", { class: "tile-badge offline" }, icon("unplug", 10), "OFFLINE"));
    }
    tile.classList.toggle("video", item.mediaType === "video");
    tile.classList.toggle("offline", !item.available);
    tile.classList.toggle("is-favorite", item.favorite);
    const selected = this.selected.has(item.id);
    tile.classList.toggle("selected", selected);
    tile.classList.toggle("cursor", index === this.cursor);
    tile.setAttribute("aria-selected", String(selected));
  }

  private paintVisible(): void {
    this.rowElements.forEach((element) => {
      element.querySelectorAll<HTMLElement>(".tile").forEach((tile) => this.paintTile(tile, Number(tile.dataset.index)));
    });
  }

  // ---- data paging ---------------------------------------------------------------------

  private async ensure(first: number, last: number): Promise<void> {
    const pages: Promise<void>[] = [];
    for (let page = Math.floor(first / PAGE_SIZE); page <= Math.floor(last / PAGE_SIZE); page++) {
      pages.push(this.loadPage(page));
    }
    await Promise.all(pages);
  }

  private loadPage(page: number): Promise<void> {
    if (this.loadedPages.has(page)) return Promise.resolve();
    const existing = this.inflight.get(page);
    if (existing) return existing;
    const generation = this.generation;
    const request = api
      .listMedia(this.options.getFilter(), page * PAGE_SIZE, PAGE_SIZE)
      .then((items) => {
        if (generation !== this.generation || this.disposed) return;
        items.forEach((item, offset) => this.cache.set(page * PAGE_SIZE + offset, item));
        this.loadedPages.add(page);
        this.paintVisible();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight.get(page) === request) this.inflight.delete(page);
      });
    this.inflight.set(page, request);
    return request;
  }

  /** Item at a position in the listing, fetching its page when needed. */
  async itemAt(index: number): Promise<MediaItem | undefined> {
    if (index < 0 || index >= this.data.total) return undefined;
    const cached = this.cache.get(index);
    if (cached) return cached;
    await this.loadPage(Math.floor(index / PAGE_SIZE));
    return this.cache.get(index);
  }

  peek(index: number): MediaItem | undefined {
    return this.cache.get(index);
  }

  /** Apply a change (for example a new favorite state) to cached copies of an item. */
  updateItem(id: number, patch: Partial<MediaItem>): void {
    for (const item of this.cache.values()) {
      if (item.id === id) Object.assign(item, patch);
    }
    this.paintVisible();
  }

  async indexOfId(id: number): Promise<number | null> {
    return api.position(this.options.getFilter(), id);
  }

  // ---- scrolling -----------------------------------------------------------------------

  private firstVisibleIndex(): number {
    if (!this.layout) return -1;
    const y = Math.max(0, this.options.scroller.scrollTop - this.body.offsetTop);
    for (let index = rowIndexAt(this.layout.rows, y); index < this.layout.rows.length; index++) {
      const row = this.layout.rows[index];
      if (row.kind === "tiles") return row.start;
    }
    return -1;
  }

  scrollToIndex(index: number, align: "nearest" | "center" = "nearest"): void {
    const layout = this.layout;
    if (!layout || index < 0) return;
    const rowIndex = rowIndexForItem(layout, index);
    if (rowIndex < 0) return;
    const row = layout.rows[rowIndex];
    const scroller = this.options.scroller;
    const top = this.body.offsetTop + row.top;
    const bottom = top + row.height;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    if (align === "center") {
      scroller.scrollTop = top - (scroller.clientHeight - row.height) / 2;
    } else if (top < viewTop + 56) {
      // leave room for the sticky month label
      scroller.scrollTop = top - 56;
    } else if (bottom > viewBottom) {
      scroller.scrollTop = bottom - scroller.clientHeight + 8;
    }
    this.scheduleRender();
  }

  // ---- selection -----------------------------------------------------------------------

  get selectedCount(): number {
    return this.selected.size;
  }

  selectedIds(): number[] {
    return [...this.selected];
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  /** Items of the current selection, using cached data and falling back to the database. */
  async selectedItems(): Promise<MediaItem[]> {
    const byId = new Map<number, MediaItem>();
    for (const item of this.cache.values()) if (this.selected.has(item.id)) byId.set(item.id, item);
    const missing = [...this.selected].filter((id) => !byId.has(id));
    await Promise.all(
      missing.slice(0, 200).map(async (id) => {
        const item = await api.getMedia(id);
        if (item) byId.set(id, item);
      }),
    );
    return [...byId.values()];
  }

  clearSelection(): void {
    if (this.selected.size === 0 && this.anchor < 0) return;
    this.selected.clear();
    this.anchor = -1;
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  restoreSelection(ids: number[], anchor: number, cursor: number): void {
    this.selected = new Set(ids);
    this.anchor = anchor;
    this.cursor = cursor;
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  async selectAll(): Promise<void> {
    const ids = await api.ids(this.options.getFilter(), 0, 200_000);
    this.selected = new Set(ids);
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  /** Select exactly one item and make it the keyboard cursor. */
  async selectOnly(index: number, scroll = true): Promise<void> {
    const item = await this.itemAt(index);
    if (!item) return;
    this.selected = new Set([item.id]);
    this.anchor = index;
    this.cursor = index;
    if (scroll) this.scrollToIndex(index);
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  private async selectRange(from: number, to: number): Promise<void> {
    const start = Math.min(from, to);
    const count = Math.abs(to - from) + 1;
    const ids = await api.ids(this.options.getFilter(), start, count);
    this.selected = new Set(ids);
    this.cursor = to;
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  private async toggle(index: number): Promise<void> {
    const item = await this.itemAt(index);
    if (!item) return;
    if (this.selected.has(item.id)) this.selected.delete(item.id);
    else this.selected.add(item.id);
    this.anchor = index;
    this.cursor = index;
    this.paintVisible();
    this.options.host.onSelectionChange();
  }

  private indexFromEvent(event: Event): number {
    const tile = (event.target as HTMLElement).closest<HTMLElement>(".tile");
    return tile ? Number(tile.dataset.index) : -1;
  }

  private onClick = (event: MouseEvent) => {
    const index = this.indexFromEvent(event);
    if (index < 0) {
      this.clearSelection();
      return;
    }
    if (event.shiftKey && this.anchor >= 0) void this.selectRange(this.anchor, index);
    else if (event.ctrlKey || event.metaKey) void this.toggle(index);
    else void this.selectOnly(index, false);
  };

  private onDoubleClick = (event: MouseEvent) => {
    const index = this.indexFromEvent(event);
    if (index >= 0) this.options.host.onOpen(index, "viewer");
  };

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const index = this.indexFromEvent(event);
    if (index < 0) return;
    const item = this.cache.get(index);
    const run = () => this.options.host.onContextMenu(index, event.clientX, event.clientY);
    if (item && this.selected.has(item.id)) run();
    else void this.selectOnly(index, false).then(run);
  };

  // ---- keyboard ------------------------------------------------------------------------

  /** Returns true when the key was handled. The shell only calls this while no overlay is open. */
  handleKey(event: KeyboardEvent): boolean {
    const total = this.data.total;
    if (total === 0 || !this.layout) return false;
    const columns = this.layout.columns;
    const move = (delta: number) => {
      // First arrow press with nothing selected lands on the first photo, like Explorer.
      const next = this.cursor < 0 ? 0 : Math.min(total - 1, Math.max(0, this.cursor + delta));
      this.moveCursor(next, event.shiftKey);
    };
    switch (event.key) {
      case "ArrowRight":
        move(1);
        return true;
      case "ArrowLeft":
        move(-1);
        return true;
      case "ArrowDown":
        move(columns);
        return true;
      case "ArrowUp":
        move(-columns);
        return true;
      case "Home":
        this.moveCursor(0, event.shiftKey);
        return true;
      case "End":
        this.moveCursor(total - 1, event.shiftKey);
        return true;
      case "PageDown":
      case "PageUp": {
        const rows = Math.max(1, Math.floor(this.options.scroller.clientHeight / (this.layout.tile + GAP)) - 1);
        move((event.key === "PageDown" ? 1 : -1) * rows * columns);
        return true;
      }
      case "Enter":
        if (this.cursor >= 0) this.options.host.onOpen(this.cursor, "viewer");
        return this.cursor >= 0;
      case " ":
        if (this.cursor >= 0) this.options.host.onOpen(this.cursor, "quicklook");
        return this.cursor >= 0;
      case "a":
      case "A":
        if (event.ctrlKey || event.metaKey) {
          void this.selectAll();
          return true;
        }
        return false;
      case "Escape":
        if (this.selected.size > 0) {
          this.clearSelection();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private moveCursor(index: number, extend: boolean): void {
    this.cursor = index;
    if (extend && this.anchor >= 0) void this.selectRange(this.anchor, index);
    else void this.selectOnly(index);
    this.scrollToIndex(index);
  }
}

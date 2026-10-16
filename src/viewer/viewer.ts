import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, originalUrl, thumbUrl, type MediaItem, type MetaField } from "../lib/api";
import { clear, h } from "../lib/dom";
import { folderName, formatBytes, formatCount, formatDateTime } from "../lib/format";
import { icon, type IconName } from "../lib/icons";
import { clampPan, fitScale, zoomAround, MAX_SCALE, type Size, type Transform } from "./zoom";

export interface ViewerSource {
  itemAt(index: number): Promise<MediaItem | undefined>;
}

export interface ViewerHooks {
  /** Called once the viewer is gone; `index` is the item that was on screen. */
  onClose(index: number): void;
  onFavorite(item: MediaItem): void;
  /** Confirm and move the item to the Recycle Bin. Resolves the new item count, or null if cancelled. */
  onTrash(item: MediaItem): Promise<number | null>;
  /** "Show in Folder" / "Show in Timeline" depending on where the viewer was opened from. */
  locate: { label: string; icon: IconName; run(item: MediaItem): void };
}

export type ViewerMode = "viewer" | "quicklook";

const ZOOM_STEP = 1.25;
const ANIMATE_MS = 200;

export class Viewer {
  private root: HTMLElement | null = null;
  private stage!: HTMLElement;
  private image: HTMLImageElement | null = null;
  private video: HTMLVideoElement | null = null;
  private status!: HTMLElement;
  private title!: HTMLElement;
  private counter!: HTMLElement;
  private inspector!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private favoriteButton!: HTMLButtonElement;
  private fullscreenButton!: HTMLButtonElement;
  private previousButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;

  private source!: ViewerSource;
  private hooks!: ViewerHooks;
  private mode: ViewerMode = "viewer";
  private index = 0;
  private total = 0;
  private item: MediaItem | null = null;
  private natural: Size = { width: 0, height: 0 };
  private transform: Transform = { scale: 1, x: 0, y: 0 };
  private fit = 1;
  private showToken = 0;
  private inspectorOpen = false;
  private enteredFullscreen = false;
  private drag: { pointer: number; startX: number; startY: number; originX: number; originY: number } | null = null;
  private animateTimer = 0;
  private resizeObserver: ResizeObserver | null = null;

  get isOpen(): boolean {
    return this.root !== null;
  }

  get currentIndex(): number {
    return this.index;
  }

  async open(source: ViewerSource, index: number, total: number, mode: ViewerMode, hooks: ViewerHooks, inspector = false): Promise<void> {
    if (this.root) this.teardown(false);
    this.source = source;
    this.hooks = hooks;
    this.mode = mode;
    this.total = total;
    this.index = index;
    this.inspectorOpen = inspector;
    this.build();
    document.addEventListener("keydown", this.onKey, true);
    await this.show(index);
  }

  /** Update the number of items after the library changed underneath the viewer. */
  setTotal(total: number): void {
    this.total = total;
    this.updateChrome();
  }

  close(): void {
    if (!this.root) return;
    const index = this.index;
    this.teardown(true);
    this.hooks.onClose(index);
  }

  // ---- construction --------------------------------------------------------------------

  private tool(name: IconName, label: string, onclick: () => void, size = 18): HTMLButtonElement {
    return h("button", { class: "viewer-tool", type: "button", title: label, aria: { label }, onclick }, icon(name, size));
  }

  private build(): void {
    this.title = h("strong");
    this.counter = h("span");
    this.zoomLabel = h("button", { class: "viewer-zoom-label", type: "button", title: "Fit to window (Ctrl+0)", onclick: () => this.fitToWindow(true) }, "Fit");
    this.favoriteButton = this.tool("heart", "Favorite (F)", () => void this.toggleFavorite());
    this.fullscreenButton = this.tool("fullscreen", "Full screen (F11)", () => void this.toggleFullscreen());
    this.previousButton = h("button", { class: "viewer-nav prev", type: "button", aria: { label: "Previous" }, onclick: () => void this.go(-1) }, icon("chevron-left", 28));
    this.nextButton = h("button", { class: "viewer-nav next", type: "button", aria: { label: "Next" }, onclick: () => void this.go(1) }, icon("chevron-right", 28));
    this.status = h("div", { class: "viewer-status" });
    this.stage = h("div", { class: "viewer-stage" }, this.status);
    this.inspector = h("aside", { class: "viewer-inspector", aria: { label: "Information" } });

    const bar = h(
      "div",
      { class: "viewer-bar" },
      h("button", { class: "viewer-tool", type: "button", title: "Close (Esc)", aria: { label: "Close" }, onclick: () => this.close() }, icon("close", 19)),
      h("div", { class: "viewer-heading" }, this.title, this.counter),
      h(
        "div",
        { class: "viewer-tools" },
        this.tool("zoom-out", "Zoom out (Ctrl+−)", () => this.zoomBy(1 / ZOOM_STEP, true)),
        this.zoomLabel,
        this.tool("zoom-in", "Zoom in (Ctrl++)", () => this.zoomBy(ZOOM_STEP, true)),
        h("span", { class: "viewer-divider" }),
        this.favoriteButton,
        this.tool("info", "Information (I)", () => this.toggleInspector()),
        this.tool(this.hooks.locate.icon, this.hooks.locate.label, () => this.item && this.hooks.locate.run(this.item)),
        this.tool("external", "Show in File Explorer", () => this.item && void api.reveal(this.item.path)),
        this.tool("trash", "Move to Recycle Bin (Delete)", () => void this.trashCurrent()),
        this.fullscreenButton,
      ),
    );

    this.root = h(
      "div",
      { class: `viewer ${this.mode === "quicklook" ? "quicklook" : ""}`, role: "dialog", aria: { modal: true, label: "Photo viewer" } },
      bar,
      h("div", { class: "viewer-main" }, this.previousButton, this.stage, this.nextButton, this.inspector),
    );
    this.root.classList.toggle("inspector-open", this.inspectorOpen);
    this.stage.addEventListener("wheel", this.onWheel, { passive: false });
    this.stage.addEventListener("pointerdown", this.onPointerDown);
    this.stage.addEventListener("pointermove", this.onPointerMove);
    this.stage.addEventListener("pointerup", this.onPointerUp);
    this.stage.addEventListener("pointercancel", this.onPointerUp);
    this.stage.addEventListener("dblclick", this.onDoubleClick);
    this.stage.addEventListener("click", (event) => {
      // Click on the empty backdrop closes Quick Look, like on macOS.
      if (this.mode === "quicklook" && event.target === this.stage) this.close();
    });
    document.querySelector("#overlay-root")?.append(this.root);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.stage);
    this.stage.focus?.();
  }

  private teardown(restoreFullscreen: boolean): void {
    document.removeEventListener("keydown", this.onKey, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.clearTimeout(this.animateTimer);
    this.video?.pause();
    this.showToken++;
    this.root?.remove();
    this.root = null;
    this.image = null;
    this.video = null;
    this.item = null;
    if (restoreFullscreen && this.enteredFullscreen) {
      this.enteredFullscreen = false;
      void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    }
  }

  // ---- showing an item -----------------------------------------------------------------

  private async show(index: number): Promise<void> {
    const token = ++this.showToken;
    this.index = index;
    this.updateChrome();
    const item = await this.source.itemAt(index);
    if (token !== this.showToken || !this.root || !item) return;
    this.item = item;
    this.updateChrome();
    this.renderInspector();
    this.video?.pause();
    this.stage.querySelectorAll(".viewer-media").forEach((element) => element.remove());
    this.image = null;
    this.video = null;
    this.status.textContent = "";
    this.status.className = "viewer-status";

    if (item.mediaType === "video") {
      this.showVideo(item);
    } else {
      this.showImage(item, token);
    }
    this.prefetch(index - 1);
    this.prefetch(index + 1);
  }

  private showVideo(item: MediaItem): void {
    const video = h("video", {
      class: "viewer-media viewer-video",
      src: originalUrl(item),
      controls: true,
      autoplay: true,
      onerror: () => this.setStatus("This video can't be played here.", "error"),
    });
    this.video = video;
    this.stage.prepend(video);
    this.zoomLabel.textContent = "—";
  }

  private showImage(item: MediaItem, token: number): void {
    // Show the cached thumbnail straight away, then swap in the original once decoded.
    const image = h("img", {
      class: "viewer-media viewer-image",
      src: thumbUrl(item),
      alt: item.fileName,
      draggable: false,
    });
    this.image = image;
    const known = item.width && item.height ? { width: item.width, height: item.height } : null;
    if (known) this.applyNatural(known);
    this.stage.prepend(image);
    image.classList.add("preview");
    this.setStatus("Loading", "loading");

    const full = new Image();
    full.src = originalUrl(item);
    full
      .decode()
      .then(() => {
        if (token !== this.showToken || this.image !== image) return;
        image.src = full.src;
        image.classList.remove("preview");
        if (!known) this.applyNatural({ width: full.naturalWidth, height: full.naturalHeight });
        this.setStatus("", "");
      })
      .catch(() => {
        if (token !== this.showToken || this.image !== image) return;
        image.classList.remove("preview");
        this.setStatus(item.available ? "This photo can't be opened." : "The source is offline. Showing the cached preview.", "error");
        if (!known) {
          image.onload = () => this.applyNatural({ width: image.naturalWidth, height: image.naturalHeight });
        }
      });
    if (!known) {
      image.onload = () => {
        if (this.image === image && !this.natural.width) this.applyNatural({ width: image.naturalWidth, height: image.naturalHeight });
      };
    }
  }

  private applyNatural(size: Size): void {
    if (!this.image || !size.width) return;
    this.natural = size;
    this.image.style.width = `${size.width}px`;
    this.image.style.height = `${size.height}px`;
    this.fitToWindow(false);
  }

  private setStatus(text: string, kind: "loading" | "error" | ""): void {
    this.status.className = `viewer-status ${kind}`;
    clear(this.status);
    if (!text) return;
    if (kind === "loading") this.status.append(icon("loader", 18));
    this.status.append(h("span", null, text));
  }

  private prefetch(index: number): void {
    if (index < 0 || index >= this.total) return;
    void this.source.itemAt(index).then((item) => {
      if (item && item.mediaType === "photo" && item.available) new Image().src = originalUrl(item);
    });
  }

  private updateChrome(): void {
    if (!this.root) return;
    this.title.textContent = this.item?.fileName ?? "";
    this.counter.textContent = `${formatCount(this.index + 1)} of ${formatCount(this.total)}`;
    this.previousButton.disabled = this.index <= 0;
    this.nextButton.disabled = this.index >= this.total - 1;
    const favorite = this.item?.favorite ?? false;
    this.favoriteButton.classList.toggle("active", favorite);
    this.favoriteButton.title = favorite ? "Remove from Favorites (F)" : "Favorite (F)";
    this.favoriteButton.setAttribute("aria-pressed", String(favorite));
  }

  // ---- zoom & pan ----------------------------------------------------------------------

  private stageSize(): Size {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }

  private applyTransform(animate: boolean): void {
    if (!this.image) return;
    const { scale, x, y } = this.transform;
    this.image.classList.toggle("animate", animate);
    this.image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.zoomLabel.textContent = Math.abs(scale - this.fit) < 0.001 ? "Fit" : `${Math.round(scale * 100)}%`;
    this.stage.classList.toggle("zoomed", scale > this.fit + 0.001);
    if (animate) {
      window.clearTimeout(this.animateTimer);
      this.animateTimer = window.setTimeout(() => this.image?.classList.remove("animate"), ANIMATE_MS + 40);
    }
  }

  private fitToWindow(animate: boolean): void {
    if (!this.natural.width) return;
    const stage = this.stageSize();
    this.fit = fitScale(this.natural, stage);
    this.transform = clampPan({ scale: this.fit, x: 0, y: 0 }, this.natural, stage);
    this.applyTransform(animate);
  }

  private zoomTo(scale: number, around: { x: number; y: number } | null, animate: boolean): void {
    if (!this.natural.width) return;
    const stage = this.stageSize();
    const point = around ?? { x: stage.width / 2, y: stage.height / 2 };
    const next = Math.min(MAX_SCALE, Math.max(this.fit, scale));
    this.transform = zoomAround(this.transform, next, point, this.natural, stage);
    this.applyTransform(animate);
  }

  private zoomBy(factor: number, animate: boolean, around: { x: number; y: number } | null = null): void {
    this.zoomTo(this.transform.scale * factor, around, animate);
  }

  private onResize(): void {
    if (!this.natural.width) return;
    const wasFit = Math.abs(this.transform.scale - this.fit) < 0.001;
    const stage = this.stageSize();
    this.fit = fitScale(this.natural, stage);
    this.transform = wasFit
      ? clampPan({ scale: this.fit, x: 0, y: 0 }, this.natural, stage)
      : clampPan({ ...this.transform, scale: Math.max(this.fit, this.transform.scale) }, this.natural, stage);
    this.applyTransform(false);
  }

  private pointInStage(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.image) return;
    event.preventDefault();
    const sensitivity = event.ctrlKey ? 0.01 : 0.0015;
    this.zoomBy(Math.exp(-event.deltaY * sensitivity), false, this.pointInStage(event));
  };

  private onDoubleClick = (event: MouseEvent) => {
    if (!this.image || event.target !== this.image) return;
    if (this.transform.scale > this.fit + 0.001) this.fitToWindow(true);
    else this.zoomTo(Math.max(1, this.fit * 2.5), this.pointInStage(event), true);
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.image || event.button !== 0 || this.transform.scale <= this.fit + 0.001) return;
    this.drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, originX: this.transform.x, originY: this.transform.y };
    this.stage.setPointerCapture(event.pointerId);
    this.stage.classList.add("panning");
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    const next = {
      scale: this.transform.scale,
      x: this.drag.originX + event.clientX - this.drag.startX,
      y: this.drag.originY + event.clientY - this.drag.startY,
    };
    this.transform = clampPan(next, this.natural, this.stageSize());
    this.applyTransform(false);
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    this.drag = null;
    this.stage.classList.remove("panning");
  };

  // ---- actions -------------------------------------------------------------------------

  private async go(delta: number): Promise<void> {
    const next = this.index + delta;
    if (next < 0 || next >= this.total) return;
    await this.show(next);
  }

  private async toggleFavorite(): Promise<void> {
    const item = this.item;
    if (!item) return;
    try {
      item.favorite = await api.toggleFavorite(item.id);
      this.hooks.onFavorite(item);
      this.updateChrome();
    } catch {
      /* the item vanished from the library; the next reload will reflect that */
    }
  }

  private toggleInspector(): void {
    this.inspectorOpen = !this.inspectorOpen;
    this.root?.classList.toggle("inspector-open", this.inspectorOpen);
    this.renderInspector();
  }

  private async toggleFullscreen(): Promise<void> {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    this.enteredFullscreen = next;
    this.fullscreenButton.replaceChildren(icon(next ? "fullscreen-exit" : "fullscreen", 18));
  }

  private async trashCurrent(): Promise<void> {
    const item = this.item;
    if (!item) return;
    const remaining = await this.hooks.onTrash(item);
    if (remaining === null) return;
    this.total = remaining;
    if (remaining === 0) {
      this.close();
      return;
    }
    await this.show(Math.min(this.index, remaining - 1));
  }

  // ---- inspector -----------------------------------------------------------------------

  private renderInspector(): void {
    clear(this.inspector);
    const item = this.item;
    if (!this.inspectorOpen || !item) return;
    const rows = (entries: [string, string | null][]) =>
      entries
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([label, value]) => [h("dt", null, label), h("dd", null, value)])
        .flat();
    const megapixels = item.width && item.height ? ` · ${((item.width * item.height) / 1_000_000).toFixed(1)} MP` : "";
    const exifList = h("dl", { class: "inspector-list" });
    const exifHeading = h("h4", null, "Camera");
    exifHeading.hidden = true;
    this.inspector.append(
      h("h3", null, "Information"),
      h(
        "dl",
        { class: "inspector-list" },
        ...rows([
          ["Name", item.fileName],
          ["Kind", `${item.extension.toUpperCase()} ${item.mediaType === "video" ? "video" : "image"}`],
          ["Dimensions", item.width && item.height ? `${item.width} × ${item.height}${megapixels}` : null],
          ["Size", formatBytes(item.fileSize)],
          ["Captured", formatDateTime(item.capturedAt)],
          ["Modified", formatDateTime(item.modifiedAt)],
          ["Added", formatDateTime(item.addedAt)],
          ["Folder", folderName(item.folderPath)],
        ]),
      ),
      h("p", { class: "inspector-path", title: item.path }, item.path),
      exifHeading,
      exifList,
    );
    if (item.mediaType === "photo") {
      const token = this.showToken;
      void api
        .exif(item.id)
        .then((fields: MetaField[]) => {
          if (token !== this.showToken || fields.length === 0) return;
          exifHeading.hidden = false;
          exifList.append(...fields.flatMap((field) => [h("dt", null, field.label), h("dd", null, field.value)]));
        })
        .catch(() => undefined);
    }
  }

  // ---- keyboard ------------------------------------------------------------------------

  private onKey = (event: KeyboardEvent) => {
    if (!this.root || document.querySelector(".dialog-backdrop")) return;
    const key = event.key;
    const ctrl = event.ctrlKey || event.metaKey;
    const handled = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (key === "Escape") return handled(() => this.close());
    if (key === " " && !(this.video && this.mode === "viewer")) {
      return handled(() => (this.video ? this.toggleVideo() : this.close()));
    }
    if (key === " ") return handled(() => this.toggleVideo());
    if (key === "ArrowLeft") return handled(() => void this.go(-1));
    if (key === "ArrowRight") return handled(() => void this.go(1));
    if (key === "Delete") return handled(() => void this.trashCurrent());
    if (key === "F11") return handled(() => void this.toggleFullscreen());
    if (ctrl && (key === "+" || key === "=")) return handled(() => this.zoomBy(ZOOM_STEP, true));
    if (ctrl && (key === "-" || key === "_")) return handled(() => this.zoomBy(1 / ZOOM_STEP, true));
    if (ctrl && key === "0") return handled(() => this.fitToWindow(true));
    if (!ctrl && (key === "f" || key === "F")) return handled(() => void this.toggleFavorite());
    if (!ctrl && (key === "i" || key === "I")) return handled(() => this.toggleInspector());
    if (key === "Tab") event.preventDefault();
  };

  private toggleVideo(): void {
    if (!this.video) return;
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }
}

export { MAX_SCALE };

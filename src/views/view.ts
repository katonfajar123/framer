/** A screen that can be mounted into the shell's scrolling content area. */
export interface View {
  /** Show the toolbar search box and thumbnail-size slider for this screen. */
  gallery: boolean;
  dispose(): void;
  setSearch?(query: string): void;
  /** Files were added, removed or favorited. */
  onLibraryChanged?(): void;
  onTileSizeChanged?(): void;
  handleKey?(event: KeyboardEvent): boolean;
  /** The shell asks the view to re-render when shared state (sources, settings) changes. */
  onStateChanged?(): void;
}

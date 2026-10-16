# Framer

_Your gallery on Windows 11._

Framer is a quiet, local-first photo and video gallery for Windows 11, built with **Tauri 2 + Rust** and a
dependency-light **TypeScript** UI. Pick your folders and Framer builds a gallery from the files that are
already on your computer. Nothing is imported, copied or uploaded: **your files stay yours.**

| Mode       | What it does                                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| Library    | Every photo and video from your sources, on one timeline grouped by year, month, day |
| Folders    | The real folder structure, with a sidebar tree, breadcrumbs and subfolder cards      |
| Disk Usage | Read-only drive and folder analysis, with large-file and cleanup guidance            |
| Albums     | _Planned for a later release (the sidebar entry is a placeholder)_                   |

## Run it

Requirements: Windows 11, [Rust](https://rustup.rs) (MSVC toolchain), Node.js 20+, and the WebView2 runtime
(already part of Windows 11).

```powershell
npm install
npm run desktop          # tauri dev: Vite + Rust with hot reload
npm run desktop:build    # release build + installer in src-tauri/target/release/bundle
```

Tests:

```powershell
npm test                 # TypeScript logic (virtual-grid layout, zoom maths, formatting)
npm run test:rust        # indexer, search, EXIF, thumbnails, watcher, migrations
npm run check            # tsc --noEmit
```

## What is in v0.1

**Library** — timeline by year/month/day with a sticky month label, a virtualised grid (only the rows on screen
exist in the DOM, so 50 000 items cost the same as 50), adjustable thumbnail size, _Fit_ vs _Fill_ thumbnails,
Recently Added, Favorites, Videos and Screenshots views, multi-select (Ctrl/Shift/keyboard), per-view scroll and
selection memory, and Back/Forward between views.

**Indexing** — add one or more folders (subfolders included). Scanning runs on a background thread, commits in
batches so photos appear immediately, skips files whose size and modified time did not change, reads the real
capture date and orientation from EXIF, and can be **paused or cancelled** from the sidebar. Overlapping sources
(`D:\Photos` and `D:\Photos\2026`) are refused so nothing appears twice. A file watcher picks up changes while
Framer is open.

**Viewer + Quick Look** — `Space` for Quick Look, `Enter` to open. Wheel/pinch zoom around the cursor, drag to pan,
`Ctrl +` / `Ctrl −` / `Ctrl 0`, double-click to zoom, full-screen (`F11`), previous/next with prefetching,
favorite (`F`), information panel (`I`) with file facts and camera EXIF, `Esc` returns to the same selected tile.
Originals load straight from disk (no re-encoding); the cached thumbnail shows instantly while they decode.

**Search** — `Ctrl+F`. File names, folders, formats, years, months and dates: `sunset.jpg`, `Bali`, `PNG`,
`2026`, `October 2026`, `2026-10-24`, `videos`. Every word must match.

**Disk Usage** — analyze an entire drive such as `C:\` or `D:\`, or choose a specific folder. Results can be
opened folder-by-folder to reveal where space is used, with separate lists for the largest files and conservative
cleanup suggestions. Scans run off the UI thread, report live progress, can be cancelled, stay entirely local,
and never delete or modify files. Suggestions distinguish regeneratable cache/temp data from personal files that
need careful review.

**Safe by design**

- _Remove from Framer_ (Sources) only forgets the index. _Move to Recycle Bin_ (`Delete`) is a separate, explicit,
  confirmed action that uses the Windows Recycle Bin, so it is always recoverable.
- An unplugged drive never wipes the index: the source is marked **unavailable**, photos stay browsable with cached
  thumbnails and an _offline_ badge, it reconnects by itself when the drive returns, and **Locate Folder** relinks
  a moved source while keeping favorites.
- Favorites live in their own table keyed by path, so rescans and re-adding a folder never lose them.

**Settings** — theme (Follow Windows / Light / Dark), default thumbnail size, folder watching, scan on launch,
thumbnail cache size limit (oldest thumbnails evicted first) and one-click cache clearing.

## How it is built

```
src/                  TypeScript UI (no framework)
  grid/               virtual grid engine: layout.ts (pure, unit-tested) + media-grid.ts
  viewer/             viewer, Quick Look, zoom/pan maths (zoom.ts, unit-tested)
  views/              library, folders, sources, settings, welcome
  shell.ts            sidebar (+ folder tree), toolbar, routing, global shortcuts
  styles/             design tokens + component CSS (Segoe UI Variable, 232px sidebar, 4px grid gap)
src-tauri/src/
  scan.rs             background indexer: batches, pause/cancel, safe pruning
  watch.rs            file watchers, debounce, drive plug/unplug detection
  media.rs            queries: views, timeline groups, positions, favorites, Recycle Bin
  search.rs           search box -> SQL (parameterised, never string-built)
  thumbs.rs           thumbnail cache, bounded decode pool, EXIF rotation, framer-thumb:// protocol
  disk.rs             read-only drive scanner, folder rollups, large files, cleanup guidance
  folders.rs          folder tree for the sidebar and breadcrumbs
  sources.rs          add / remove / relink sources, overlap detection
  db.rs               SQLite (WAL), versioned migrations
```

- The index is a single SQLite file in `%APPDATA%\com.frame.gallery\frame.db`; thumbnails are JPEGs in
  `thumbnails\` next to it. Both can be deleted at any time without touching your photos.
- Thumbnails are served by a custom `framer-thumb://` protocol, so the browser lazy-loads and cancels them like
  ordinary images and the UI thread never decodes anything. Originals use Tauri's scoped `asset:` protocol, limited
  to the folders you added.
- `FRAMER_DATA_DIR` overrides the data folder (with `FRAME_DATA_DIR` retained as a compatibility alias).

## Known limits (v0.1)

- **Gallery-first**: rename / move / copy are done in File Explorer; Framer only offers _Show in File Explorer_
  and _Move to Recycle Bin_.
- Photos: JPEG, PNG, WebP, GIF (first frame). Videos (MP4, MOV, M4V, WebM) are listed and play in the viewer when
  WebView2 supports the codec, but have no thumbnails yet. HEIC and RAW are not supported.
- Albums, bulk rename/move, duplicate finder, slideshow and editing are Phase 2/3.
- The "Fit" thumbnail toggle and thumbnail size apply to all grid views.

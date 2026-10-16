import { api } from "../lib/api";
import { h, mount } from "../lib/dom";
import { formatBytes } from "../lib/format";
import { icon } from "../lib/icons";
import { refreshStats, saveSetting } from "../data";
import { GRID_MAX, GRID_MIN, gridSize, state } from "../state";
import { currentTheme } from "../theme";
import { confirmDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import type { View } from "./view";

function row(
  title: string,
  description: string,
  control: HTMLElement,
): HTMLElement {
  return h(
    "div",
    { class: "setting-row" },
    h(
      "div",
      { class: "setting-text" },
      h("strong", null, title),
      h("span", null, description),
    ),
    control,
  );
}

function group(title: string, ...rows: HTMLElement[]): HTMLElement {
  return h(
    "section",
    { class: "settings-group" },
    h("h2", null, title),
    h("div", { class: "setting-card" }, ...rows),
  );
}

function switchControl(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  return h("input", {
    type: "checkbox",
    role: "switch",
    class: "switch",
    checked,
    aria: { label },
    onchange: (event: Event) =>
      onChange((event.target as HTMLInputElement).checked),
  });
}

const CACHE_LIMITS = [
  [512, "512 MB"],
  [1024, "1 GB"],
  [2048, "2 GB"],
  [5120, "5 GB"],
  [10240, "10 GB"],
] as const;

const SHORTCUTS: [string, string][] = [
  ["Space", "Quick Look the selected photo"],
  ["Enter", "Open the selected photo"],
  ["← →", "Previous / next photo"],
  ["Esc", "Close the viewer"],
  ["Ctrl + +  /  Ctrl + −", "Zoom in / out"],
  ["Ctrl + 0", "Fit to window"],
  ["F", "Favorite"],
  ["I", "Show information"],
  ["Delete", "Move to Recycle Bin (asks first)"],
  ["Ctrl + F", "Search"],
  ["Ctrl + A", "Select all"],
  ["Alt + ← →", "Back / forward between views"],
];

export function createSettingsView(scroller: HTMLElement): View {
  const render = () => {
    const theme = h(
      "select",
      {
        aria: { label: "Theme" },
        onchange: (event: Event) =>
          void saveSetting("theme", (event.target as HTMLSelectElement).value),
      },
      h(
        "option",
        { value: "system", selected: currentTheme() === "system" },
        "Follow Windows",
      ),
      h(
        "option",
        { value: "light", selected: currentTheme() === "light" },
        "Light",
      ),
      h(
        "option",
        { value: "dark", selected: currentTheme() === "dark" },
        "Dark",
      ),
    );

    const sizeLabel = h("span", { class: "range-value" }, `${gridSize()} px`);
    const size = h("input", {
      type: "range",
      min: String(GRID_MIN),
      max: String(GRID_MAX),
      value: String(gridSize()),
      aria: { label: "Default thumbnail size" },
      oninput: (event: Event) => {
        const value = (event.target as HTMLInputElement).value;
        sizeLabel.textContent = `${value} px`;
        void saveSetting("gridSize", value);
      },
    });

    const limit = h(
      "select",
      {
        aria: { label: "Thumbnail cache limit" },
        onchange: (event: Event) =>
          void saveSetting(
            "cacheLimitMb",
            (event.target as HTMLSelectElement).value,
          ),
      },
      ...CACHE_LIMITS.map(([megabytes, label]) =>
        h(
          "option",
          {
            value: String(megabytes),
            selected: Number(state.settings.cacheLimitMb) === megabytes,
          },
          label,
        ),
      ),
    );

    const clearCache = h(
      "button",
      {
        class: "subtle",
        type: "button",
        onclick: async () => {
          const confirmed = await confirmDialog({
            title: "Clear the thumbnail cache?",
            message:
              "Thumbnails are rebuilt from your photos as you browse. Your library and favorites are not affected.",
            confirmLabel: "Clear Cache",
          });
          if (!confirmed) return;
          await api.clearCache();
          await refreshStats();
          toast("Thumbnail cache cleared");
          render();
        },
      },
      "Clear Cache",
    );

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
            h("h1", null, "Settings"),
            h("p", null, "Make Framer feel right for you"),
          ),
        ),
        group(
          "Appearance",
          row("Theme", "Choose how Framer looks", theme),
          row(
            "Default thumbnail size",
            "Also adjustable from the toolbar while browsing",
            h("div", { class: "range-control" }, size, sizeLabel),
          ),
        ),
        group(
          "Indexing",
          row(
            "Watch folders for changes",
            "New, renamed and deleted files are picked up while Framer is open",
            switchControl(
              "Watch folders",
              state.settings.watchFolders !== "false",
              (value) => void saveSetting("watchFolders", String(value)),
            ),
          ),
          row(
            "Scan sources when Framer starts",
            "Quick check that skips files that have not changed",
            switchControl(
              "Scan on launch",
              state.settings.scanOnLaunch !== "false",
              (value) => void saveSetting("scanOnLaunch", String(value)),
            ),
          ),
          row(
            "Rescan everything now",
            "Re-check every source folder for changes",
            h(
              "button",
              {
                class: "subtle",
                type: "button",
                onclick: () =>
                  void api
                    .rescanAll()
                    .then(() => toast("Rescanning your sources"))
                    .catch((error) => toast(String(error), "error")),
              },
              icon("refresh", 15),
              "Rescan All",
            ),
          ),
        ),
        group(
          "Storage",
          row(
            "Thumbnail cache",
            `${formatBytes(state.stats.cacheBytes)} used · safe to clear at any time`,
            clearCache,
          ),
          row(
            "Cache size limit",
            "Oldest thumbnails are removed first when the limit is reached",
            limit,
          ),
        ),
        h(
          "section",
          { class: "settings-group" },
          h("h2", null, "Privacy"),
          h(
            "div",
            { class: "privacy-panel" },
            icon("shield", 22),
            h(
              "div",
              null,
              h("strong", null, "Your files stay yours."),
              h(
                "p",
                null,
                "Framer works offline, stores its index on this computer, and never uploads your media. Original files remain in their folders.",
              ),
            ),
          ),
        ),
        h(
          "section",
          { class: "settings-group" },
          h("h2", null, "Keyboard shortcuts"),
          h(
            "dl",
            { class: "shortcut-list" },
            ...SHORTCUTS.flatMap(([keys, action]) => [
              h("dt", null, h("kbd", null, keys)),
              h("dd", null, action),
            ]),
          ),
        ),
        h("p", { class: "about" }, "Framer 0.1.0 · Your gallery on Windows 11"),
      ),
    );
    // keep the slider's native value in sync after re-render
    size.value = String(gridSize());
  };
  render();
  return {
    gallery: false,
    dispose: () => mount(scroller),
    onStateChanged: render,
  };
}

import { state } from "./state";

export type Theme = "system" | "light" | "dark";

export function currentTheme(): Theme {
  const value = state.settings.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/** Apply the saved theme. "system" follows the Windows light/dark setting via CSS. */
export function applyTheme(): void {
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#1c1d1f" : "#f7f8fa");
  try {
    localStorage.setItem("framer-theme", theme); // read early by index.html to avoid a flash
  } catch {
    /* storage may be unavailable; the flash guard is a nicety only */
  }
}

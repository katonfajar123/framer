// Applies the saved theme before first paint so dark mode never flashes white.
try {
  var theme =
    localStorage.getItem("framer-theme") || localStorage.getItem("frame-theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
} catch (e) {}

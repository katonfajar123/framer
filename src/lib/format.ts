const LOCALE = "en-US";

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 || value >= 100 ? 0 : 1)} ${units[exponent]}`;
}

export function formatCount(count: number): string {
  return new Intl.NumberFormat(LOCALE).format(count);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** "2026-10-24" -> local Date at midnight. */
export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

const monthFormat = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { weekday: "long" });
const monthNameFormat = new Intl.DateTimeFormat(LOCALE, { month: "long" });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

/** "2026-10-24" -> "October 2026". */
export function monthLabel(day: string): string {
  return monthFormat.format(parseDay(day));
}

/** "2026-10-24" -> "Saturday, 24 October" (or "Today" / "Yesterday"). */
export function dayLabel(day: string, now = new Date()): string {
  const date = parseDay(day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const base = `${weekdayFormat.format(date)}, ${date.getDate()} ${monthNameFormat.format(date)}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

export function formatDateTime(seconds: number): string {
  return dateTime.format(new Date(seconds * 1000));
}

/** "just now", "5 minutes ago", "3 hours ago", otherwise the date. */
export function timeAgo(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.round(now / 1000 - seconds));
  if (diff < 45) return "just now";
  if (diff < 3600) return plural(Math.max(1, Math.round(diff / 60)), "minute") + " ago";
  if (diff < 86_400) return plural(Math.round(diff / 3600), "hour") + " ago";
  if (diff < 7 * 86_400) return plural(Math.round(diff / 86_400), "day") + " ago";
  return formatDateTime(seconds);
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

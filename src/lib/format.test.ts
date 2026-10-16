import { describe, expect, it } from "vitest";
import { dayLabel, formatBytes, monthLabel, plural, timeAgo } from "./format";

describe("dayLabel", () => {
  const now = new Date(2026, 9, 25, 15, 30);

  it("says Today and Yesterday, then spells the date out", () => {
    expect(dayLabel("2026-10-25", now)).toBe("Today");
    expect(dayLabel("2026-10-24", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-20", now)).toBe("Tuesday, 20 October");
  });

  it("adds the year for earlier years", () => {
    expect(dayLabel("2024-03-09", now)).toBe("Saturday, 9 March 2024");
  });
});

describe("monthLabel", () => {
  it("formats the month and year of a day key", () => {
    expect(monthLabel("2026-10-24")).toBe("October 2026");
  });
});

describe("formatBytes", () => {
  it("scales units and handles zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});

describe("plural and timeAgo", () => {
  it("pluralises with thousands separators", () => {
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(12408, "item")).toBe("12,408 items");
  });

  it("describes recent times in words", () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const at = (secondsAgo: number) => now / 1000 - secondsAgo;
    expect(timeAgo(at(10), now)).toBe("just now");
    expect(timeAgo(at(300), now)).toBe("5 minutes ago");
    expect(timeAgo(at(2 * 3600), now)).toBe("2 hours ago");
    expect(timeAgo(at(3 * 86_400), now)).toBe("3 days ago");
  });
});

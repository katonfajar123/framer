import { describe, expect, it } from "vitest";
import { computeLayout, groupByMonth, MONTH_HEIGHT, STICKY_HEIGHT, stickyMonth } from "./layout";

const now = new Date(2026, 9, 28, 12);

describe("month grouping", () => {
  const days = [
    { day: "2026-10-24", count: 3 },
    { day: "2026-10-02", count: 2 },
    { day: "2026-09-30", count: 4 },
  ];

  it("merges consecutive days of a month without touching the input", () => {
    expect(groupByMonth(days)).toEqual([
      { day: "2026-10-24", count: 5 },
      { day: "2026-09-30", count: 4 },
    ]);
    expect(days[0].count).toBe(3);
  });

  it("flows a month as one grid with no day headings, and is denser than day grouping", () => {
    const monthly = computeLayout({ width: 1000, targetTile: 184, gap: 4, groups: days, total: 9, grouping: "month", now });
    expect(monthly.rows.filter((row) => row.kind === "day")).toHaveLength(0);
    expect(monthly.rows.filter((row) => row.kind === "month")).toHaveLength(2);
    const tiles = monthly.rows.filter((row) => row.kind === "tiles");
    // 5 photos in October fill one row of five; 4 in September one row of four.
    expect(tiles.map((row) => row.kind === "tiles" && [row.start, row.count])).toEqual([
      [0, 5],
      [5, 4],
    ]);
    const daily = computeLayout({ width: 1000, targetTile: 184, gap: 4, groups: days, total: 9, grouping: "day", now });
    expect(monthly.height).toBeLessThan(daily.height);
  });
});

describe("stickyMonth", () => {
  const groups = [
    { day: "2026-10-24", count: 30 },
    { day: "2026-09-30", count: 30 },
  ];
  const layout = computeLayout({ width: 1000, targetTile: 184, gap: 4, groups, total: 60, grouping: "month", now });
  const [octoberRow, septemberRow] = layout.monthRows.map((index) => layout.rows[index]);

  it("stays hidden while the real month heading is on screen", () => {
    expect(stickyMonth(layout, 0)).toBeNull();
    expect(stickyMonth(layout, 10)).toBeNull();
  });

  it("sticks to the top once the heading has scrolled past", () => {
    const y = octoberRow.top + MONTH_HEIGHT + 200;
    expect(stickyMonth(layout, y)).toEqual({ label: "October 2026", top: y });
  });

  it("is pushed up by the next month's heading, then replaced by it", () => {
    const y = septemberRow.top - 10;
    const stuck = stickyMonth(layout, y);
    expect(stuck?.label).toBe("October 2026");
    expect(stuck?.top).toBe(septemberRow.top - STICKY_HEIGHT);
    expect(stickyMonth(layout, septemberRow.top + MONTH_HEIGHT + 5)?.label).toBe("September 2026");
  });

  it("does nothing for flat listings", () => {
    const flat = computeLayout({ width: 1000, targetTile: 184, gap: 4, groups: null, total: 60, now });
    expect(stickyMonth(flat, 500)).toBeNull();
  });
});

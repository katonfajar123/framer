import { describe, expect, it } from "vitest";
import { columnsFor, computeLayout, DAY_HEIGHT, MONTH_HEIGHT, monthAt, rowIndexAt, rowIndexForItem, visibleRows } from "./layout";

const now = new Date(2026, 9, 28, 12);

describe("columnsFor", () => {
  it("fits as many tiles as the width allows and always at least one", () => {
    expect(columnsFor(1000, 184, 4)).toBe(5);
    expect(columnsFor(100, 184, 4)).toBe(1);
  });
});

describe("computeLayout", () => {
  const groups = [
    { day: "2026-10-24", count: 7 },
    { day: "2026-10-02", count: 2 },
    { day: "2026-09-30", count: 3 },
  ];
  const layout = computeLayout({ width: 1000, targetTile: 184, gap: 4, groups, total: 12, now });

  it("fills the available width exactly", () => {
    expect(layout.columns).toBe(5);
    expect(layout.tile * layout.columns + layout.gap * (layout.columns - 1)).toBeCloseTo(1000);
  });

  it("emits a month heading only when the month changes", () => {
    const months = layout.rows.filter((row) => row.kind === "month");
    expect(months.map((row) => row.kind === "month" && row.label)).toEqual(["October 2026", "September 2026"]);
    const firstMonth = months[0];
    expect(firstMonth.kind === "month" && firstMonth.count).toBe(9);
  });

  it("labels days and keeps rows contiguous", () => {
    const days = layout.rows.filter((row) => row.kind === "day");
    expect(days.map((row) => row.kind === "day" && row.label)).toEqual([
      "Saturday, 24 October",
      "Friday, 2 October",
      "Wednesday, 30 September",
    ]);
    layout.rows.slice(1).forEach((row, index) => {
      const previous = layout.rows[index];
      expect(row.top).toBeCloseTo(previous.top + previous.height);
    });
    expect(layout.rows[0].top).toBe(0);
    expect(layout.rows[0].height).toBe(MONTH_HEIGHT);
    expect(layout.rows[1].height).toBe(DAY_HEIGHT);
  });

  it("splits a day into rows of `columns` tiles and numbers items globally", () => {
    const tiles = layout.rows.filter((row) => row.kind === "tiles");
    expect(tiles.map((row) => row.kind === "tiles" && [row.start, row.count])).toEqual([
      [0, 5],
      [5, 2],
      [7, 2],
      [9, 3],
    ]);
  });

  it("finds the row for any item and the row at any scroll offset", () => {
    for (let item = 0; item < 12; item++) {
      const row = layout.rows[rowIndexForItem(layout, item)];
      expect(row.kind).toBe("tiles");
      expect(row.kind === "tiles" && item >= row.start && item < row.start + row.count).toBe(true);
    }
    expect(rowIndexForItem(layout, 12)).toBe(-1);
    expect(rowIndexAt(layout.rows, 0)).toBe(0);
    expect(rowIndexAt(layout.rows, 999999)).toBe(layout.rows.length - 1);
  });

  it("reports the month at a scroll offset for the sticky label", () => {
    expect(monthAt(layout, 0)).toBe("October 2026");
    expect(monthAt(layout, layout.height)).toBe("September 2026");
  });
});

describe("flat layout", () => {
  it("has no headings and no group gaps", () => {
    const layout = computeLayout({ width: 600, targetTile: 150, gap: 4, groups: null, total: 9, now });
    expect(layout.rows.every((row) => row.kind === "tiles")).toBe(true);
    expect(layout.rows).toHaveLength(Math.ceil(9 / layout.columns));
    expect(layout.rows[0].height).toBeCloseTo(layout.tile + 4);
  });

  it("handles an empty library", () => {
    const layout = computeLayout({ width: 600, targetTile: 150, gap: 4, groups: [], total: 0, now });
    expect(layout.rows).toHaveLength(0);
    expect(visibleRows(layout, 0, 500, 100)).toEqual([0, -1]);
  });
});

describe("visibleRows", () => {
  it("only returns rows near the viewport, even in a huge library", () => {
    const groups = Array.from({ length: 2000 }, (_, index) => ({
      day: new Date(2020, 0, 1 + index).toISOString().slice(0, 10),
      count: 25,
    })).reverse();
    const layout = computeLayout({ width: 1100, targetTile: 184, gap: 4, groups, total: 50_000, now });
    const [first, last] = visibleRows(layout, 400_000, 800, 600);
    expect(last - first).toBeLessThan(40);
    expect(layout.rows[first].top).toBeLessThanOrEqual(400_000);
    expect(layout.rows[last].top + layout.rows[last].height).toBeGreaterThanOrEqual(400_800);
  });
});

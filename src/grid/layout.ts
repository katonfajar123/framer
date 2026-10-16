import type { DayGroup } from "../lib/api";
import { dayLabel, monthKey, monthLabel } from "../lib/format";

export const MONTH_HEIGHT = 68;
/** Height of the compact month bar that sticks to the top while scrolling. */
export const STICKY_HEIGHT = 44;
export const DAY_HEIGHT = 42;
/** Breathing room added after the last row of every day. */
export const GROUP_GAP = 10;
const BOTTOM_PADDING = 56;

interface RowBase {
  top: number;
  height: number;
  groupIndex: number;
}

export type Row =
  | (RowBase & { kind: "month"; label: string; count: number })
  | (RowBase & { kind: "day"; label: string; count: number })
  | (RowBase & { kind: "tiles"; start: number; count: number });

export interface GridLayout {
  columns: number;
  tile: number;
  gap: number;
  rows: Row[];
  height: number;
  /** Month label for every day group, for the sticky month indicator. */
  groupMonths: string[];
  /** Indices into `rows` of the tile rows, ascending by first item. */
  tileRows: number[];
  /** Indices into `rows` of the month headings, top to bottom. */
  monthRows: number[];
  total: number;
}

export interface LayoutOptions {
  width: number;
  targetTile: number;
  gap: number;
  /** Day groups, newest first; `null` for a flat listing without headings. */
  groups: DayGroup[] | null;
  total: number;
  /** `day` shows a heading per day; `month` flows a whole month as one continuous grid. */
  grouping?: "day" | "month";
  now?: Date;
}

export function columnsFor(width: number, targetTile: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (targetTile + gap)));
}

/** Merge consecutive day groups of the same month into a single group. */
export function groupByMonth(groups: DayGroup[]): DayGroup[] {
  const merged: DayGroup[] = [];
  for (const group of groups) {
    const last = merged.at(-1);
    if (last && monthKey(last.day) === monthKey(group.day)) last.count += group.count;
    else merged.push({ day: group.day, count: group.count });
  }
  return merged;
}

export function computeLayout({ width, targetTile, gap, groups: dayGroups, total, grouping = "day", now }: LayoutOptions): GridLayout {
  const groups = dayGroups && grouping === "month" ? groupByMonth(dayGroups) : dayGroups;
  const showDays = grouping === "day";
  const columns = columnsFor(width, targetTile, gap);
  const tile = Math.max(1, (width - gap * (columns - 1)) / columns);
  const rows: Row[] = [];
  const tileRows: number[] = [];
  const monthRows: number[] = [];
  const groupMonths: string[] = [];
  let top = 0;
  let start = 0;

  const addTiles = (groupIndex: number, count: number) => {
    for (let offset = 0; offset < count; offset += columns) {
      const inRow = Math.min(columns, count - offset);
      const last = offset + columns >= count;
      const height = tile + gap + (last && groups ? GROUP_GAP : 0);
      tileRows.push(rows.length);
      rows.push({ kind: "tiles", top, height, groupIndex, start: start + offset, count: inRow });
      top += height;
    }
    start += count;
  };

  if (!groups) {
    groupMonths.push("");
    addTiles(0, total);
  } else {
    let previousMonth = "";
    groups.forEach((group, groupIndex) => {
      const month = monthKey(group.day);
      groupMonths.push(monthLabel(group.day));
      if (month !== previousMonth) {
        const monthTotal = groups
          .filter((candidate) => monthKey(candidate.day) === month)
          .reduce((sum, candidate) => sum + candidate.count, 0);
        monthRows.push(rows.length);
        rows.push({ kind: "month", top, height: MONTH_HEIGHT, groupIndex, label: monthLabel(group.day), count: monthTotal });
        top += MONTH_HEIGHT;
        previousMonth = month;
      }
      if (showDays) {
        rows.push({ kind: "day", top, height: DAY_HEIGHT, groupIndex, label: dayLabel(group.day, now), count: group.count });
        top += DAY_HEIGHT;
      }
      addTiles(groupIndex, group.count);
    });
  }
  return { columns, tile, gap, rows, height: top + BOTTOM_PADDING, groupMonths, tileRows, monthRows, total };
}

/** Index of the row containing vertical offset `y` (clamped to the first/last row). */
export function rowIndexAt(rows: Row[], y: number): number {
  if (rows.length === 0) return -1;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (rows[middle].top <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Inclusive range of rows that intersect `[y - overscan, y + viewport + overscan]`. */
export function visibleRows(layout: GridLayout, y: number, viewport: number, overscan: number): [number, number] {
  if (layout.rows.length === 0) return [0, -1];
  const first = rowIndexAt(layout.rows, Math.max(0, y - overscan));
  let last = rowIndexAt(layout.rows, y + viewport + overscan);
  last = Math.min(layout.rows.length - 1, last);
  return [first, last];
}

/** Row (index into `layout.rows`) holding the item at `itemIndex`, or -1. */
export function rowIndexForItem(layout: GridLayout, itemIndex: number): number {
  const { tileRows, rows } = layout;
  let low = 0;
  let high = tileRows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = rows[tileRows[middle]];
    if (row.kind !== "tiles") return -1;
    if (itemIndex < row.start) high = middle - 1;
    else if (itemIndex >= row.start + row.count) low = middle + 1;
    else {
      found = tileRows[middle];
      break;
    }
  }
  return found;
}

/** Group label for the sticky month indicator at scroll offset `y`. */
export function monthAt(layout: GridLayout, y: number): string {
  const index = rowIndexAt(layout.rows, y);
  if (index < 0) return "";
  return layout.groupMonths[layout.rows[index].groupIndex] ?? "";
}

/**
 * Where the compact sticky month bar should sit for scroll offset `y` (body coordinates), or
 * `null` while the real month heading is still on screen. The next month pushes the bar up.
 */
export function stickyMonth(layout: GridLayout, y: number): { label: string; top: number } | null {
  const { monthRows, rows } = layout;
  if (monthRows.length === 0) return null;
  let low = 0;
  let high = monthRows.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (rows[monthRows[middle]].top <= y) low = middle;
    else high = middle - 1;
  }
  const current = rows[monthRows[low]];
  if (current.kind !== "month" || y < current.top + MONTH_HEIGHT - 24) return null;
  const next = monthRows[low + 1] !== undefined ? rows[monthRows[low + 1]].top : Infinity;
  return { label: current.label, top: Math.min(y, next - STICKY_HEIGHT) };
}

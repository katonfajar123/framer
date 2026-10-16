import { describe, expect, it } from "vitest";
import { clampPan, FIT_MARGIN, fitScale, zoomAround } from "./zoom";

const stage = { width: 1000, height: 600 };

describe("fitScale", () => {
  it("shrinks large photos to fit with a margin and never enlarges small ones", () => {
    // 4000x3000 into 1000x600 minus the 48px margin: the height is the limit.
    expect(fitScale({ width: 4000, height: 3000 }, stage)).toBeCloseTo((600 - FIT_MARGIN) / 3000);
    expect(fitScale({ width: 500, height: 300 }, stage)).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, stage)).toBe(1);
  });
});

describe("clampPan", () => {
  const image = { width: 4000, height: 3000 };

  it("centres an image that is smaller than the stage", () => {
    const fitted = clampPan({ scale: 0.1, x: 900, y: -900 }, image, stage);
    expect(fitted).toEqual({ scale: 0.1, x: 300, y: 150 });
  });

  it("stops a zoomed image from leaving the stage", () => {
    const big = clampPan({ scale: 1, x: 500, y: 500 }, image, stage);
    expect(big.x).toBe(0);
    expect(big.y).toBe(0);
    const far = clampPan({ scale: 1, x: -99999, y: -99999 }, image, stage);
    expect(far.x).toBe(1000 - 4000);
    expect(far.y).toBe(600 - 3000);
  });
});

describe("zoomAround", () => {
  const image = { width: 4000, height: 3000 };

  it("keeps the point under the cursor fixed", () => {
    const start = clampPan({ scale: 0.25, x: 0, y: 0 }, image, stage); // 1000 x 750 -> centred vertically
    const cursor = { x: 600, y: 300 };
    const imagePointBefore = { x: (cursor.x - start.x) / start.scale, y: (cursor.y - start.y) / start.scale };
    const zoomed = zoomAround(start, 1, cursor, image, stage);
    const imagePointAfter = { x: (cursor.x - zoomed.x) / zoomed.scale, y: (cursor.y - zoomed.y) / zoomed.scale };
    expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x, 5);
    expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y, 5);
  });
});

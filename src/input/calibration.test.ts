import { describe, expect, it } from "vitest";
import { computeOffset } from "./calibration";

/** Builds a click grid: `count` clicks, `intervalSec` apart, starting at `startSec`. */
function clickGrid(startSec: number, intervalSec: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => startSec + i * intervalSec);
}

describe("computeOffset", () => {
  it("recovers a constant positive offset (taps consistently late)", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const trueOffsetSec = 0.04;
    const taps = clicks.map((t) => t + trueOffsetSec);

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(true);
    expect(result.offsetSec).toBeCloseTo(trueOffsetSec, 3);
    expect(result.spreadMs).toBeLessThan(60);
  });

  it("recovers a constant negative offset (taps consistently early)", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const trueOffsetSec = -0.03;
    const taps = clicks.map((t) => t + trueOffsetSec);

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(true);
    expect(result.offsetSec).toBeCloseTo(trueOffsetSec, 3);
  });

  it("drops outlier taps beyond ±250ms and still recovers the offset", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const trueOffsetSec = 0.02;
    const taps = clicks.map((t) => t + trueOffsetSec);
    // Corrupt a couple of interior taps with large errors (missed beats / stray taps).
    taps[5] = (clicks[5] as number) + 0.4;
    taps[9] = (clicks[9] as number) - 0.35;

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(true);
    expect(result.offsetSec).toBeCloseTo(trueOffsetSec, 2);
  });

  it("drops the first two taps as warmup even when they are accurate", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const trueOffsetSec = 0.05;
    const taps = clicks.map((t) => t + trueOffsetSec);
    // Make the first two taps wildly inaccurate; if they were included the median would shift.
    taps[0] = (clicks[0] as number) + 0.2;
    taps[1] = (clicks[1] as number) - 0.2;

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(true);
    expect(result.offsetSec).toBeCloseTo(trueOffsetSec, 2);
  });

  it("reports ok: false when there are too few usable taps", () => {
    const clicks = clickGrid(0, 0.5, 16);
    // Only 3 taps after dropping 2 warmup taps leaves 1 usable tap, well below the minimum.
    const taps = [0.02, 0.51, 1.03];

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(false);
  });

  it("reports ok: false when there are no clicks", () => {
    const result = computeOffset([0.1, 0.2, 0.3], []);
    expect(result.ok).toBe(false);
  });

  it("reports ok: false when taps are too inconsistent (high spread)", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const taps = clicks.map((t, i) => t + (i % 2 === 0 ? 0.15 : -0.15));

    const result = computeOffset(taps, clicks);

    expect(result.ok).toBe(false);
    expect(result.spreadMs).toBeGreaterThanOrEqual(60);
  });

  it("computes a near-zero offset for perfectly on-time taps", () => {
    const clicks = clickGrid(0, 0.5, 16);
    const result = computeOffset([...clicks], clicks);

    expect(result.ok).toBe(true);
    expect(result.offsetSec).toBeCloseTo(0, 5);
    expect(result.spreadMs).toBeCloseTo(0, 5);
  });
});

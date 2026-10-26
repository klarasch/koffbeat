import { describe, expect, it } from "vitest";

import type { Level, RhythmEvent } from "../types";
import { barQuarters, eventQuarters, validateLevel } from "./durations";
import { generateLevel, TIER_NAMES } from "./generate";

const TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const BAR_COUNTS = [4, 8, 16] as const;
const SEEDS_PER_CASE = 200;

function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`expected index ${index} to exist`);
  return value;
}

describe("generateLevel", () => {
  it.each(TIERS)("tier %i: every generated exercise validates, for every bar count", (tier) => {
    for (const bars of BAR_COUNTS) {
      for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
        const level = generateLevel({ tier, bars, seed });
        const errors = validateLevel(level);
        expect(errors, `tier ${tier}, bars ${bars}, seed ${seed}: ${errors.join("; ")}`).toEqual([]);
        expect(level.bars).toHaveLength(bars);
      }
    }
  });

  it("is deterministic for a given seed", () => {
    for (const tier of TIERS) {
      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < 20; seed++) {
          const a = generateLevel({ tier, bars, seed });
          const b = generateLevel({ tier, bars, seed });
          expect(b).toEqual(a);
        }
      }
    }
  });

  it("uses a fresh random seed by default (very unlikely to collide)", () => {
    const a = generateLevel({ tier: 3, bars: 4 });
    const b = generateLevel({ tier: 3, bars: 4 });
    expect(a.id).not.toEqual(b.id);
  });

  it("tier 1 exercises contain only quarter notes (aside from the required cadence note)", () => {
    for (const bars of BAR_COUNTS) {
      for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
        const level = generateLevel({ tier: 1, bars, seed });
        level.bars.forEach((bar, barIndex) => {
          const isCadenceBar = barIndex % 4 === 3;
          bar.forEach((event, eventIndex) => {
            const isCadenceNote = isCadenceBar && eventIndex === bar.length - 1;
            expect(event.rest).toBe(false);
            expect(event.tie).toBeFalsy();
            if (!isCadenceNote) {
              expect(event.value).toBe("q");
              expect(event.dots).toBe(0);
            }
          });
        });
      }
    }
  });

  it("never begins the exercise with a rest", () => {
    for (const tier of TIERS) {
      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
          const level = generateLevel({ tier, bars, seed });
          const firstEvent = at(at(level.bars, 0), 0);
          expect(firstEvent.rest, `tier ${tier}, bars ${bars}, seed ${seed}`).toBe(false);
        }
      }
    }
  });

  it("ends each 4-bar phrase on a long note (a half, or a dotted quarter in 6/8)", () => {
    for (const tier of TIERS) {
      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
          const level = generateLevel({ tier, bars, seed });
          for (let phraseStart = 0; phraseStart < level.bars.length; phraseStart += 4) {
            const cadenceBar = at(level.bars, phraseStart + 3);
            const lastEvent = at(cadenceBar, cadenceBar.length - 1);
            expect(lastEvent.rest, `tier ${tier}, bars ${bars}, seed ${seed}`).toBe(false);
            expect(lastEvent.tie, `tier ${tier}, bars ${bars}, seed ${seed}`).toBeFalsy();
            expect(eventQuarters(lastEvent), `tier ${tier}, bars ${bars}, seed ${seed}`).toBeGreaterThanOrEqual(level.meter.beatUnit === 8 ? 1.5 : 2);
          }
        }
      }
    }
  });

  describe("new-tier cells appear often enough to practise the new thing", () => {
    // Cells introduced at each tier, matched by (value, dots, rest) shape.
    const NEW_CELL_SHAPES: Record<number, { value: string; rest: boolean; dots: 0 | 1 }[]> = {
      2: [
        { value: "h", rest: false, dots: 0 },
        { value: "w", rest: false, dots: 0 },
      ],
      3: [
        { value: "q", rest: true, dots: 0 },
        { value: "h", rest: true, dots: 0 },
      ],
      4: [{ value: "8", rest: false, dots: 0 }],
      5: [
        { value: "q", rest: false, dots: 1 },
        { value: "8", rest: true, dots: 0 },
      ],
      6: [],
      7: [{ value: "16", rest: false, dots: 0 }],
    };

    it.each([2, 3, 4, 5, 7])("tier %i", (tier) => {
      const shapes = NEW_CELL_SHAPES[tier] ?? [];
      let newTierQuarters = 0;
      let totalQuarters = 0;

      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
          const level = generateLevel({ tier, bars, seed });
          for (const bar of level.bars) {
            for (const event of bar) {
              const quarters = eventQuarters(event);
              totalQuarters += quarters;
              if (shapes.some((s) => s.value === event.value && s.rest === event.rest && s.dots === event.dots)) {
                newTierQuarters += quarters;
              }
            }
          }
        }
      }

      expect(newTierQuarters / totalQuarters).toBeGreaterThanOrEqual(tier === 3 ? 0.15 : 0.25); // rests are deliberately sparser
    });

    it("tier 6 introduces ties often enough", () => {
      const tier = 6;
      let tiedEvents = 0;
      let totalEvents = 0;

      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
          const level = generateLevel({ tier, bars, seed });
          for (const bar of level.bars) {
            for (const event of bar) {
              totalEvents++;
              if (event.tie) tiedEvents++;
            }
          }
        }
      }

      expect(tiedEvents).toBeGreaterThan(0);
    });
  });

  describe("harder tiers", () => {
    const allLevels = (tier: number): Level[] => {
      const levels: Level[] = [];
      for (const bars of BAR_COUNTS) for (let seed = 0; seed < SEEDS_PER_CASE; seed++) levels.push(generateLevel({ tier, bars, seed }));
      return levels;
    };

    /** Fraction of bars that contain at least one event matching `hasNew`. */
    function barShare(tier: number, hasNew: (bar: RhythmEvent[]) => boolean): number {
      let withNew = 0;
      let total = 0;
      for (const level of allLevels(tier)) {
        for (const bar of level.bars) {
          total++;
          if (hasNew(bar)) withNew++;
        }
      }
      return withNew / total;
    }

    /** Onset position (in quarters from bar start) of each event. */
    const positions = (bar: RhythmEvent[]): number[] => {
      let at = 0;
      return bar.map((e) => {
        const here = at;
        at += eventQuarters(e);
        return here;
      });
    };

    it("tiers 1–11 stay in 4/4", () => {
      for (const tier of TIERS.filter((t) => t < 12)) {
        for (const level of allLevels(tier)) expect(level.meter).toEqual({ beats: 4, beatUnit: 4 });
      }
    });

    it("tier 8 (syncopation): eighth-quarter-eighth and eighths tied over the beat are frequent", () => {
      const hasSync = (bar: RhythmEvent[]) =>
        bar.some((e, i) => {
          const prev = bar[i - 1];
          const next = bar[i + 1];
          if (e.value === "8" && e.tie && !e.rest && positions(bar)[i]! % 1 !== 0) return true;
          return e.value === "q" && !e.rest && prev?.value === "8" && next?.value === "8";
        });
      expect(barShare(8, hasSync)).toBeGreaterThanOrEqual(0.3);
      // Every eighth tied over the beat lands on a beat and is not tied into a rest (validateLevel covers the rest).
      for (const level of allLevels(8)) {
        level.bars.forEach((bar) => {
          positions(bar).forEach((pos, i) => {
            const prev = bar[i - 1];
            if (prev?.tie && prev.value === "8") expect(pos % 1).toBe(0);
          });
        });
      }
    });

    it("tier 9: dotted eighth + sixteenth and sixteenth + dotted eighth appear and pair up within a beat", () => {
      const isDotted8 = (e?: RhythmEvent) => !!e && e.value === "8" && e.dots === 1 && !e.rest;
      const is16 = (e?: RhythmEvent) => !!e && e.value === "16" && !e.rest;
      const has = (bar: RhythmEvent[]) => bar.some((e, i) => (isDotted8(e) && is16(bar[i + 1])) || (is16(e) && isDotted8(bar[i + 1])));
      expect(barShare(9, has)).toBeGreaterThanOrEqual(0.3);
      for (const level of allLevels(9)) {
        for (const bar of level.bars) {
          bar.forEach((e, i) => {
            if (isDotted8(e)) expect(is16(bar[i - 1]) || is16(bar[i + 1])).toBe(true);
          });
        }
      }
    });

    it("tier 10: eighth and sixteenth rests fall off the beat", () => {
      const hasOffBeatRest = (bar: RhythmEvent[]) =>
        positions(bar).some((pos, i) => {
          const e = bar[i]!;
          return e.rest && (e.value === "16" || (e.value === "8" && pos % 1 !== 0));
        });
      expect(barShare(10, hasOffBeatRest)).toBeGreaterThanOrEqual(0.3);
    });

    it("tier 11: triplets are frequent and always come in complete beats", () => {
      expect(barShare(11, (bar) => bar.some((e) => e.tuplet === 3))).toBeGreaterThanOrEqual(0.3);
      for (const level of allLevels(11)) {
        for (const bar of level.bars) {
          const pos = positions(bar);
          let run = 0;
          bar.forEach((e, i) => {
            if (e.tuplet === 3) {
              if (run === 0) expect(Math.abs(Math.round(pos[i]!) - pos[i]!), "a triplet starts on a beat").toBeLessThan(1e-6);
              run += eventQuarters(e);
              if (Math.abs(run - 1) < 1e-6) run = 0;
            } else {
              expect(run, "tuplet group must be complete").toBe(0);
            }
          });
          expect(run).toBe(0);
        }
      }
    });

    it("tier 12: writes in 3/4 and 6/8 with every bar filling the meter", () => {
      const seen = new Set<string>();
      for (const level of allLevels(12)) {
        seen.add(`${level.meter.beats}/${level.meter.beatUnit}`);
        const expected = barQuarters(level.meter);
        expect(expected).toBe(3);
        for (const bar of level.bars) {
          expect(bar.reduce((sum, e) => sum + eventQuarters(e), 0)).toBeCloseTo(expected, 6);
        }
      }
      expect([...seen].sort()).toEqual(["3/4", "6/8"]);
    });

    it("tier 12 in 6/8: events never straddle the middle of the bar, except a whole-bar dotted half", () => {
      for (const level of allLevels(12).filter((l) => l.meter.beatUnit === 8)) {
        for (const bar of level.bars) {
          if (bar.length === 1) continue;
          positions(bar).forEach((pos, i) => {
            const end = pos + eventQuarters(bar[i]!);
            const crossesMiddle = pos < 1.5 - 1e-6 && end > 1.5 + 1e-6;
            expect(crossesMiddle).toBe(false);
          });
        }
      }
    });

    it("tier 12 in 3/4: dotted halves and half notes appear", () => {
      const levels = allLevels(12).filter((l) => l.meter.beats === 3 && l.meter.beatUnit === 4);
      const events = levels.flatMap((l) => l.bars.flat());
      expect(events.some((e) => e.value === "h" && e.dots === 1)).toBe(true);
      expect(events.some((e) => e.value === "h" && e.dots === 0)).toBe(true);
    });
  });

  it("exports one tier name per tier", () => {
    expect(TIER_NAMES).toHaveLength(TIERS.length);
    for (const name of TIER_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

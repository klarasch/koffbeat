import { describe, expect, it } from "vitest";

import { eventQuarters, validateLevel } from "./durations";
import { generateLevel, TIER_NAMES } from "./generate";

const TIERS = [1, 2, 3, 4, 5, 6, 7];
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

  it("ends each 4-bar phrase on a note at least 2 quarters long", () => {
    for (const tier of TIERS) {
      for (const bars of BAR_COUNTS) {
        for (let seed = 0; seed < SEEDS_PER_CASE; seed++) {
          const level = generateLevel({ tier, bars, seed });
          for (let phraseStart = 0; phraseStart < level.bars.length; phraseStart += 4) {
            const cadenceBar = at(level.bars, phraseStart + 3);
            const lastEvent = at(cadenceBar, cadenceBar.length - 1);
            expect(lastEvent.rest, `tier ${tier}, bars ${bars}, seed ${seed}`).toBe(false);
            expect(lastEvent.tie, `tier ${tier}, bars ${bars}, seed ${seed}`).toBeFalsy();
            expect(eventQuarters(lastEvent), `tier ${tier}, bars ${bars}, seed ${seed}`).toBeGreaterThanOrEqual(2);
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

  it("exports one tier name per tier", () => {
    expect(TIER_NAMES).toHaveLength(TIERS.length);
    for (const name of TIER_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

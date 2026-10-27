import { describe, expect, it } from "vitest";

import type { Level, RhythmEvent } from "../types";
import { barQuarters, eventQuarters, validateLevel } from "./durations";
import {
  generateLevel,
  type Ingredient,
  INGREDIENTS,
  ingredientsForTier,
  type MeterChoice,
  mulberry32,
  TIER_NAMES,
} from "./generate";

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

// ---------------------------------------------------------------------------------------------
// Ingredient-based generation (Free practice)
// ---------------------------------------------------------------------------------------------

const KEYS = INGREDIENTS.map((i) => i.key);
const METER_CHOICES: MeterChoice[] = ["4/4", "3/4", "6/8"];

/** Events with the bar-relative onset position in quarters. */
function withPositions(bar: RhythmEvent[]): { e: RhythmEvent; pos: number }[] {
  let pos = 0;
  return bar.map((e) => {
    const here = { e, pos };
    pos += eventQuarters(e);
    return here;
  });
}

/** What the player would see in an exercise that an unselected ingredient must not produce. */
function violations(level: Level, set: Set<Ingredient>): string[] {
  const out: string[] = [];
  const is44 = level.meter.beats === 4 && level.meter.beatUnit === 4;
  for (const e of level.bars.flat()) {
    if (e.tuplet && !set.has("triplets")) out.push("tuplet without triplets");
    if (e.tie && !set.has("ties")) out.push("tie without ties");
    if (e.value === "16" && !set.has("sixteenths") && !set.has("dottedEighths")) out.push("sixteenth without sixteenths or dottedEighths");
    if (e.rest && !set.has("rests") && !set.has("offbeatRests")) out.push("rest without rests or offbeatRests");
    // Dotted notes are part of 3/4 (dotted half) and 6/8 (dotted quarter) themselves; in 4/4 they need an ingredient.
    if (e.dots === 1 && is44 && !set.has("dotted") && !set.has("dottedEighths")) out.push("dotted note without dotted or dottedEighths");
    if (e.dots === 1 && e.value === "q" && is44 && !set.has("dotted")) out.push("dotted quarter without dotted");
    if (e.dots === 1 && e.value === "8" && !set.has("dottedEighths")) out.push("dotted eighth without dottedEighths");
    if (e.value === "8" && !e.rest && !e.tuplet && !e.tie && !set.has("eighths") && !set.has("dotted") && !set.has("ties") && !set.has("sixteenths") &&
        !set.has("syncopation") && !set.has("dottedEighths") && !set.has("offbeatRests") && !set.has("rests") && !set.has("triplets")) {
      out.push("eighth without any ingredient that uses eighths");
    }
  }
  return out;
}

/** Does the exercise show the ingredient? Cadence notes are ignored for halves, being obligatory. */
function shows(level: Level, key: Ingredient): boolean {
  const bars = level.bars;
  switch (key) {
    case "quarters":
      return true;
    case "halves":
      return bars.some((bar, i) => i % 4 !== 3 && bar.some((e) => !e.rest && (e.value === "h" || e.value === "w")));
    case "rests":
      return bars.flat().some((e) => e.rest);
    case "eighths":
      return bars.flat().some((e) => e.value === "8" && !e.rest && !e.tuplet);
    case "dotted":
      return bars.flat().some((e) => e.dots === 1 && !e.rest && (e.value === "q" || e.value === "h"));
    case "ties":
      return bars.flat().some((e) => e.tie);
    case "sixteenths":
      return bars.flat().some((e) => e.value === "16" && !e.rest);
    case "syncopation":
      return bars.some((bar) =>
        withPositions(bar).some(({ e, pos }, i, all) => {
          const prev = all[i - 1]?.e;
          const next = all[i + 1]?.e;
          if (e.value === "8" && e.tie && pos % 1 !== 0) return true;
          return e.value === "q" && !e.rest && !e.tuplet && prev?.value === "8" && next?.value === "8" && pos % 1 !== 0;
        }),
      );
    case "dottedEighths":
      return bars.flat().some((e) => e.value === "8" && e.dots === 1 && !e.rest);
    case "offbeatRests":
      return bars.some((bar) => withPositions(bar).some(({ e, pos }) => e.rest && (e.value === "16" || (e.value === "8" && pos % 1 !== 0))));
    case "triplets":
      return bars.flat().some((e) => e.tuplet === 3);
  }
}

describe("ingredients", () => {
  it("INGREDIENTS lists the eleven ingredients in curriculum order, one per tier 1-11", () => {
    expect(INGREDIENTS.map((i) => i.tier)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const i of INGREDIENTS) expect(i.label).toMatch(/^[A-Z]/);
  });

  it("ingredientsForTier follows the tier ladder: each tier adds the one ingredient TIER_NAMES names, tier 12 none", () => {
    const expectedNew: Ingredient[] = ["quarters", "halves", "rests", "eighths", "dotted", "ties", "sixteenths", "syncopation", "dottedEighths", "offbeatRests", "triplets"];
    let previous: Ingredient[] = [];
    for (let tier = 1; tier <= 11; tier++) {
      const now = ingredientsForTier(tier);
      expect(now.filter((k) => !previous.includes(k)), `tier ${tier} (${TIER_NAMES[tier - 1]})`).toEqual([expectedNew[tier - 1]]);
      expect(previous.every((k) => now.includes(k))).toBe(true);
      previous = now;
    }
    expect(ingredientsForTier(12)).toEqual(ingredientsForTier(11));
    expect(ingredientsForTier(12)).toHaveLength(11);
  });

  it("a tier-only call is unchanged by the ingredient work (same levels as an explicit tier call)", () => {
    expect(generateLevel({ tier: 7, bars: 8, seed: 5 }).title).toBe("Sixteenths, 8 bars");
    expect(generateLevel({ tier: 7, bars: 8, seed: 5 }).id).toBe("gen-t7-5");
  });

  it("every random ingredient subset validates, across bar counts and meters (400 combinations)", () => {
    const rng = mulberry32(2024);
    for (let n = 0; n < 400; n++) {
      const ingredients = KEYS.filter(() => rng() < 0.4);
      const meter = METER_CHOICES[n % 3] as MeterChoice;
      const bars = BAR_COUNTS[Math.floor(n / 3) % 3] as 4 | 8 | 16;
      const focus = ingredients.length > 0 && n % 4 === 0 ? (ingredients[Math.floor(rng() * ingredients.length)] as Ingredient) : undefined;
      const level = generateLevel({ tier: 1, ingredients, meter, focus, bars, seed: n });
      const label = `#${n} [${ingredients.join(",")}] ${meter} ${bars} bars focus=${focus}`;
      expect(validateLevel(level), label).toEqual([]);
      expect(level.bars, label).toHaveLength(bars);
      expect(level.meter.beats * 4 / level.meter.beatUnit, label).toBe(3 + (meter === "4/4" ? 1 : 0));
      expect(at(at(level.bars, 0), 0).rest, label).toBe(false);
      for (let p = 0; p < bars; p += 4) {
        const last = at(at(level.bars, p + 3), at(level.bars, p + 3).length - 1);
        expect(last.rest || last.tie, label).toBeFalsy();
        expect(eventQuarters(last), label).toBeGreaterThanOrEqual(meter === "6/8" ? 1.5 : 2);
      }
    }
  });

  it("ingredients that aren't selected never appear", () => {
    const rng = mulberry32(77);
    for (let n = 0; n < 600; n++) {
      const ingredients = KEYS.filter(() => rng() < 0.4);
      const set = new Set<Ingredient>(ingredients);
      const meter = METER_CHOICES[n % 3] as MeterChoice;
      const level = generateLevel({ tier: 1, ingredients, meter, bars: BAR_COUNTS[n % 3] as 4 | 8 | 16, seed: n });
      expect(violations(level, set), `#${n} [${ingredients.join(",")}] ${meter}`).toEqual([]);
    }
  });

  it("single ingredients show up alone: only quarters when nothing is selected, nothing from other ingredients", () => {
    const none = generateLevel({ tier: 1, ingredients: [], bars: 8, seed: 1 });
    expect(none.title).toBe("Quarters, 8 bars");
    for (const key of KEYS) {
      for (let seed = 0; seed < 50; seed++) {
        const level = generateLevel({ tier: 12, ingredients: [key], bars: 8, seed });
        expect(violations(level, new Set([key, "quarters"])), `${key} seed ${seed}`).toEqual([]);
      }
    }
  });

  it("when ingredients are given, tier is ignored and quarters are implied", () => {
    for (let seed = 0; seed < 50; seed++) {
      const level = generateLevel({ tier: 12, ingredients: ["rests"], bars: 8, seed });
      expect(level.meter).toEqual({ beats: 4, beatUnit: 4 });
      expect(level.bars.flat().some((e) => e.value === "8" && !e.rest)).toBe(false);
    }
  });

  it("the focus ingredient appears in a clear majority of exercises", () => {
    const rng = mulberry32(5150);
    const results = new Map<Ingredient, { shown: number; total: number }>();
    for (let n = 0; n < 900; n++) {
      const others = KEYS.filter((k) => k !== "quarters" && rng() < 0.4);
      const focus = KEYS[1 + (n % (KEYS.length - 1))] as Ingredient; // never quarters
      const ingredients = others.includes(focus) ? others : [...others, focus];
      const bars = BAR_COUNTS[Math.floor(n / 10) % 3] as 4 | 8 | 16;
      const level = generateLevel({ tier: 1, ingredients, focus, bars, seed: n });
      const r = results.get(focus) ?? { shown: 0, total: 0 };
      r.total++;
      if (shows(level, focus)) r.shown++;
      results.set(focus, r);
    }
    let shown = 0;
    let total = 0;
    for (const [focus, r] of results) {
      shown += r.shown;
      total += r.total;
      expect(r.shown / r.total, `focus ${focus}`).toBeGreaterThan(0.7);
    }
    expect(shown / total).toBeGreaterThan(0.85);
  });

  it("the focus defaults to the highest-tier ingredient selected", () => {
    let shown = 0;
    for (let seed = 0; seed < 200; seed++) {
      const level = generateLevel({ tier: 1, ingredients: ["halves", "eighths", "triplets"], bars: 4, seed });
      if (shows(level, "triplets")) shown++;
    }
    expect(shown / 200).toBeGreaterThan(0.85);
  });

  it("titles list the ingredients in plain words, with no middle dot", () => {
    expect(generateLevel({ tier: 1, ingredients: ["ties", "rests", "eighths"], bars: 8, seed: 1 }).title).toBe("Rests, eighths and ties, 8 bars");
    expect(generateLevel({ tier: 1, ingredients: ["rests"], bars: 4, seed: 1 }).title).toBe("Rests, 4 bars");
    expect(generateLevel({ tier: 1, ingredients: ["eighths", "triplets", "ties"], meter: "6/8", bars: 4, seed: 1 }).title).toBe("Eighths, ties and triplets in 6/8, 4 bars");
    const rng = mulberry32(3);
    for (let n = 0; n < 100; n++) {
      const level = generateLevel({ tier: 1, ingredients: KEYS.filter(() => rng() < 0.5), meter: METER_CHOICES[n % 3] as MeterChoice, bars: 4, seed: n });
      expect(level.title).not.toContain("\u00b7");
      expect(level.id).not.toContain("\u00b7");
    }
  });

  it("is deterministic for a seed", () => {
    const opts = { tier: 1, ingredients: ["rests", "ties", "syncopation"] as Ingredient[], bars: 8 as const, seed: 9 };
    expect(generateLevel(opts)).toEqual(generateLevel(opts));
  });

  it("an explicit 6/8 or 3/4 meter is honoured", () => {
    expect(generateLevel({ tier: 1, ingredients: ["eighths"], meter: "6/8", bars: 4, seed: 1 }).meter).toEqual({ beats: 6, beatUnit: 8 });
    expect(generateLevel({ tier: 1, ingredients: ["eighths"], meter: "3/4", bars: 4, seed: 1 }).meter).toEqual({ beats: 3, beatUnit: 4 });
  });
});

// Generator for musically sensible, randomized reading exercises. Pure, seeded, no audio/UI
// concerns here — just picks beat-aligned rhythmic "cells" per tier and arranges them into
// 4-bar phrases that read like something a teacher would actually write.

import type { Level, Meter, RhythmEvent } from "../types";

/** Short human-readable description of what each tier adds, index 0 = tier 1. */
export const TIER_NAMES: string[] = [
  "Quarter notes",
  "Halves & wholes",
  "Rests",
  "Eighth notes",
  "Dotted rhythms",
  "Ties",
  "Sixteenths",
  "Syncopation",
  "Dotted eighth & sixteenth",
  "Off-beat rests",
  "Triplets",
  "3/4 & 6/8",
];

/** Meter families the generator writes in. Tiers 1–11 are all 4/4; tier 12 picks 3/4 or 6/8. */
type MeterKind = "4/4" | "3/4" | "6/8";

const METERS: Record<MeterKind, Meter> = {
  "4/4": { beats: 4, beatUnit: 4 },
  "3/4": { beats: 3, beatUnit: 4 },
  "6/8": { beats: 6, beatUnit: 8 },
};

/** Bar length in quarter notes. */
const BAR_QUARTERS: Record<MeterKind, number> = { "4/4": 4, "3/4": 3, "6/8": 3 };

/** The tier that introduces 3/4 and 6/8. */
const METER_TIER = 12;

/** Meters the pre-tier-12 simple-time cells fit in. */
const SIMPLE: MeterKind[] = ["4/4", "3/4"];
const DEFAULT_BPM = 80;
const EPSILON = 1e-6;

export function note(value: RhythmEvent["value"], opts: { dots?: 0 | 1; tie?: boolean; tuplet?: 3 } = {}): RhythmEvent {
  const event: RhythmEvent = { value, dots: opts.dots ?? 0, rest: false };
  if (opts.tie) event.tie = true;
  if (opts.tuplet) event.tuplet = opts.tuplet;
  return event;
}

export function rest(value: RhythmEvent["value"], opts: { dots?: 0 | 1; tuplet?: 3 } = {}): RhythmEvent {
  const event: RhythmEvent = { value, dots: opts.dots ?? 0, rest: true };
  if (opts.tuplet) event.tuplet = opts.tuplet;
  return event;
}

/** A seeded PRNG returning floats in [0, 1). */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A one- or two-beat (or whole-bar) rhythmic building block, aligned to the beat grid. */
interface Cell {
  /** Tier this cell is introduced in. */
  tier: number;
  /** Meters the cell can be written in; defaults to the simple meters, 4/4 and 3/4. */
  meters?: MeterKind[];
  /** Length in quarter notes: 1, 2 or 4 in simple time; 1.5 or 3 in 6/8. */
  quarters: number;
  /** In 4/4, two-beat cells may only start on beat 1 or beat 3 (0-based: position 0 or 2). */
  beatAligned?: boolean;
  /** Fills a whole bar: only offered at the start of an otherwise empty bar. */
  wholeBar?: boolean;
  /** Quarter notes of rest at the start of the cell, before any note onset. */
  restRun: number;
  /** Whether the whole cell is rest (so a following rest cell would extend the same run). */
  endsWithRest: boolean;
  make: () => RhythmEvent[];
}

const CELLS: Cell[] = [
  // Tier 1
  { tier: 1, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("q")] },
  // Tier 2
  { tier: 2, quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("h")] },
  { tier: 2, meters: ["4/4"], quarters: 4, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("w")] },
  // Dotted half: the whole bar in 3/4
  { tier: 2, meters: ["3/4"], quarters: 3, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 })] },
  // Tier 3
  { tier: 3, quarters: 1, restRun: 1, endsWithRest: true, make: () => [rest("q")] },
  { tier: 3, quarters: 2, beatAligned: true, restRun: 2, endsWithRest: true, make: () => [rest("h")] },
  // Tier 4
  { tier: 4, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8")] },
  // Tier 5
  { tier: 5, quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("q", { dots: 1 }), note("8")] },
  { tier: 5, quarters: 1, restRun: 0.5, endsWithRest: false, make: () => [rest("8"), note("8")] },
  // Tier 6 (quarter tied across the beat into an eighth pair's first note)
  { tier: 6, quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("q", { tie: true }), note("8"), note("8")] },
  // Tier 7
  { tier: 7, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("16"), note("16"), note("16")] },
  { tier: 7, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), note("16"), note("16")] },
  { tier: 7, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("16"), note("8")] },
  // Tier 8: syncopation — a quarter in the middle of two eighths, and an eighth tied over the beat
  { tier: 8, quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("q"), note("8")] },
  { tier: 8, quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8", { tie: true }), note("8"), note("8")] },
  { tier: 8, quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8", { tie: true }), note("q")] },
  // Tier 9: dotted eighth + sixteenth, and the reverse
  { tier: 9, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8", { dots: 1 }), note("16")] },
  { tier: 9, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("8", { dots: 1 })] },
  // Tier 10: eighth and sixteenth rests off the beat
  { tier: 10, quarters: 1, restRun: 0, endsWithRest: true, make: () => [note("8"), rest("8")] },
  { tier: 10, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), rest("16"), note("16")] },
  { tier: 10, quarters: 1, restRun: 0.25, endsWithRest: false, make: () => [rest("16"), note("16"), note("8")] },
  { tier: 10, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), rest("16"), note("16"), note("16")] },
  { tier: 10, quarters: 1, restRun: 0.25, endsWithRest: false, make: () => [rest("16"), note("16"), note("16"), note("16")] },
  // Tier 11: eighth-note triplets, and a triplet quarter + eighth
  { tier: 11, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8", { tuplet: 3 }), note("8", { tuplet: 3 }), note("8", { tuplet: 3 })] },
  { tier: 11, quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("q", { tuplet: 3 }), note("8", { tuplet: 3 })] },
  // Tier 12: compound time (6/8). Positions are multiples of a dotted quarter.
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("q", { dots: 1 })] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8"), note("8")] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("q"), note("8")] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("q")] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("16"), note("16"), note("8")] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 0.5, endsWithRest: false, make: () => [rest("8"), note("8"), note("8")] },
  { tier: 12, meters: ["6/8"], quarters: 1.5, restRun: 1.5, endsWithRest: true, make: () => [rest("q", { dots: 1 })] },
  { tier: 12, meters: ["6/8"], quarters: 3, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 })] },
];

/** Below tier 5, never let rests run longer than 2 beats in a row. */
const REST_LIMIT_TIER = 5;
const MAX_REST_RUN = 2;

/**
 * Probability a decision point picks a cell newly introduced at the current tier. Set well above
 * the ~40% "practise the new thing" target because forced cadence and cross-bar-tie events (which
 * dilute the measured per-beat new-tier fraction) never go through this decision at all.
 */
const NEW_CELL_PROBABILITY = 0.6;
const REST_TIER_NEW_PROBABILITY = 0.4;
/** Relative pick weight of an all-rest cell versus a note cell. */
const REST_WEIGHT = 0.4;

function pickCell(
  rng: Rng,
  tier: number,
  kind: MeterKind,
  remaining: number,
  beatPos: number,
  consecutiveRest: number,
  disallowRest: boolean,
): Cell {
  const enforceRestLimit = tier < REST_LIMIT_TIER;
  const eligible = CELLS.filter((cell) => {
    if (cell.tier > tier) return false;
    if (!(cell.meters ?? SIMPLE).includes(kind)) return false;
    if (cell.quarters > remaining + EPSILON) return false;
    if (cell.beatAligned && kind === "4/4" && beatPos % 2 !== 0) return false;
    if (cell.wholeBar && (beatPos !== 0 || Math.abs(remaining - BAR_QUARTERS[kind]) > EPSILON)) return false;
    if (disallowRest && cell.restRun > 0) return false;
    if (enforceRestLimit && consecutiveRest + cell.restRun > MAX_REST_RUN + EPSILON) return false;
    return true;
  });

  const newCells = eligible.filter((cell) => cell.tier === tier);
  const oldCells = eligible.filter((cell) => cell.tier !== tier);

  // Rests are the one "new thing" that can swamp an exercise (h hr | hr q q | ...), so the rest
  // tier introduces them less aggressively and they're weighted down among notes everywhere.
  const newProbability = newCells.length > 0 && newCells.every(isRestCell) ? REST_TIER_NEW_PROBABILITY : NEW_CELL_PROBABILITY;
  let pool: Cell[];
  if (newCells.length > 0 && oldCells.length > 0) {
    pool = rng() < newProbability ? newCells : oldCells;
  } else if (newCells.length > 0) {
    pool = newCells;
  } else {
    // The plain quarter note cell (tier 1) always fits and is never filtered out, so this is
    // reachable only when disallowRest/restLimit removed everything else — quarters fall back to it.
    pool = oldCells.length > 0 ? oldCells : eligible;
  }

  const weights = pool.map((cell) => (isRestCell(cell) ? REST_WEIGHT : 1));
  let r = rng() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i] ?? 0;
    const cell = pool[i];
    if (r <= 0 && cell) return cell;
  }
  const fallback = pool[pool.length - 1];
  if (!fallback) throw new Error("generate: cell pool was unexpectedly empty");
  return fallback;
}

function isRestCell(cell: Cell): boolean {
  return cell.endsWithRest && cell.restRun >= cell.quarters;
}

export interface BarOptions {
  /** Meter family the bar is written in. */
  kind: MeterKind;
  /** Forbid a rest as the very first event of the bar (used for the exercise's first bar). */
  disallowLeadingRest?: boolean;
  /** Bar starts with a plain quarter that is the tied-into continuation of the previous bar's half. */
  forceLeadingTieContinuation?: boolean;
  /** Bar ends with a half note tied into the next bar's first quarter. */
  forceTrailingTiedHalf?: boolean;
  /** Bar ends with a plain (untied) long note — a half, or a dotted quarter in 6/8 — used for cadences. */
  forceTrailingHalf?: boolean;
}

export function buildBarEvents(rng: Rng, tier: number, options: BarOptions): RhythmEvent[] {
  const { kind } = options;
  const totalBeats = BAR_QUARTERS[kind];
  const cadenceLength = kind === "6/8" ? 1.5 : 2;
  const events: RhythmEvent[] = [];
  let beatPos = 0;
  let consecutiveRest = 0;

  if (options.forceLeadingTieContinuation) {
    events.push(note("q"));
    beatPos += 1;
  }

  const trailingLongNote = options.forceTrailingTiedHalf || options.forceTrailingHalf;
  const targetBeats = trailingLongNote ? totalBeats - cadenceLength : totalBeats;

  while (beatPos < targetBeats - EPSILON) {
    const remaining = targetBeats - beatPos;
    const disallowRest = !!options.disallowLeadingRest && events.length === 0;
    const cell = pickCell(rng, tier, kind, remaining, beatPos, consecutiveRest, disallowRest);
    events.push(...cell.make());
    beatPos += cell.quarters;
    consecutiveRest = cell.endsWithRest ? consecutiveRest + cell.restRun : 0;
  }

  if (options.forceTrailingTiedHalf) {
    events.push(note("h", { tie: true }));
  } else if (options.forceTrailingHalf) {
    events.push(kind === "6/8" ? note("q", { dots: 1 }) : note("h"));
  }

  return events;
}

/** Probability a phrase's cadence bar is a whole note instead of a plain half note. */
const CADENCE_WHOLE_PROBABILITY = 0.25;

function buildCadenceBar(rng: Rng, tier: number, kind: MeterKind): RhythmEvent[] {
  if (rng() < CADENCE_WHOLE_PROBABILITY) return [kind === "4/4" ? note("w") : note("h", { dots: 1 })];
  return buildBarEvents(rng, tier, { kind, forceTrailingHalf: true });
}

export function cloneBar(bar: RhythmEvent[]): RhythmEvent[] {
  return bar.map((event) => ({ ...event }));
}

/** Probability of the given repeat/variation choice at each junction. */
const REPEAT_BAR2_PROBABILITY = 0.4;
const REPEAT_BAR3_PROBABILITY = 0.35;
/** Probability of a tier-6 cross-bar tie at an eligible phrase junction. */
const CROSS_BAR_TIE_PROBABILITY = 0.18;

/** Builds one 4-bar phrase: A, A' (or fresh), B (or a variation of A), then a cadence bar. */
export function buildPhrase(rng: Rng, tier: number, kind: MeterKind, exerciseStartsHere: boolean): RhythmEvent[][] {
  // The tied-half-into-quarter cross-bar tie is written for 4/4 only.
  const allowCrossBarTies = tier >= 6 && kind === "4/4";
  const tieAfterBar1 = allowCrossBarTies && rng() < CROSS_BAR_TIE_PROBABILITY;
  const tieAfterBar2 = allowCrossBarTies && !tieAfterBar1 && rng() < CROSS_BAR_TIE_PROBABILITY;

  const bar1 = buildBarEvents(rng, tier, {
    kind,
    disallowLeadingRest: exerciseStartsHere,
    forceTrailingTiedHalf: tieAfterBar1,
  });

  let bar2: RhythmEvent[];
  if (!tieAfterBar1 && rng() < REPEAT_BAR2_PROBABILITY) {
    bar2 = cloneBar(bar1);
  } else {
    bar2 = buildBarEvents(rng, tier, {
      kind,
      forceLeadingTieContinuation: tieAfterBar1,
      forceTrailingTiedHalf: tieAfterBar2,
    });
  }

  let bar3: RhythmEvent[];
  if (!tieAfterBar1 && !tieAfterBar2 && rng() < REPEAT_BAR3_PROBABILITY) {
    bar3 = cloneBar(bar1);
  } else {
    bar3 = buildBarEvents(rng, tier, { kind, forceLeadingTieContinuation: tieAfterBar2 });
  }

  const bar4 = buildCadenceBar(rng, tier, kind);

  return [bar1, bar2, bar3, bar4];
}

/** Options for {@link generateLevel}. */
export interface GenerateOptions {
  /** How advanced a rhythmic vocabulary to draw from (1–12, see {@link TIER_NAMES}). */
  tier: number;
  /** Exercise length in bars. */
  bars: 4 | 8 | 16;
  /** Tempo in quarter notes per minute. Defaults to 80. */
  bpm?: number;
  /** PRNG seed; same seed (and options) always produces the same exercise. */
  seed?: number;
}

/** Generates a randomized, musically sensible reading exercise: in 4/4, or in 3/4 or 6/8 at tier 12. */
export function generateLevel(opts: GenerateOptions): Level {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const { tier } = opts;
  const kind: MeterKind = tier >= METER_TIER ? (rng() < 0.5 ? "3/4" : "6/8") : "4/4";

  const bars: RhythmEvent[][] = [];
  const phraseCount = opts.bars / 4;
  for (let phrase = 0; phrase < phraseCount; phrase++) {
    bars.push(...buildPhrase(rng, tier, kind, phrase === 0));
  }

  return {
    id: `gen-t${tier}-${seed}`,
    title: `Reading · tier ${tier} · ${opts.bars} bars`,
    meter: METERS[kind],
    bpm: opts.bpm ?? DEFAULT_BPM,
    bars,
  };
}

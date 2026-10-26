// Generator for musically sensible, randomized reading exercises. Pure, seeded, no audio/UI
// concerns here — just picks beat-aligned rhythmic "cells" per tier and arranges them into
// 4-bar phrases that read like something a teacher would actually write.

import type { Level, RhythmEvent } from "../types";

/** Short human-readable description of what each tier adds, index 0 = tier 1. */
export const TIER_NAMES: string[] = [
  "Quarter notes",
  "Halves & wholes",
  "Rests",
  "Eighth notes",
  "Dotted rhythms",
  "Ties",
  "Sixteenths",
];

const METER = { beats: 4, beatUnit: 4 } as const;
const DEFAULT_BPM = 80;
const EPSILON = 1e-6;

export function note(value: RhythmEvent["value"], opts: { dots?: 0 | 1; tie?: boolean } = {}): RhythmEvent {
  const event: RhythmEvent = { value, dots: opts.dots ?? 0, rest: false };
  if (opts.tie) event.tie = true;
  return event;
}

export function rest(value: RhythmEvent["value"]): RhythmEvent {
  return { value, dots: 0, rest: true };
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
  /** Length in quarter notes: 1, 2, or 4. */
  quarters: number;
  /** Two- and four-beat cells may only start on beat 1 or beat 3 (0-based: position 0 or 2). */
  beatAligned?: boolean;
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
  { tier: 2, quarters: 4, restRun: 0, endsWithRest: false, make: () => [note("w")] },
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

function pickCell(rng: Rng, tier: number, remaining: number, beatPos: number, consecutiveRest: number, disallowRest: boolean): Cell {
  const enforceRestLimit = tier < REST_LIMIT_TIER;
  const eligible = CELLS.filter((cell) => {
    if (cell.tier > tier) return false;
    if (cell.quarters > remaining + EPSILON) return false;
    if (cell.beatAligned && beatPos % 2 !== 0) return false;
    if (cell.quarters === 4 && (beatPos !== 0 || Math.abs(remaining - 4) > EPSILON)) return false;
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
  /** Forbid a rest as the very first event of the bar (used for the exercise's first bar). */
  disallowLeadingRest?: boolean;
  /** Bar starts with a plain quarter that is the tied-into continuation of the previous bar's half. */
  forceLeadingTieContinuation?: boolean;
  /** Bar ends with a half note tied into the next bar's first quarter. */
  forceTrailingTiedHalf?: boolean;
  /** Bar ends with a plain (untied) half note — used for cadences. */
  forceTrailingHalf?: boolean;
}

export function buildBarEvents(rng: Rng, tier: number, options: BarOptions = {}): RhythmEvent[] {
  const totalBeats = METER.beats;
  const events: RhythmEvent[] = [];
  let beatPos = 0;
  let consecutiveRest = 0;

  if (options.forceLeadingTieContinuation) {
    events.push(note("q"));
    beatPos += 1;
  }

  const trailingLongNote = options.forceTrailingTiedHalf || options.forceTrailingHalf;
  const targetBeats = trailingLongNote ? totalBeats - 2 : totalBeats;

  while (beatPos < targetBeats - EPSILON) {
    const remaining = targetBeats - beatPos;
    const disallowRest = !!options.disallowLeadingRest && events.length === 0;
    const cell = pickCell(rng, tier, remaining, beatPos, consecutiveRest, disallowRest);
    events.push(...cell.make());
    beatPos += cell.quarters;
    consecutiveRest = cell.endsWithRest ? consecutiveRest + cell.restRun : 0;
  }

  if (options.forceTrailingTiedHalf) {
    events.push(note("h", { tie: true }));
  } else if (options.forceTrailingHalf) {
    events.push(note("h"));
  }

  return events;
}

/** Probability a phrase's cadence bar is a whole note instead of a plain half note. */
const CADENCE_WHOLE_PROBABILITY = 0.25;

function buildCadenceBar(rng: Rng, tier: number): RhythmEvent[] {
  if (rng() < CADENCE_WHOLE_PROBABILITY) return [note("w")];
  return buildBarEvents(rng, tier, { forceTrailingHalf: true });
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
export function buildPhrase(rng: Rng, tier: number, exerciseStartsHere: boolean): RhythmEvent[][] {
  const allowCrossBarTies = tier >= 6;
  const tieAfterBar1 = allowCrossBarTies && rng() < CROSS_BAR_TIE_PROBABILITY;
  const tieAfterBar2 = allowCrossBarTies && !tieAfterBar1 && rng() < CROSS_BAR_TIE_PROBABILITY;

  const bar1 = buildBarEvents(rng, tier, {
    disallowLeadingRest: exerciseStartsHere,
    forceTrailingTiedHalf: tieAfterBar1,
  });

  let bar2: RhythmEvent[];
  if (!tieAfterBar1 && rng() < REPEAT_BAR2_PROBABILITY) {
    bar2 = cloneBar(bar1);
  } else {
    bar2 = buildBarEvents(rng, tier, {
      forceLeadingTieContinuation: tieAfterBar1,
      forceTrailingTiedHalf: tieAfterBar2,
    });
  }

  let bar3: RhythmEvent[];
  if (!tieAfterBar1 && !tieAfterBar2 && rng() < REPEAT_BAR3_PROBABILITY) {
    bar3 = cloneBar(bar1);
  } else {
    bar3 = buildBarEvents(rng, tier, { forceLeadingTieContinuation: tieAfterBar2 });
  }

  const bar4 = buildCadenceBar(rng, tier);

  return [bar1, bar2, bar3, bar4];
}

/** Options for {@link generateLevel}. */
export interface GenerateOptions {
  /** How advanced a rhythmic vocabulary to draw from (1–7, see {@link TIER_NAMES}). */
  tier: number;
  /** Exercise length in bars. */
  bars: 4 | 8 | 16;
  /** Tempo in quarter notes per minute. Defaults to 80. */
  bpm?: number;
  /** PRNG seed; same seed (and options) always produces the same exercise. */
  seed?: number;
}

/** Generates a randomized, musically sensible reading exercise in 4/4. */
export function generateLevel(opts: GenerateOptions): Level {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const { tier } = opts;

  const bars: RhythmEvent[][] = [];
  const phraseCount = opts.bars / 4;
  for (let phrase = 0; phrase < phraseCount; phrase++) {
    bars.push(...buildPhrase(rng, tier, phrase === 0));
  }

  return {
    id: `gen-t${tier}-${seed}`,
    title: `Reading · tier ${tier} · ${opts.bars} bars`,
    meter: METER,
    bpm: opts.bpm ?? DEFAULT_BPM,
    bars,
  };
}

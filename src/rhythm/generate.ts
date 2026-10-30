// Generator for musically sensible, randomized reading exercises. Pure, seeded, no audio/UI
// concerns here — just picks beat-aligned rhythmic "cells" per tier and arranges them into
// 4-bar phrases that read like something a teacher would actually write.

import { joinList, type Key, t, tEn } from "../i18n";
import type { Level, Meter, RhythmEvent } from "../types";

/** Short human-readable description of what each tier adds, index 0 = tier 1. */
export const TIER_NAMES: string[] = Array.from({ length: 12 }, (_, i) => tEn(`tier.${i + 1}` as Key));

/** The name of a tier (1-12) in the current language. */
export function tierName(tier: number): string {
  return tier >= 1 && tier <= 12 ? t(`tier.${tier}` as Key) : t("tier.n", { n: tier });
}

/** One independent rhythmic ingredient the player can switch on (Free practice mode). */
export type Ingredient =
  | "quarters"
  | "halves"
  | "rests"
  | "eighths"
  | "dotted"
  | "ties"
  | "sixteenths"
  | "syncopation"
  | "dottedEighths"
  | "offbeatRests"
  | "triplets";

/** An ingredient's label in the current language (`INGREDIENTS[].label` is always English). */
export function ingredientLabel(key: Ingredient): string {
  return t(`ing.${key}` as Key);
}

/** For the UI: one entry per ingredient, in curriculum order. `tier` is the tier that introduces it. */
export const INGREDIENTS: { key: Ingredient; label: string; tier: number }[] = [
  { key: "quarters", label: tEn("ing.quarters"), tier: 1 },
  { key: "halves", label: tEn("ing.halves"), tier: 2 },
  { key: "rests", label: tEn("ing.rests"), tier: 3 },
  { key: "eighths", label: tEn("ing.eighths"), tier: 4 },
  { key: "dotted", label: tEn("ing.dotted"), tier: 5 },
  { key: "ties", label: tEn("ing.ties"), tier: 6 },
  { key: "sixteenths", label: tEn("ing.sixteenths"), tier: 7 },
  { key: "syncopation", label: tEn("ing.syncopation"), tier: 8 },
  { key: "dottedEighths", label: tEn("ing.dottedEighths"), tier: 9 },
  { key: "offbeatRests", label: tEn("ing.offbeatRests"), tier: 10 },
  { key: "triplets", label: tEn("ing.triplets"), tier: 11 },
];

const INGREDIENT_TIER: Record<Ingredient, number> = Object.fromEntries(INGREDIENTS.map((i) => [i.key, i.tier])) as Record<Ingredient, number>;

/** The cumulative ingredient set a tier stands for (tier 12 = all of tier 11; meters are separate). */
export function ingredientsForTier(tier: number): Ingredient[] {
  return INGREDIENTS.filter((i) => i.tier <= tier).map((i) => i.key);
}

export type MeterChoice = "4/4" | "3/4" | "6/8";

/** Meter families the generator writes in. Tiers 1–11 are all 4/4; tier 12 picks 3/4 or 6/8. */
type MeterKind = MeterChoice;

/**
 * What the builders draw from: the allowed ingredients and the one to practise most. A bare tier
 * number is accepted wherever a palette is, and means the classic cumulative tier.
 */
export interface Palette {
  ingredients: ReadonlySet<Ingredient>;
  focus: Ingredient;
  /** Set for tier palettes: the legacy "newly introduced at this tier" logic is then used for the focus. */
  tier?: number;
}

export function tierPalette(tier: number): Palette {
  return { ingredients: new Set(ingredientsForTier(tier)), focus: "quarters", tier };
}

/** Builds a palette from a list: "quarters" is always in; focus defaults to the highest-tier ingredient. */
export function ingredientPalette(list: readonly Ingredient[], focus?: Ingredient): Palette {
  const set = new Set<Ingredient>(list);
  set.add("quarters");
  if (focus) set.add(focus);
  const top = [...set].reduce((best, key) => (INGREDIENT_TIER[key] > INGREDIENT_TIER[best] ? key : best), "quarters" as Ingredient);
  return { ingredients: set, focus: focus ?? top };
}

function toPalette(p: Palette | number): Palette {
  return typeof p === "number" ? tierPalette(p) : p;
}

/** Ingredients in curriculum order, from a palette's set. */
function orderedIngredients(set: ReadonlySet<Ingredient>): Ingredient[] {
  return INGREDIENTS.filter((i) => set.has(i.key)).map((i) => i.key);
}

/** "Eighths, rests and ties": plain words, sentence case; quarters are left out unless alone. */
export function describeIngredients(set: ReadonlySet<Ingredient>): string {
  const keys = orderedIngredients(set).filter((k) => k !== "quarters");
  const labels = (keys.length > 0 ? keys : (["quarters"] as Ingredient[])).map((k) => ingredientLabel(k).toLowerCase());
  const text = joinList(labels);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** " in 6/8" for a title; nothing for 4/4. */
export function meterPart(kind: MeterKind): string {
  return kind === "4/4" ? "" : t("inMeter", { meter: kind });
}

export const METERS: Record<MeterKind, Meter> = {
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
/** A calm default tempo for sight-reading; players can change it on the home screen. */
const DEFAULT_BPM = 65;
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
  /**
   * Ingredients the cell needs switched on (quarters are always on). It may also contain plainer
   * values than these, e.g. the syncopation cells contain eighths, but never anything from an
   * ingredient that is both off and checkable: ties, sixteenths, rests, tuplets, 4/4 dots.
   */
  needs: Ingredient[];
  /** Only offered in ingredient mode (fills gaps where a lone ingredient has too few cells). */
  ingredientOnly?: boolean;
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
  { tier: 1, needs: [], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("q")] },
  // Tier 2
  { tier: 2, needs: ["halves"], quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("h")] },
  { tier: 2, needs: ["halves"], meters: ["4/4"], quarters: 4, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("w")] },
  // Dotted half: the whole bar in 3/4
  { tier: 2, needs: ["halves"], meters: ["3/4"], quarters: 3, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 })] },
  // Tier 3
  { tier: 3, needs: ["rests"], quarters: 1, restRun: 1, endsWithRest: true, make: () => [rest("q")] },
  { tier: 3, needs: ["rests"], quarters: 2, beatAligned: true, restRun: 2, endsWithRest: true, make: () => [rest("h")] },
  // Tier 4
  { tier: 4, needs: ["eighths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8")] },
  // Tier 5
  { tier: 5, needs: ["dotted"], quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("q", { dots: 1 }), note("8")] },
  { tier: 5, needs: ["rests", "eighths"], quarters: 1, restRun: 0.5, endsWithRest: false, make: () => [rest("8"), note("8")] },
  // Ingredient mode only: dotted half with a quarter, so "dotted" works without leaning on eighths
  { tier: 5, needs: ["dotted"], ingredientOnly: true, meters: ["4/4"], quarters: 4, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 }), note("q")] },
  { tier: 5, needs: ["dotted"], ingredientOnly: true, meters: ["4/4"], quarters: 4, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("q"), note("h", { dots: 1 })] },
  { tier: 5, needs: ["dotted"], ingredientOnly: true, meters: ["3/4"], quarters: 3, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 })] },
  // Tier 6 (quarter tied across the beat into an eighth pair's first note)
  { tier: 6, needs: ["ties"], quarters: 2, beatAligned: true, restRun: 0, endsWithRest: false, make: () => [note("q", { tie: true }), note("8"), note("8")] },
  // No quarter-tied-to-quarter cell: inside a bar that's just a half note. Quarters tie only across the barline.
  // Tier 7
  { tier: 7, needs: ["sixteenths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("16"), note("16"), note("16")] },
  { tier: 7, needs: ["sixteenths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), note("16"), note("16")] },
  { tier: 7, needs: ["sixteenths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("16"), note("8")] },
  // Tier 8: syncopation — a quarter in the middle of two eighths, and an eighth tied over the beat
  { tier: 8, needs: ["syncopation"], quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("q"), note("8")] },
  { tier: 8, needs: ["syncopation", "ties"], quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8", { tie: true }), note("8"), note("8")] },
  { tier: 8, needs: ["syncopation", "ties"], quarters: 2, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8", { tie: true }), note("q")] },
  // Tier 9: dotted eighth + sixteenth, and the reverse
  { tier: 9, needs: ["dottedEighths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8", { dots: 1 }), note("16")] },
  { tier: 9, needs: ["dottedEighths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), note("8", { dots: 1 })] },
  // Tier 10: eighth and sixteenth rests off the beat
  { tier: 10, needs: ["offbeatRests"], quarters: 1, restRun: 0, endsWithRest: true, make: () => [note("8"), rest("8")] },
  { tier: 10, needs: ["offbeatRests", "sixteenths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8"), rest("16"), note("16")] },
  { tier: 10, needs: ["offbeatRests", "sixteenths"], quarters: 1, restRun: 0.25, endsWithRest: false, make: () => [rest("16"), note("16"), note("8")] },
  { tier: 10, needs: ["offbeatRests", "sixteenths"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("16"), rest("16"), note("16"), note("16")] },
  { tier: 10, needs: ["offbeatRests", "sixteenths"], quarters: 1, restRun: 0.25, endsWithRest: false, make: () => [rest("16"), note("16"), note("16"), note("16")] },
  // Tier 11: eighth-note triplets, and a triplet quarter + eighth
  { tier: 11, needs: ["triplets"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("8", { tuplet: 3 }), note("8", { tuplet: 3 }), note("8", { tuplet: 3 })] },
  { tier: 11, needs: ["triplets"], quarters: 1, restRun: 0, endsWithRest: false, make: () => [note("q", { tuplet: 3 }), note("8", { tuplet: 3 })] },
  // Tier 12: compound time (6/8). Positions are multiples of a dotted quarter.
  { tier: 12, needs: [], meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("q", { dots: 1 })] },
  { tier: 12, needs: ["eighths"], meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("8"), note("8")] },
  { tier: 12, needs: ["eighths"], meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("q"), note("8")] },
  { tier: 12, needs: ["eighths"], meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("q")] },
  { tier: 12, needs: ["sixteenths"], meters: ["6/8"], quarters: 1.5, restRun: 0, endsWithRest: false, make: () => [note("8"), note("16"), note("16"), note("8")] },
  { tier: 12, needs: ["rests", "eighths"], meters: ["6/8"], quarters: 1.5, restRun: 0.5, endsWithRest: false, make: () => [rest("8"), note("8"), note("8")] },
  { tier: 12, needs: ["rests"], meters: ["6/8"], quarters: 1.5, restRun: 1.5, endsWithRest: true, make: () => [rest("q", { dots: 1 })] },
  { tier: 12, needs: ["halves"], meters: ["6/8"], quarters: 3, wholeBar: true, restRun: 0, endsWithRest: false, make: () => [note("h", { dots: 1 })] },
];

/** Below tier 5 (or with no ingredient from tier 5 up), never let rests run longer than 2 beats in a row. */
const REST_LIMIT_TIER = 5;
const MAX_REST_RUN = 2;

/**
 * Probability a decision point picks a cell that practises the focus (the newly introduced cells,
 * in tier mode). Set well above the ~40% "practise the new thing" target because forced cadence
 * and cross-bar-tie events (which dilute the measured per-beat fraction) never go through this
 * decision at all.
 */
const NEW_CELL_PROBABILITY = 0.6;
const REST_TIER_NEW_PROBABILITY = 0.4;
/** Relative pick weight of an all-rest cell versus a note cell. */
const REST_WEIGHT = 0.4;

function cellAllowed(cell: Cell, palette: Palette): boolean {
  if (palette.tier !== undefined) return cell.tier <= palette.tier && !cell.ingredientOnly;
  return cell.needs.every((n) => palette.ingredients.has(n));
}

function cellIsFocus(cell: Cell, palette: Palette): boolean {
  if (palette.tier !== undefined) return cell.tier === palette.tier;
  if (palette.focus === "quarters") return cell.needs.length === 0;
  return cell.needs.includes(palette.focus);
}

/**
 * Stricter than {@link cellIsFocus} for lessons: the cell uses the tier's own ingredient (a tier
 * 5 "dotted notes" phrase needs a dotted note, not just the eighth rest that tier also adds).
 */
function cellPractisesFocus(cell: Cell, palette: Palette): boolean {
  const tierKey = palette.tier !== undefined ? INGREDIENTS.find((i) => i.tier === palette.tier)?.key : undefined;
  if (tierKey && tierKey !== "quarters") return cell.tier === palette.tier && cell.needs.includes(tierKey);
  return cellIsFocus(cell, palette);
}

function restLimitApplies(palette: Palette): boolean {
  if (palette.tier !== undefined) return palette.tier < REST_LIMIT_TIER;
  return !INGREDIENTS.some((i) => i.tier >= REST_LIMIT_TIER && palette.ingredients.has(i.key));
}

function pickCell(
  rng: Rng,
  palette: Palette,
  kind: MeterKind,
  remaining: number,
  beatPos: number,
  consecutiveRest: number,
  disallowRest: boolean,
  disallowWholeBar = false,
): Cell {
  const enforceRestLimit = restLimitApplies(palette);
  const eligible = CELLS.filter((cell) => {
    if (!cellAllowed(cell, palette)) return false;
    if (!(cell.meters ?? SIMPLE).includes(kind)) return false;
    if (cell.quarters > remaining + EPSILON) return false;
    if (cell.beatAligned && kind === "4/4" && beatPos % 2 !== 0) return false;
    if (cell.wholeBar && disallowWholeBar && isLongNoteCell(cell)) return false;
    if (cell.wholeBar && (beatPos !== 0 || Math.abs(remaining - BAR_QUARTERS[kind]) > EPSILON)) return false;
    if (disallowRest && cell.restRun > 0) return false;
    if (enforceRestLimit && consecutiveRest + cell.restRun > MAX_REST_RUN + EPSILON) return false;
    return true;
  });

  const newCells = eligible.filter((cell) => cellIsFocus(cell, palette));
  const oldCells = eligible.filter((cell) => !cellIsFocus(cell, palette));

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

/** A whole-bar cell that is one single note (w, or a dotted half). */
function isLongNoteCell(cell: Cell): boolean {
  return cell.make().length === 1;
}

/** A bar that is one long note: a whole note, or a dotted half in 3/4 or 6/8. */
export function isLongNoteBar(bar: readonly RhythmEvent[]): boolean {
  return bar.length === 1 && !bar[0]?.rest;
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
  /** Forbid a bar that is one long note (a whole note, or a dotted half in 3/4 or 6/8). */
  disallowWholeBar?: boolean;
  /** Counts the focus cells picked, so a phrase can check it practises the focus at all. */
  stats?: { focus: number };
}

/** `palette` is a {@link Palette}, or a tier number meaning the classic cumulative tier. */
export function buildBarEvents(rng: Rng, palette: Palette | number, options: BarOptions): RhythmEvent[] {
  const pal = toPalette(palette);
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
    const cell = pickCell(rng, pal, kind, remaining, beatPos, consecutiveRest, disallowRest, !!options.disallowWholeBar);
    if (options.stats && cellPractisesFocus(cell, pal)) options.stats.focus++;
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

function buildCadenceBar(rng: Rng, palette: Palette, kind: MeterKind, afterLongBar: boolean): RhythmEvent[] {
  if (!afterLongBar && rng() < CADENCE_WHOLE_PROBABILITY) return [kind === "4/4" ? note("w") : note("h", { dots: 1 })];
  return buildBarEvents(rng, palette, { kind, forceTrailingHalf: true });
}

export function cloneBar(bar: RhythmEvent[]): RhythmEvent[] {
  return bar.map((event) => ({ ...event }));
}

/** Probability of the given repeat/variation choice at each junction. */
const REPEAT_BAR2_PROBABILITY = 0.4;
const REPEAT_BAR3_PROBABILITY = 0.35;
/** Probability of a cross-bar tie at an eligible phrase junction. */
const CROSS_BAR_TIE_PROBABILITY = 0.18;

/** Tries per phrase before settling for one that misses the focus (only when it can barely fit). */
const PHRASE_ATTEMPTS = 30;

/**
 * Builds one 4-bar phrase: A, A' (or fresh), B (or a variation of A), then a cadence bar.
 * Two one-note bars (whole notes) never follow each other, the exercise never opens on one, and
 * the phrase practises the focus at least once (it's rebuilt until it does). `previousBar` is the
 * last bar before this phrase, if any.
 */
export function buildPhrase(rng: Rng, palette: Palette | number, kind: MeterKind, exerciseStartsHere: boolean, previousBar?: readonly RhythmEvent[]): RhythmEvent[][] {
  const pal = toPalette(palette);
  let phrase: RhythmEvent[][] = [];
  for (let attempt = 0; attempt < PHRASE_ATTEMPTS; attempt++) {
    const stats = { focus: 0 };
    phrase = buildPhraseOnce(rng, pal, kind, exerciseStartsHere, previousBar, stats);
    if (stats.focus > 0) return phrase;
  }
  return phrase;
}

function buildPhraseOnce(
  rng: Rng,
  pal: Palette,
  kind: MeterKind,
  exerciseStartsHere: boolean,
  previousBar: readonly RhythmEvent[] | undefined,
  stats: { focus: number },
): RhythmEvent[][] {
  // The tied-half-into-quarter cross-bar tie is written for 4/4 only.
  const allowCrossBarTies = pal.ingredients.has("ties") && kind === "4/4";
  const tieAfterBar1 = allowCrossBarTies && rng() < CROSS_BAR_TIE_PROBABILITY;
  const tieAfterBar2 = allowCrossBarTies && !tieAfterBar1 && rng() < CROSS_BAR_TIE_PROBABILITY;

  const bar1 = buildBarEvents(rng, pal, {
    kind,
    disallowLeadingRest: exerciseStartsHere,
    forceTrailingTiedHalf: tieAfterBar1,
    disallowWholeBar: exerciseStartsHere || (!!previousBar && isLongNoteBar(previousBar)),
    stats,
  });
  const bar1Focus = stats.focus;
  const bar1Long = isLongNoteBar(bar1);

  // A one-note bar is never repeated straight after itself.
  let bar2: RhythmEvent[];
  if (!tieAfterBar1 && !bar1Long && rng() < REPEAT_BAR2_PROBABILITY) {
    bar2 = cloneBar(bar1);
    stats.focus += bar1Focus;
  } else {
    bar2 = buildBarEvents(rng, pal, {
      kind,
      forceLeadingTieContinuation: tieAfterBar1,
      forceTrailingTiedHalf: tieAfterBar2,
      disallowWholeBar: bar1Long,
      stats,
    });
  }
  const bar2Long = isLongNoteBar(bar2);

  // Bar 3 may echo bar 1, unless that would put a one-note bar right after another.
  let bar3: RhythmEvent[];
  if (!tieAfterBar1 && !tieAfterBar2 && !(bar1Long && bar2Long) && rng() < REPEAT_BAR3_PROBABILITY) {
    bar3 = cloneBar(bar1);
    stats.focus += bar1Focus;
  } else {
    bar3 = buildBarEvents(rng, pal, { kind, forceLeadingTieContinuation: tieAfterBar2, disallowWholeBar: bar2Long, stats });
  }

  const bar4 = buildCadenceBar(rng, pal, kind, isLongNoteBar(bar3));

  return [bar1, bar2, bar3, bar4];
}

/** Options for {@link generateLevel}. */
export interface GenerateOptions {
  /** How advanced a rhythmic vocabulary to draw from (1–12, see {@link TIER_NAMES}). Ignored when `ingredients` is given. */
  tier: number;
  /** Free practice: the exact ingredients to draw from ("quarters" is always included). */
  ingredients?: Ingredient[];
  /** Ingredient mode: the meter to write in. Defaults to 4/4. */
  meter?: MeterChoice;
  /** Ingredient mode: the ingredient to practise most. Defaults to the selected one with the highest tier. */
  focus?: Ingredient;
  /** Exercise length in bars. */
  bars: 4 | 8 | 16;
  /** Tempo in quarter notes per minute. Defaults to 65. */
  bpm?: number;
  /** PRNG seed; same seed (and options) always produces the same exercise. */
  seed?: number;
}

/** Generates a randomized, musically sensible reading exercise: in 4/4, or in 3/4 or 6/8 at tier 12 or by choice. */
export function generateLevel(opts: GenerateOptions): Level {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);

  let palette: Palette;
  let kind: MeterKind;
  let id: string;
  let title: string;
  if (opts.ingredients) {
    palette = ingredientPalette(opts.ingredients, opts.focus);
    kind = opts.meter ?? "4/4";
    const code = orderedIngredients(palette.ingredients).map((k) => INGREDIENT_TIER[k].toString(36)).join("");
    id = `gen-i${code}-${kind.replace("/", "")}-${seed}`;
    title = t("title.level", { what: describeIngredients(palette.ingredients), meterPart: meterPart(kind), bars: t("bars", { n: opts.bars }) });
  } else {
    const { tier } = opts;
    palette = tierPalette(tier);
    kind = tier >= METER_TIER ? (rng() < 0.5 ? "3/4" : "6/8") : "4/4";
    id = `gen-t${tier}-${seed}`;
    title = t("title.tier", { name: tierName(tier), bars: t("bars", { n: opts.bars }) });
  }

  const bars: RhythmEvent[][] = [];
  const phraseCount = opts.bars / 4;
  for (let phrase = 0; phrase < phraseCount; phrase++) {
    bars.push(...buildPhrase(rng, palette, kind, phrase === 0, bars[bars.length - 1]));
  }

  return { id, title, meter: METERS[kind], bpm: opts.bpm ?? DEFAULT_BPM, bars };
}

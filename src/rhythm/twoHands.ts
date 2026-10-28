// Two-hand reading exercises: two independent rhythm lines, the left hand's on zone 0 and the
// right hand's on zone 1. Seeded and pure, like the one-line generator it builds on. The stages
// follow how a teacher brings in hand independence: take turns, play together, keep one hand
// steady under the other, then three against two. Pieces can be in 4/4, 3/4 or 6/8 (the
// three-against-two stage is 4/4 only; in 3/4 and 6/8 the cross bars are hemiolas).

import { type Key, t, tEn } from "../i18n";
import type { Level, RhythmEvent } from "../types";
import {
  buildBarEvents,
  buildPhrase,
  cloneBar,
  describeIngredients,
  type Ingredient,
  INGREDIENTS,
  ingredientPalette,
  type MeterChoice,
  METERS,
  mulberry32,
  note,
  type Palette,
  type Rng,
  rest,
  tierName,
  meterPart,
  tierPalette,
} from "./generate";

/** What each stage asks of the hands, index 0 = stage 1. */
export const TWO_HAND_STAGES: string[] = [1, 2, 3, 4].map((n) => tEn(`stage.${n}` as Key));

/** The name of a stage (1-4) in the current language. */
export function stageName(stage: number): string {
  return t(`stage.${stage}` as Key);
}

/** The ways the hands can relate in free practice (stages 1-3); "3 against 2" is a rhythm option, see `cross`. */
export const HAND_RELATIONS: string[] = TWO_HAND_STAGES.slice(0, 3).map((name) => (name === "Independence" ? "Independent" : name));

/** The relation names (stages 1-3) in the current language. */
export function handRelations(): string[] {
  return [1, 2, 3].map((n) => (n === 3 ? t("relation.3") : stageName(n)));
}

const DEFAULT_BPM = 65;

/** Default rhythm vocabulary: quarters, halves, rests and eighth pairs. */
const DEFAULT_TIER = 4;
/** The stages are written in 4/4, so the highest tier is the last one in 4/4 (triplets). */
export const MAX_TWO_HAND_TIER = 11;

type Bars = RhythmEvent[][];

/** The palette for the second reading hand: the same, minus up to the two highest-tier ingredients. */
function simpler(pal: Palette): Palette {
  if (pal.tier !== undefined) return tierPalette(Math.max(1, pal.tier - 2));
  const ordered = INGREDIENTS.filter((i) => pal.ingredients.has(i.key)).map((i) => i.key);
  return ingredientPalette(ordered.slice(0, Math.max(1, ordered.length - 2)));
}

/** What the duple hand may read under triplets: up to eighths, or nothing (steady quarters) if there are no rests or eighths. */
function dupleVocabulary(pal: Palette): Palette | undefined {
  if (pal.tier !== undefined) return pal.tier >= 3 ? tierPalette(Math.min(pal.tier, 4)) : undefined;
  const kept = (["halves", "rests", "eighths"] as Ingredient[]).filter((k) => pal.ingredients.has(k));
  return kept.includes("rests") || kept.includes("eighths") ? ingredientPalette(kept) : undefined;
}

function quarters(): RhythmEvent[] {
  return [note("q"), note("q"), note("q"), note("q")];
}

/** A bar of the steady beat: quarters in 4/4 and 3/4, dotted quarters in 6/8. */
function steadyBar(kind: MeterChoice): RhythmEvent[] {
  if (kind === "6/8") return [note("q", { dots: 1 }), note("q", { dots: 1 })];
  return kind === "3/4" ? [note("q"), note("q"), note("q")] : quarters();
}

/** The steady hand's phrase ending: two halves in 4/4, a dotted half in 3/4 and 6/8. */
function steadyCadence(kind: MeterChoice): RhythmEvent[] {
  return kind === "4/4" ? [note("h"), note("h")] : [note("h", { dots: 1 })];
}

/** A whole bar of rest: a whole rest in 4/4, a dotted half rest in 3/4 and 6/8. */
function wholeRest(kind: MeterChoice): RhythmEvent[] {
  return [kind === "4/4" ? rest("w") : rest("h", { dots: 1 })];
}

function tripletQuarters(): RhythmEvent[] {
  return [0, 1, 2].map(() => ({ ...note("q"), tuplet: 3 as const }));
}

/**
 * Stage 1: the hands take turns a bar at a time, the right hand calling and the left answering,
 * often with an echo of the call. The resting hand has a whole-bar rest.
 */
function callAndResponse(rng: Rng, bars: number, pal: Palette, kind: MeterChoice): [Bars, Bars] {
  const left: Bars = [];
  const right: Bars = [];
  for (let i = 0; i < bars; i += 2) {
    const call = buildBarEvents(rng, pal, { kind, disallowLeadingRest: true });
    const last = i + 2 >= bars;
    const answer = rng() < 0.5 ? cloneBar(call) : buildBarEvents(rng, pal, { kind, disallowLeadingRest: true, forceTrailingHalf: last });
    right.push(call, wholeRest(kind));
    left.push(wholeRest(kind), answer);
  }
  return [left, right];
}

/** Stage 2: both hands play the same line together. */
function unison(rng: Rng, bars: number, pal: Palette, kind: MeterChoice): [Bars, Bars] {
  const line: Bars = [];
  for (let p = 0; p < bars / 4; p++) line.push(...buildPhrase(rng, pal, kind, p === 0));
  return [line, line.map(cloneBar)];
}

/**
 * Stage 3: one hand keeps steady quarters while the other reads, swapping each phrase; from the
 * third phrase on both hands read their own rhythms.
 */
function independence(rng: Rng, bars: number, pal: Palette, kind: MeterChoice): [Bars, Bars] {
  const left: Bars = [];
  const right: Bars = [];
  for (let p = 0; p < bars / 4; p++) {
    const reading = buildPhrase(rng, pal, kind, true);
    if (p >= 2) {
      right.push(...reading);
      // The second reading hand reads a couple of tiers (or ingredients) simpler than the first.
      left.push(...buildPhrase(rng, simpler(pal), kind, true));
    } else {
      const steady = [steadyBar(kind), steadyBar(kind), steadyBar(kind), steadyCadence(kind)];
      (p === 0 ? right : left).push(...reading);
      (p === 0 ? left : right).push(...steady);
    }
  }
  return [left, right];
}

/**
 * Stage 4: three against two. One hand plays quarter-note triplets (three in the time of two
 * beats) over steady quarters in the other. Each phrase eases in with half a bar together, then
 * a full bar of 3:2, and ends on a half-bar cadence; the triplet hand swaps each phrase.
 */
function threeAgainstTwo(rng: Rng, bars: number, pal: Palette): [Bars, Bars] {
  const left: Bars = [];
  const right: Bars = [];
  for (let p = 0; p < bars / 4; p++) {
    const tripletHand = p % 2 === 0 ? right : left;
    const steadyHand = p % 2 === 0 ? left : right;
    const easeIn = [note("q"), note("q"), ...tripletQuarters()];
    const full = [...tripletQuarters(), ...tripletQuarters()];
    const third = rng() < 0.5 ? easeIn : full;
    const cadence = [...tripletQuarters(), note("h")];
    tripletHand.push(easeIn.map((e) => ({ ...e })), full, third.map((e) => ({ ...e })), cadence);
    // From tier 3 on the duple hand reads its own rhythm (up to eighth notes) under the
    // triplets, instead of only steady quarters.
    const duple = dupleVocabulary(pal);
    if (duple) {
      const phrase = buildPhrase(rng, duple, "4/4", true);
      steadyHand.push(...phrase.slice(0, 3), [note("q"), note("q"), note("h")]);
    } else {
      steadyHand.push(quarters(), quarters(), quarters(), [note("q"), note("q"), note("h")]);
    }
  }
  return [left, right];
}

/**
 * Puts cross-rhythm bars into a piece built by one of the relations: the third bar of every
 * four becomes a full bar of 3:2, one hand in quarter-note triplets over the other's
 * quarters/eighths (the triplet hand swaps each phrase). The bar before loses any tie into it.
 */
function addCrossBars(rng: Rng, pal: Palette, left: Bars, right: Bars, kind: MeterChoice): void {
  const duple = dupleVocabulary(pal);
  for (let at = 2, p = 0; at < left.length; at += 4, p++) {
    const [tripletHand, dupleHand] = p % 2 === 0 ? [right, left] : [left, right];
    if (kind === "4/4") {
      tripletHand[at] = [...tripletQuarters(), ...tripletQuarters()];
      dupleHand[at] = duple ? buildBarEvents(rng, duple, { kind, disallowLeadingRest: true }) : quarters();
    } else {
      // 3/4 and 6/8 hold three against two without tuplets (a hemiola): three quarters in one
      // hand against two dotted quarters in the other, across the same bar.
      tripletHand[at] = [note("q"), note("q"), note("q")];
      dupleHand[at] = [note("q", { dots: 1 }), note("q", { dots: 1 })];
    }
    for (const hand of [left, right]) {
      const before = hand[at - 1]?.at(-1);
      if (before?.tie) delete before.tie;
    }
  }
}

export interface TwoHandOptions {
  /** 1–4, see {@link TWO_HAND_STAGES}. */
  stage: number;
  /** Reading tier (see TIER_NAMES) the hands' rhythms come from, up to MAX_TWO_HAND_TIER. */
  tier?: number;
  /** Free practice: the exact ingredients to read (instead of `tier`). */
  ingredients?: Ingredient[];
  /** With `ingredients`: the one to practise most (defaults to the highest-tier one). */
  focus?: Ingredient;
  /** Stages 1-3: add cross-rhythm (3 against 2) bars to the piece. */
  cross?: boolean;
  /** Stages 1-3: the meter to write in (default 4/4). Stage 4 is always 4/4. */
  meter?: MeterChoice;
  bars: 4 | 8 | 16;
  bpm?: number;
  seed?: number;
}

/** Generates a two-hand exercise: `lines[0]` for the left hand, `lines[1]` for the right. */
export function generateTwoHandLevel(opts: TwoHandOptions): Level {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const stage = Math.min(TWO_HAND_STAGES.length, Math.max(1, Math.round(opts.stage)));
  const build = [callAndResponse, unison, independence, threeAgainstTwo][stage - 1] ?? callAndResponse;
  const tier = Math.min(MAX_TWO_HAND_TIER, Math.max(1, Math.round(opts.tier ?? DEFAULT_TIER)));
  const pal = opts.ingredients ? ingredientPalette(opts.ingredients, opts.focus) : tierPalette(tier);
  const kind: MeterChoice = stage === 4 ? "4/4" : (opts.meter ?? "4/4");
  const [left, right] = build(rng, opts.bars, pal, kind);
  const cross = Boolean(opts.cross) && stage < 4;
  if (cross) addCrossBars(rng, pal, left, right, kind);
  const meterCode = kind === "4/4" ? "" : `-${kind.replace("/", "")}`;
  return {
    id: `${opts.ingredients ? `gen-2h-s${stage}-i-${seed}` : `gen-2h-s${stage}-t${tier}-${seed}`}${cross ? "-x" : ""}${meterCode}`,
    title: t("title.twoHands", {
      stage: stageName(stage).toLowerCase(),
      cross: cross ? 1 : 0,
      what: opts.ingredients ? describeIngredients(pal.ingredients).toLowerCase() : tierName(tier).toLowerCase(),
      meterPart: meterPart(kind),
    }),
    meter: METERS[kind],
    bpm: opts.bpm ?? DEFAULT_BPM,
    bars: left,
    lines: [left, right],
  };
}

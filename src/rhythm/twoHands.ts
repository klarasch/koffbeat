// Two-hand reading exercises: two independent rhythm lines, the left hand's on zone 0 and the
// right hand's on zone 1. Seeded and pure, like the one-line generator it builds on. The stages
// follow how a teacher brings in hand independence: take turns, play together, keep one hand
// steady under the other, then three against two.

import type { Level, RhythmEvent } from "../types";
import {
  buildBarEvents,
  buildPhrase,
  cloneBar,
  describeIngredients,
  type Ingredient,
  INGREDIENTS,
  ingredientPalette,
  mulberry32,
  note,
  type Palette,
  type Rng,
  rest,
  TIER_NAMES,
  tierPalette,
} from "./generate";

/** What each stage asks of the hands, index 0 = stage 1. */
export const TWO_HAND_STAGES: string[] = ["Call and response", "Unison", "Independence", "3 against 2"];

const METER = { beats: 4, beatUnit: 4 } as const;
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

function wholeRest(): RhythmEvent[] {
  return [rest("w")];
}

function tripletQuarters(): RhythmEvent[] {
  return [0, 1, 2].map(() => ({ ...note("q"), tuplet: 3 as const }));
}

/**
 * Stage 1: the hands take turns a bar at a time, the right hand calling and the left answering,
 * often with an echo of the call. The resting hand has a whole-bar rest.
 */
function callAndResponse(rng: Rng, bars: number, pal: Palette): [Bars, Bars] {
  const left: Bars = [];
  const right: Bars = [];
  for (let i = 0; i < bars; i += 2) {
    const call = buildBarEvents(rng, pal, { kind: "4/4", disallowLeadingRest: true });
    const last = i + 2 >= bars;
    const answer = rng() < 0.5 ? cloneBar(call) : buildBarEvents(rng, pal, { kind: "4/4", disallowLeadingRest: true, forceTrailingHalf: last });
    right.push(call, wholeRest());
    left.push(wholeRest(), answer);
  }
  return [left, right];
}

/** Stage 2: both hands play the same line together. */
function unison(rng: Rng, bars: number, pal: Palette): [Bars, Bars] {
  const line: Bars = [];
  for (let p = 0; p < bars / 4; p++) line.push(...buildPhrase(rng, pal, "4/4", p === 0));
  return [line, line.map(cloneBar)];
}

/**
 * Stage 3: one hand keeps steady quarters while the other reads, swapping each phrase; from the
 * third phrase on both hands read their own rhythms.
 */
function independence(rng: Rng, bars: number, pal: Palette): [Bars, Bars] {
  const left: Bars = [];
  const right: Bars = [];
  for (let p = 0; p < bars / 4; p++) {
    const reading = buildPhrase(rng, pal, "4/4", true);
    if (p >= 2) {
      right.push(...reading);
      // The second reading hand reads a couple of tiers (or ingredients) simpler than the first.
      left.push(...buildPhrase(rng, simpler(pal), "4/4", true));
    } else {
      const steady = [quarters(), quarters(), quarters(), [note("h"), note("h")]];
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

export interface TwoHandOptions {
  /** 1–4, see {@link TWO_HAND_STAGES}. */
  stage: number;
  /** Reading tier (see TIER_NAMES) the hands' rhythms come from, up to MAX_TWO_HAND_TIER. */
  tier?: number;
  /** Free practice: the exact ingredients to read (instead of `tier`). */
  ingredients?: Ingredient[];
  /** With `ingredients`: the one to practise most (defaults to the highest-tier one). */
  focus?: Ingredient;
  bars: 4 | 8 | 16;
  bpm?: number;
  seed?: number;
}

/** Generates a two-hand exercise in 4/4: `lines[0]` for the left hand, `lines[1]` for the right. */
export function generateTwoHandLevel(opts: TwoHandOptions): Level {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const stage = Math.min(TWO_HAND_STAGES.length, Math.max(1, Math.round(opts.stage)));
  const build = [callAndResponse, unison, independence, threeAgainstTwo][stage - 1] ?? callAndResponse;
  const tier = Math.min(MAX_TWO_HAND_TIER, Math.max(1, Math.round(opts.tier ?? DEFAULT_TIER)));
  const pal = opts.ingredients ? ingredientPalette(opts.ingredients, opts.focus) : tierPalette(tier);
  const [left, right] = build(rng, opts.bars, pal);
  const stageName = TWO_HAND_STAGES[stage - 1]?.toLowerCase();
  return {
    id: opts.ingredients ? `gen-2h-s${stage}-i-${seed}` : `gen-2h-s${stage}-t${tier}-${seed}`,
    title: `Two hands: ${stageName}, ${opts.ingredients ? describeIngredients(pal.ingredients).toLowerCase() : TIER_NAMES[tier - 1]?.toLowerCase()}`,
    meter: METER,
    bpm: opts.bpm ?? DEFAULT_BPM,
    bars: left,
    lines: [left, right],
  };
}

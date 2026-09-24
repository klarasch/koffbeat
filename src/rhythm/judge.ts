// Judges player taps against a Level's onsets, live (during play) and
// offline (after a run), both judged against the player's own drifting
// pulse rather than a fixed metronome grid — see AGENTS-facing doc comments
// below for the reasoning behind each constant.

import type { Grade, Hit, Onset, OnsetJudgement, RunResult } from "../types";

/** Grade windows, as the absolute relative error in ms. */
export const PERFECT_MS = 35;
export const GOOD_MS = 70;
export const OK_MS = 120;

/**
 * Base matching window in ms: a hit further than this from an onset's
 * predicted time can never match it. Tightened per-onset in `matchWindowMs`
 * so a hit near two close onsets can't steal the neighbour's match.
 */
export const MATCH_WINDOW_MS = 150;
const NEIGHBOUR_WINDOW_FRACTION = 0.4;

/** Online pulse tracking: how much each matched hit nudges the tempo estimate. */
const PULSE_SMOOTHING = 0.2;
/** Online pulse tracking: estimate is clamped to nominal tempo ± this fraction. */
const PULSE_CLAMP_FRACTION = 0.15;

function nominalSecPerQuarter(bpm: number): number {
  return 60 / bpm;
}

function gradeFor(absErrorMs: number): Grade {
  if (absErrorMs <= PERFECT_MS) return "perfect";
  if (absErrorMs <= GOOD_MS) return "good";
  if (absErrorMs <= OK_MS) return "ok";
  return "miss";
}

/**
 * The match window for a given onset: the base window, tightened to 0.4x
 * the gap (in ms, at the current tempo estimate) to its nearest neighbour,
 * whichever is smaller.
 */
function matchWindowMs(onsets: Onset[], index: number, secPerQuarter: number): number {
  const onset = onsets[index];
  if (!onset) return MATCH_WINDOW_MS;
  let minGapQuarters = Number.POSITIVE_INFINITY;
  const prev = onsets[index - 1];
  const next = onsets[index + 1];
  if (prev) minGapQuarters = Math.min(minGapQuarters, onset.beat - prev.beat);
  if (next) minGapQuarters = Math.min(minGapQuarters, next.beat - onset.beat);
  if (!Number.isFinite(minGapQuarters)) return MATCH_WINDOW_MS;
  const gapMs = minGapQuarters * secPerQuarter * 1000;
  return Math.min(MATCH_WINDOW_MS, NEIGHBOUR_WINDOW_FRACTION * gapMs);
}

/**
 * Tracks the player's pulse online as (anchor beat, anchor time, seconds
 * per quarter). After each matched hit the anchor snaps to that hit and the
 * tempo estimate is smoothed towards the instantaneous tempo since the last
 * anchor, clamped to ±`PULSE_CLAMP_FRACTION` of the nominal tempo.
 */
class PulseEstimator {
  private anchorBeat = 0;
  private anchorTime: number;
  private secPerQuarter: number;
  private readonly min: number;
  private readonly max: number;

  constructor(startTime: number, nominal: number) {
    this.anchorTime = startTime;
    this.secPerQuarter = nominal;
    this.min = nominal * (1 - PULSE_CLAMP_FRACTION);
    this.max = nominal * (1 + PULSE_CLAMP_FRACTION);
  }

  predict(beat: number): number {
    return this.anchorTime + (beat - this.anchorBeat) * this.secPerQuarter;
  }

  currentSecPerQuarter(): number {
    return this.secPerQuarter;
  }

  update(beat: number, time: number): void {
    if (beat > this.anchorBeat) {
      const instantaneous = (time - this.anchorTime) / (beat - this.anchorBeat);
      const blended = this.secPerQuarter + PULSE_SMOOTHING * (instantaneous - this.secPerQuarter);
      this.secPerQuarter = Math.min(this.max, Math.max(this.min, blended));
    }
    this.anchorBeat = beat;
    this.anchorTime = time;
  }
}

interface MatchResult {
  index: number;
  errorMs: number;
}

/** Nearest unmatched onset to `hitTime`, within its match window, or null. */
function findBestMatch(onsets: Onset[], matchedOnsets: ReadonlySet<number>, estimator: PulseEstimator, hitTime: number): MatchResult | null {
  let bestIndex = -1;
  let bestErrorMs = 0;
  let bestAbsErrorMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < onsets.length; i++) {
    if (matchedOnsets.has(i)) continue;
    const onset = onsets[i];
    if (!onset) continue;
    const predicted = estimator.predict(onset.beat);
    const errorMs = (hitTime - predicted) * 1000;
    const absErrorMs = Math.abs(errorMs);
    const window = matchWindowMs(onsets, i, estimator.currentSecPerQuarter());
    if (absErrorMs > window) continue;
    if (absErrorMs < bestAbsErrorMs) {
      bestAbsErrorMs = absErrorMs;
      bestIndex = i;
      bestErrorMs = errorMs;
    }
  }
  if (bestIndex === -1) return null;
  return { index: bestIndex, errorMs: bestErrorMs };
}

export interface LiveHitJudgement {
  onsetIndex: number | null;
  errorMs: number | null;
  grade: Grade | null;
}

export interface LiveJudge {
  judgeHit(hit: Hit): LiveHitJudgement;
}

/**
 * Live, incremental judge for feedback during play. `startTime` is the
 * audio-clock time of beat 0 (the end of the count-in). Each onset can be
 * matched by at most one hit; the pulse estimate is updated after every
 * match so a slowly-drifting player is still judged against their own tempo.
 */
export function createLiveJudge(onsets: Onset[], startTime: number, bpm: number): LiveJudge {
  const estimator = new PulseEstimator(startTime, nominalSecPerQuarter(bpm));
  const matchedOnsets = new Set<number>();

  return {
    judgeHit(hit: Hit): LiveHitJudgement {
      const match = findBestMatch(onsets, matchedOnsets, estimator, hit.time);
      if (!match) return { onsetIndex: null, errorMs: null, grade: null };

      matchedOnsets.add(match.index);
      const onset = onsets[match.index];
      if (onset) estimator.update(onset.beat, hit.time);

      return { onsetIndex: match.index, errorMs: match.errorMs, grade: gradeFor(Math.abs(match.errorMs)) };
    },
  };
}

interface MatchedPoint {
  onsetIndex: number;
  beat: number;
  time: number;
}

/** Same online-pulse matching as the live judge, run over a whole hit list at once. */
function matchHitsToOnsets(
  onsets: Onset[],
  hits: Hit[],
  startTime: number,
  bpm: number,
): { onsetToHit: Map<number, number>; extraHitIndices: number[] } {
  const estimator = new PulseEstimator(startTime, nominalSecPerQuarter(bpm));
  const matchedOnsets = new Set<number>();
  const onsetToHit = new Map<number, number>();
  const extraHitIndices: number[] = [];

  const order = hits
    .map((_, i) => i)
    .sort((a, b) => (hits[a]?.time ?? 0) - (hits[b]?.time ?? 0));

  for (const hitIndex of order) {
    const hit = hits[hitIndex];
    if (!hit) continue;
    const match = findBestMatch(onsets, matchedOnsets, estimator, hit.time);
    if (!match) {
      extraHitIndices.push(hitIndex);
      continue;
    }
    matchedOnsets.add(match.index);
    onsetToHit.set(match.index, hitIndex);
    const onset = onsets[match.index];
    if (onset) estimator.update(onset.beat, hit.time);
  }

  return { onsetToHit, extraHitIndices };
}

function ordinaryLinearFit(points: { beat: number; time: number }[]): { a: number; b: number } | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.beat;
    sy += p.time;
    sxx += p.beat * p.beat;
    sxy += p.beat * p.time;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

const LOCAL_FIT_SIGMA = 2;

function weightedLinearFit(points: { beat: number; time: number }[], centerBeat: number): { a: number; b: number } | null {
  if (points.length < 2) return null;
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (const p of points) {
    const d = p.beat - centerBeat;
    const w = Math.exp(-(d * d) / (2 * LOCAL_FIT_SIGMA * LOCAL_FIT_SIGMA));
    sw += w;
    swx += w * p.beat;
    swy += w * p.time;
    swxx += w * p.beat * p.beat;
    swxy += w * p.beat * p.time;
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-9 || sw < 1e-9) return null;
  const b = (sw * swxy - swx * swy) / denom;
  const a = (swy - b * swx) / sw;
  return { a, b };
}

const LOCAL_FIT_WINDOW_QUARTERS = 4;
const LOCAL_FIT_WIDE_WINDOW_QUARTERS = 12;

/**
 * The relative error for one onset: hit time minus the time predicted by a
 * weighted-least-squares line fitted through neighbouring matched onsets
 * (Gaussian-weighted by distance, excluding the onset itself). Falls back
 * to a wider window, then to the nominal grid, when too few neighbours exist.
 */
function localRelativeErrorMs(matchedPoints: MatchedPoint[], onsetIndex: number, beat: number, hitTime: number, startTime: number, nominal: number): number {
  const neighboursWithin = (window: number) => matchedPoints.filter((p) => p.onsetIndex !== onsetIndex && Math.abs(p.beat - beat) <= window);

  let neighbours = neighboursWithin(LOCAL_FIT_WINDOW_QUARTERS);
  if (neighbours.length < 2) neighbours = neighboursWithin(LOCAL_FIT_WIDE_WINDOW_QUARTERS);

  const fit = neighbours.length >= 2 ? weightedLinearFit(neighbours, beat) : null;
  const predicted = fit ? fit.a + fit.b * beat : startTime + beat * nominal;
  return (hitTime - predicted) * 1000;
}

const GRADE_SCORE: Record<Grade, number> = { perfect: 1, good: 0.8, ok: 0.5, miss: 0 };
const EXTRA_HIT_PENALTY = 3;

function computeAccuracy(judgements: OnsetJudgement[], extraHitCount: number): number {
  if (judgements.length === 0) return 0;
  const meanScore = judgements.reduce((sum, j) => sum + GRADE_SCORE[j.grade], 0) / judgements.length;
  return Math.max(0, meanScore * 100 - extraHitCount * EXTRA_HIT_PENALTY);
}

function computePlayedBpm(matchedPoints: MatchedPoint[], bpm: number): number {
  const fit = ordinaryLinearFit(matchedPoints);
  if (!fit || fit.b <= 0) return bpm;
  return 60 / fit.b;
}

/**
 * Tempo of a global fit over the run's last "bar" vs its first "bar". Onsets
 * don't carry bar boundaries here, so a bar is approximated as one quarter
 * of the total played beat span (matching this project's 4-bar levels).
 * Positive means the last segment was faster (rushed).
 */
function computeDriftPercent(onsets: Onset[], matchedPoints: MatchedPoint[]): number {
  if (matchedPoints.length < 4 || onsets.length === 0) return 0;
  const beats = onsets.map((o) => o.beat);
  const minBeat = Math.min(...beats);
  const maxBeat = Math.max(...beats);
  const span = maxBeat - minBeat;
  if (span <= 0) return 0;
  const segment = span / 4;

  const firstFit = ordinaryLinearFit(matchedPoints.filter((p) => p.beat <= minBeat + segment));
  const lastFit = ordinaryLinearFit(matchedPoints.filter((p) => p.beat >= maxBeat - segment));
  if (!firstFit || !lastFit || firstFit.b <= 0 || lastFit.b <= 0) return 0;

  const firstBpm = 60 / firstFit.b;
  const lastBpm = 60 / lastFit.b;
  return ((lastBpm - firstBpm) / firstBpm) * 100;
}

/**
 * Steadiness scaling (documented, not derived): penalizes the run's average
 * tempo deviation from nominal, and the local tempo variance between
 * consecutive matched onsets. Tuned so perfectly steady play scores ~100,
 * a uniform 5% tempo deviation scores ~75, and 15% scores ~30.
 */
const DEVIATION_PENALTY_PER_PERCENT = 4.5;
const LOCAL_VARIANCE_PENALTY_PER_PERCENT = 3;

function computeSteadiness(matchedPoints: MatchedPoint[], bpm: number, playedBpm: number): number {
  const nominal = nominalSecPerQuarter(bpm);
  const deviationPercent = (Math.abs(playedBpm - bpm) / bpm) * 100;

  const sorted = [...matchedPoints].sort((a, b) => a.beat - b.beat);
  const ratios: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const dBeat = cur.beat - prev.beat;
    if (dBeat <= 0) continue;
    ratios.push((cur.time - prev.time) / dBeat / nominal);
  }

  let localVariancePercent = 0;
  if (ratios.length > 1) {
    const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;
    localVariancePercent = Math.sqrt(variance) * 100;
  }

  const raw = 100 - DEVIATION_PENALTY_PER_PERCENT * deviationPercent - LOCAL_VARIANCE_PENALTY_PER_PERCENT * localVariancePercent;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Offline judgement of a full run: one-to-one matches hits to onsets in
 * time order (via the same online pulse tracking as the live judge), then
 * grades each match by its error relative to a locally-fitted pulse.
 */
export function judgeRun(onsets: Onset[], startTime: number, bpm: number, hits: Hit[]): RunResult {
  const nominal = nominalSecPerQuarter(bpm);
  const { onsetToHit, extraHitIndices } = matchHitsToOnsets(onsets, hits, startTime, bpm);

  const matchedPoints: MatchedPoint[] = [];
  for (const [onsetIndex, hitIndex] of onsetToHit) {
    const onset = onsets[onsetIndex];
    const hit = hits[hitIndex];
    if (!onset || !hit) continue;
    matchedPoints.push({ onsetIndex, beat: onset.beat, time: hit.time });
  }

  const judgements: OnsetJudgement[] = onsets.map((onset, index) => {
    const hitIndex = onsetToHit.get(index);
    const hit = hitIndex === undefined ? undefined : hits[hitIndex];
    if (!hit) {
      return { onset, hitTime: null, strictErrorMs: null, relativeErrorMs: null, grade: "miss" };
    }

    const nominalTime = startTime + onset.beat * nominal;
    const strictErrorMs = (hit.time - nominalTime) * 1000;
    const relativeErrorMs = localRelativeErrorMs(matchedPoints, index, onset.beat, hit.time, startTime, nominal);
    return { onset, hitTime: hit.time, strictErrorMs, relativeErrorMs, grade: gradeFor(Math.abs(relativeErrorMs)) };
  });

  const extraHits = extraHitIndices.map((i) => hits[i]).filter((h): h is Hit => h !== undefined);
  const accuracy = computeAccuracy(judgements, extraHits.length);
  const playedBpm = computePlayedBpm(matchedPoints, bpm);
  const driftPercent = computeDriftPercent(onsets, matchedPoints);
  const steadiness = computeSteadiness(matchedPoints, bpm, playedBpm);

  return { judgements, extraHits, accuracy, steadiness, playedBpm, driftPercent };
}

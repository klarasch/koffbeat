// Judges player taps and releases against a Level's onsets and rests, live (during play) and
// offline (after a run), both judged against the player's own drifting pulse rather than a
// fixed metronome grid — see doc comments below for the reasoning behind each constant.

import type { Grade, Hit, Onset, Release, RestSpan, RunResult } from "../types";

/** Grade windows, as the absolute relative error in ms. Loosened for phone play: a touchscreen
 * tap has more inherent jitter than a drum pad, and these still comfortably separate "good
 * musician, phone latency" from an actually wrong tap. */
export const PERFECT_MS = 50;
export const GOOD_MS = 90;
export const OK_MS = 140;

/**
 * Matching is decoupled from grading: a press can MATCH an onset far outside the grading
 * windows above (so a genuinely late/early tap still shows as "late"/"early" rather than
 * vanishing as an unrelated extra hit) — tightened per-onset in `matchWindowMs` so a hit near
 * two close onsets can't steal the neighbour's match.
 */
export const MATCH_WINDOW_MS = 400;
const NEIGHBOUR_WINDOW_FRACTION = 0.45;

/** Online pulse tracking: how much each matched hit nudges the tempo estimate. */
const PULSE_SMOOTHING = 0.2;
/** Online pulse tracking: estimate is clamped to nominal tempo ± this fraction. */
const PULSE_CLAMP_FRACTION = 0.15;

/**
 * Release/hold grading. A note's target release is its predicted end (onset + quarters). The
 * acceptable window is asymmetric: releasing early is only forgiven down to the larger of a
 * fixed floor and a fraction of the note's own duration (a quarter note has little slack to
 * release early; a whole note has a lot), while releasing late is forgiven by a small fixed
 * amount (the next note's own onset window covers legitimately late releases). Outside the
 * window by less than RELEASE_OK_EXTRA_MS is "ok"; beyond that, "miss".
 *
 * Only SUSTAINED notes (longer than a quarter — halves, dotted halves, wholes, dotted quarters,
 * tied chains) are hold-graded at all: a quarter note or shorter is "played" the instant it's
 * tapped, and a normal short tap on it must not read as a release miss.
 */
export const RELEASE_EARLY_MIN_MS = 150;
export const RELEASE_EARLY_FRACTION = 0.3;
export const RELEASE_LATE_MS = 120;
export const RELEASE_OK_EXTRA_MS = 150;
/** Notes at or below this length (in quarters) get no release/hold grade at all. */
export const SUSTAINED_MIN_QUARTERS = 1;
/** A rest is spoiled when the previous note is still held this many ms into it. */
export const REST_HELD_THROUGH_MS = 150;

function nominalSecPerQuarter(bpm: number): number {
  return 60 / bpm;
}

function gradeFor(absErrorMs: number): Grade {
  if (absErrorMs <= PERFECT_MS) return "perfect";
  if (absErrorMs <= GOOD_MS) return "good";
  if (absErrorMs <= OK_MS) return "ok";
  return "miss";
}

const GRADE_RANK: Record<Grade, number> = { perfect: 0, good: 1, ok: 2, miss: 3 };

/** The worse (lower-quality) of two grades; `null` is treated as neutral (returns the other). */
export function combineGrades(a: Grade, b: Grade | null): Grade {
  if (b === null) return a;
  return GRADE_RANK[a] >= GRADE_RANK[b] ? a : b;
}

/**
 * The match window for a given onset: the base window, tightened to 0.45x the gap (in ms, at
 * the current tempo estimate) to its nearest neighbour, whichever is smaller.
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
 * Tracks the player's pulse online as (anchor beat, anchor time, seconds per quarter). After
 * each matched hit the anchor snaps to that hit and the tempo estimate is smoothed towards the
 * instantaneous tempo since the last anchor, clamped to ±`PULSE_CLAMP_FRACTION` of nominal.
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

export interface LiveReleaseJudgement {
  /** The onset this release closes, or null if it didn't close anything currently held. */
  onsetIndex: number | null;
  releaseErrorMs: number | null;
  releaseGrade: Grade | null;
  /** The combined (worse-of onset, release) grade to paint on the staff, or null. */
  combinedGrade: Grade | null;
}

export interface LiveJudge {
  judgeHit(hit: Hit): LiveHitJudgement;
  /** Explicit release (pointerup/keyup) in `zone`. */
  judgeRelease(release: Release): LiveReleaseJudgement;
  /**
   * A new press in `zone` at `time` implicitly releases whatever that zone was still holding
   * (the player pressed again before releasing) — call before processing the new press.
   */
  implicitRelease(zone: 0 | 1, time: number): LiveReleaseJudgement;
}

function durationMsFor(onset: Onset, secPerQuarter: number): number {
  return onset.quarters * secPerQuarter * 1000;
}

function gradeRelease(releaseTime: number, predictedEnd: number, durationMs: number): { errorMs: number; grade: Grade } {
  const errorMs = (releaseTime - predictedEnd) * 1000;
  const earlyWindowMs = Math.max(RELEASE_EARLY_MIN_MS, RELEASE_EARLY_FRACTION * durationMs);
  let overshootMs = 0;
  if (errorMs < -earlyWindowMs) overshootMs = -earlyWindowMs - errorMs;
  else if (errorMs > RELEASE_LATE_MS) overshootMs = errorMs - RELEASE_LATE_MS;
  const grade: Grade = overshootMs <= 0 ? "perfect" : overshootMs < RELEASE_OK_EXTRA_MS ? "ok" : "miss";
  return { errorMs, grade };
}

/**
 * Live, incremental judge for feedback during play. `startTime` is the audio-clock time of
 * beat 0 (the end of the count-in). Each onset can be matched by at most one hit; the pulse
 * estimate is updated after every match so a slowly-drifting player is still judged against
 * their own tempo. Holds are tracked per zone: at most one onset is "held" per zone at a time.
 */
export function createLiveJudge(onsets: Onset[], startTime: number, bpm: number): LiveJudge {
  const nominal = nominalSecPerQuarter(bpm);
  const estimator = new PulseEstimator(startTime, nominal);
  const matchedOnsets = new Set<number>();
  const heldByZone = new Map<0 | 1, number>();
  const onsetGradeByIndex = new Map<number, Grade>();

  function releaseHeld(zone: 0 | 1, time: number): LiveReleaseJudgement {
    const onsetIndex = heldByZone.get(zone);
    if (onsetIndex === undefined) return { onsetIndex: null, releaseErrorMs: null, releaseGrade: null, combinedGrade: null };
    heldByZone.delete(zone);
    const onset = onsets[onsetIndex];
    if (!onset) return { onsetIndex: null, releaseErrorMs: null, releaseGrade: null, combinedGrade: null };

    const onsetGrade = onsetGradeByIndex.get(onsetIndex) ?? "miss";
    if (onset.quarters <= SUSTAINED_MIN_QUARTERS) {
      // A quarter note or shorter isn't hold-graded: a normal short tap is simply correct.
      return { onsetIndex, releaseErrorMs: null, releaseGrade: null, combinedGrade: onsetGrade };
    }

    const predictedEnd = estimator.predict(onset.beat + onset.quarters);
    const durationMs = durationMsFor(onset, estimator.currentSecPerQuarter());
    const { errorMs, grade } = gradeRelease(time, predictedEnd, durationMs);
    return { onsetIndex, releaseErrorMs: errorMs, releaseGrade: grade, combinedGrade: combineGrades(onsetGrade, grade) };
  }

  return {
    judgeHit(hit: Hit): LiveHitJudgement {
      const match = findBestMatch(onsets, matchedOnsets, estimator, hit.time);
      if (!match) return { onsetIndex: null, errorMs: null, grade: null };

      matchedOnsets.add(match.index);
      const onset = onsets[match.index];
      if (onset) estimator.update(onset.beat, hit.time);

      const grade = gradeFor(Math.abs(match.errorMs));
      onsetGradeByIndex.set(match.index, grade);
      heldByZone.set(hit.zone, match.index);

      return { onsetIndex: match.index, errorMs: match.errorMs, grade };
    },
    judgeRelease(release: Release): LiveReleaseJudgement {
      return releaseHeld(release.zone, release.time);
    },
    implicitRelease(zone: 0 | 1, time: number): LiveReleaseJudgement {
      return releaseHeld(zone, time);
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
 * Predicted time at any beat: a weighted-least-squares line fitted through neighbouring matched
 * onsets (Gaussian-weighted by distance), optionally excluding one onset (for a leave-one-out
 * estimate of its own error). Falls back to a wider window, then to the nominal grid.
 */
function predictTimeAt(matchedPoints: MatchedPoint[], beat: number, excludeOnsetIndex: number | null, startTime: number, nominal: number): number {
  const neighboursWithin = (window: number) => matchedPoints.filter((p) => p.onsetIndex !== excludeOnsetIndex && Math.abs(p.beat - beat) <= window);

  let neighbours = neighboursWithin(LOCAL_FIT_WINDOW_QUARTERS);
  if (neighbours.length < 2) neighbours = neighboursWithin(LOCAL_FIT_WIDE_WINDOW_QUARTERS);

  const fit = neighbours.length >= 2 ? weightedLinearFit(neighbours, beat) : null;
  return fit ? fit.a + fit.b * beat : startTime + beat * nominal;
}

function localRelativeErrorMs(matchedPoints: MatchedPoint[], onsetIndex: number, beat: number, hitTime: number, startTime: number, nominal: number): number {
  const predicted = predictTimeAt(matchedPoints, beat, onsetIndex, startTime, nominal);
  return (hitTime - predicted) * 1000;
}

const GRADE_SCORE: Record<Grade, number> = { perfect: 1, good: 0.8, ok: 0.5, miss: 0 };
const EXTRA_HIT_PENALTY = 3;
/** Weight of onset (attack) timing vs hold/rest correctness in the blended accuracy score. */
const ONSET_WEIGHT = 0.7;
const HOLD_REST_WEIGHT = 0.3;

function computeOnsetScore(judgements: { grade: Grade }[]): number {
  if (judgements.length === 0) return 0;
  return (judgements.reduce((sum, j) => sum + GRADE_SCORE[j.grade], 0) / judgements.length) * 100;
}

/** Mean grade score over every release and rest that had something to judge; nothing to judge → 100 (no penalty). */
function computeHoldRestScore(judgements: { releaseGrade: Grade | null }[], restJudgements: { grade: Grade }[]): number {
  const scores: number[] = [];
  for (const j of judgements) if (j.releaseGrade !== null) scores.push(GRADE_SCORE[j.releaseGrade]);
  for (const r of restJudgements) scores.push(GRADE_SCORE[r.grade]);
  if (scores.length === 0) return 100;
  return (scores.reduce((sum, s) => sum + s, 0) / scores.length) * 100;
}

/**
 * Rhythm accuracy = 70% onset (attack) timing score + 30% hold/rest correctness score, both on
 * the player's own pulse, minus a flat penalty per extra (unmatched) hit.
 */
function computeAccuracy(onsetScore: number, holdRestScore: number, extraHitCount: number): number {
  const raw = ONSET_WEIGHT * onsetScore + HOLD_REST_WEIGHT * holdRestScore;
  return Math.max(0, raw - extraHitCount * EXTRA_HIT_PENALTY);
}

function computePlayedBpm(matchedPoints: MatchedPoint[], bpm: number): number {
  const fit = ordinaryLinearFit(matchedPoints);
  if (!fit || fit.b <= 0) return bpm;
  return 60 / fit.b;
}

/**
 * Tempo of a global fit over the run's last "bar" vs its first "bar". Onsets don't carry bar
 * boundaries here, so a bar is approximated as one quarter of the total played beat span
 * (matching this project's 4-bar levels). Positive means the last segment was faster (rushed).
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
 * Steadiness scaling (documented, not derived): penalizes the run's average tempo deviation
 * from nominal, and the local tempo variance between consecutive matched onsets. Tuned so
 * perfectly steady play scores ~100, a uniform 5% tempo deviation scores ~75, and 15% scores ~30.
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
 * For every matched onset, the release time: an explicit release (pointerup/keyup) in the same
 * zone, if one lands before the next press (any zone); otherwise the next press's time, since a
 * held key/finger with no release event is implicitly let go the moment the next note is
 * pressed. Onsets with neither (typically the very last note, if never explicitly released) are
 * left unresolved (no entry).
 */
function computeReleaseTimes(onsets: Onset[], onsetToHit: Map<number, number>, hits: Hit[], releases: Release[]): Map<number, number> {
  const matches = [...onsetToHit.entries()]
    .map(([onsetIndex, hitIndex]) => {
      const onset = onsets[onsetIndex];
      const hit = hits[hitIndex];
      return onset && hit ? { onsetIndex, time: hit.time, zone: hit.zone } : null;
    })
    .filter((m): m is { onsetIndex: number; time: number; zone: 0 | 1 } => m !== null)
    .sort((a, b) => a.time - b.time);

  const releasesByZone: Record<0 | 1, Release[]> = {
    0: releases.filter((r) => r.zone === 0).sort((a, b) => a.time - b.time),
    1: releases.filter((r) => r.zone === 1).sort((a, b) => a.time - b.time),
  };
  const zoneReleaseIdx: Record<0 | 1, number> = { 0: 0, 1: 0 };

  const result = new Map<number, number>();

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match) continue;
    const nextPressTime = matches[i + 1]?.time ?? Number.POSITIVE_INFINITY;

    const zoneReleases = releasesByZone[match.zone];
    let idx = zoneReleaseIdx[match.zone];
    while (idx < zoneReleases.length && (zoneReleases[idx]?.time ?? Number.POSITIVE_INFINITY) < match.time) idx++;

    let releaseTime: number | undefined;
    const candidate = zoneReleases[idx];
    if (candidate && candidate.time <= nextPressTime) {
      releaseTime = candidate.time;
      idx++;
    }
    zoneReleaseIdx[match.zone] = idx;

    if (releaseTime === undefined && Number.isFinite(nextPressTime)) releaseTime = nextPressTime;
    if (releaseTime !== undefined) result.set(match.onsetIndex, releaseTime);
  }

  return result;
}

/**
 * A rest is a miss only when (a) a press lands inside it (outside the next onset's own
 * early-tap allowance) or (b) the previous note is still held more than REST_HELD_THROUGH_MS
 * into it — releasing a short note early before a rest is fine, and doesn't need to be exact.
 */
function judgeRests(
  restSpansList: RestSpan[],
  onsets: Onset[],
  releaseTimes: Map<number, number>,
  hits: Hit[],
  matchedPoints: MatchedPoint[],
  startTime: number,
  nominal: number,
): { eventIndex: number; grade: Grade; reason: string | null }[] {
  return restSpansList.map((rest) => {
    // The onset immediately preceding this rest (by eventIndex order, the closest onset whose
    // eventIndex is less than the rest's).
    let prevOnsetIndex = -1;
    onsets.forEach((o, i) => {
      if (o.eventIndex < rest.eventIndex && (prevOnsetIndex === -1 || o.eventIndex > (onsets[prevOnsetIndex]?.eventIndex ?? -1))) prevOnsetIndex = i;
    });

    const restStart = predictTimeAt(matchedPoints, rest.beat, null, startTime, nominal);
    const restEnd = predictTimeAt(matchedPoints, rest.beat + rest.quarters, null, startTime, nominal);

    // The next onset after the rest, whose own early-tap allowance overlaps the rest's tail.
    const nextOnset = onsets.find((o) => o.beat >= rest.beat + rest.quarters);
    const nextOnsetIndex = nextOnset ? onsets.indexOf(nextOnset) : -1;
    const nextWindowMs = nextOnsetIndex === -1 ? 0 : matchWindowMs(onsets, nextOnsetIndex, nominal);
    const excludeAfter = nextOnset ? predictTimeAt(matchedPoints, nextOnset.beat, null, startTime, nominal) - nextWindowMs / 1000 : Number.POSITIVE_INFINITY;

    const pressedDuringRest = hits.some((h) => h.time >= restStart && h.time < Math.min(restEnd, excludeAfter));
    if (pressedDuringRest) return { eventIndex: rest.eventIndex, grade: "miss" as Grade, reason: "you tapped during it" };

    const prevReleaseTime = prevOnsetIndex === -1 ? undefined : releaseTimes.get(prevOnsetIndex);
    const heldThroughRest = prevReleaseTime !== undefined && prevReleaseTime > restStart + REST_HELD_THROUGH_MS / 1000;
    if (heldThroughRest) return { eventIndex: rest.eventIndex, grade: "miss" as Grade, reason: "held through it" };

    return { eventIndex: rest.eventIndex, grade: "perfect" as Grade, reason: null };
  });
}

/**
 * Offline judgement of a full run: one-to-one matches presses to onsets in time order (via the
 * same online pulse tracking as the live judge), grades each match by its error relative to a
 * locally-fitted pulse, resolves each note's release, and grades rests.
 */
export function judgeRun(onsets: Onset[], restSpansList: RestSpan[], startTime: number, bpm: number, hits: Hit[], releases: Release[]): RunResult {
  const nominal = nominalSecPerQuarter(bpm);
  const { onsetToHit, extraHitIndices } = matchHitsToOnsets(onsets, hits, startTime, bpm);

  const matchedPoints: MatchedPoint[] = [];
  for (const [onsetIndex, hitIndex] of onsetToHit) {
    const onset = onsets[onsetIndex];
    const hit = hits[hitIndex];
    if (!onset || !hit) continue;
    matchedPoints.push({ onsetIndex, beat: onset.beat, time: hit.time });
  }

  const releaseTimes = computeReleaseTimes(onsets, onsetToHit, hits, releases);

  const judgements = onsets.map((onset, index) => {
    const hitIndex = onsetToHit.get(index);
    const hit = hitIndex === undefined ? undefined : hits[hitIndex];
    if (!hit) {
      return {
        onset,
        hitTime: null,
        strictErrorMs: null,
        relativeErrorMs: null,
        grade: "miss" as Grade,
        releaseTime: null,
        releaseErrorMs: null,
        releaseGrade: null,
      };
    }

    const nominalTime = startTime + onset.beat * nominal;
    const strictErrorMs = (hit.time - nominalTime) * 1000;
    const relativeErrorMs = localRelativeErrorMs(matchedPoints, index, onset.beat, hit.time, startTime, nominal);
    const grade = gradeFor(Math.abs(relativeErrorMs));

    const releaseTime = releaseTimes.get(index) ?? null;
    let releaseErrorMs: number | null = null;
    let releaseGrade: Grade | null = null;
    // Only sustained notes (longer than a quarter) are hold-graded: a quarter or shorter is
    // "played" the instant it's tapped, and a normal short tap on it is simply correct.
    if (releaseTime !== null && onset.quarters > SUSTAINED_MIN_QUARTERS) {
      const predictedEnd = predictTimeAt(matchedPoints, onset.beat + onset.quarters, null, startTime, nominal);
      const durationMs = onset.quarters * nominal * 1000;
      const result = gradeRelease(releaseTime, predictedEnd, durationMs);
      releaseErrorMs = result.errorMs;
      releaseGrade = result.grade;
    }

    return { onset, hitTime: hit.time, strictErrorMs, relativeErrorMs, grade, releaseTime, releaseErrorMs, releaseGrade };
  });

  const restJudgements = judgeRests(restSpansList, onsets, releaseTimes, hits, matchedPoints, startTime, nominal);

  const extraHits = extraHitIndices.map((i) => hits[i]).filter((h): h is Hit => h !== undefined);
  const onsetScore = computeOnsetScore(judgements);
  const holdRestScore = computeHoldRestScore(judgements, restJudgements);
  const accuracy = computeAccuracy(onsetScore, holdRestScore, extraHits.length);
  const playedBpm = computePlayedBpm(matchedPoints, bpm);
  const driftPercent = computeDriftPercent(onsets, matchedPoints);
  const steadiness = computeSteadiness(matchedPoints, bpm, playedBpm);

  return { judgements, extraHits, restJudgements, accuracy, steadiness, playedBpm, driftPercent };
}

// Judges player taps and releases against a Level's onsets and rests, live (during play) and
// offline (after a run), both judged against the player's own drifting pulse rather than a
// fixed metronome grid — see doc comments below for the reasoning behind each constant.

import type { Grade, Hand, Hit, Onset, Release, RestSpan, RunResult } from "../types";

/** Base grade windows, as the absolute relative error in ms, for notes that follow closely on
 * the previous one (an interval of `WINDOW_REFERENCE_GAP_MS` or less). Human timing spread grows
 * with the interval being timed (roughly Weber's law), so after a longer gap the windows widen
 * with the square root of the gap — see `gradeWindows`. */
export const PERFECT_MS = 55;
export const GOOD_MS = 95;
export const OK_MS = 150;
const WINDOW_REFERENCE_GAP_MS = 600;
/** The windows never widen beyond this multiple of the base, however long the gap. */
const WINDOW_MAX_SCALE = 1.8;

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
/**
 * Online pulse tracking: how far the phase follows each matched hit. Snapping fully (1.0) would
 * judge every note against the previous tap alone, adding that tap's own jitter to this one's;
 * partial correction keeps following a drifting player while averaging the jitter out.
 */
const PHASE_CORRECTION = 0.5;
/**
 * Grid mode (practice, with the metronome running): the tempo is the click's and never follows
 * the player. Only a small constant offset is learned (for leftover latency-calibration error),
 * slowly and within ±GRID_OFFSET_MAX_SEC, so drifting off the click always shows.
 */
const GRID_OFFSET_RATE = 0.1;
const GRID_OFFSET_MAX_SEC = 0.06;
/** Online pulse tracking: the tempo is only re-estimated from notes at least this far apart (quarters). */
const MIN_TEMPO_STEP_QUARTERS = 0.1;
/** Online pulse tracking: estimate is clamped to nominal tempo ± this fraction. */
const PULSE_CLAMP_FRACTION = 0.15;
/** Next-note scoring: how far the player's tempo may wander from the target. */
const SEQUENTIAL_CLAMP_FRACTION = 0.35;
/** Next-note scoring: a tap sooner than this fraction of the expected gap is an extra tap. */
const EXTRA_TAP_FRACTION = 0.45;

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
export const RELEASE_EARLY_MIN_MS = 180;
export const RELEASE_EARLY_FRACTION = 0.3;
export const RELEASE_LATE_MIN_MS = 180;
export const RELEASE_LATE_FRACTION = 0.15;
export const RELEASE_OK_EXTRA_MS = 200;
/** Notes at or below this length (in quarters) get no release/hold grade at all. */
export const SUSTAINED_MIN_QUARTERS = 1;
/** A rest is spoiled when the previous note is still held this many ms into it (or this
 * fraction of the rest's length, whichever is larger). */
export const REST_HELD_THROUGH_MS = 150;
const REST_HELD_THROUGH_FRACTION = 0.3;

function nominalSecPerQuarter(bpm: number): number {
  return 60 / bpm;
}

/**
 * Two-hand levels: each hand reads its own line, so "the previous note" and "the next note" of an
 * onset are the neighbours on the same line, never the other hand's. For a one-line level they
 * are simply the onsets either side. Cached per onset list.
 */
interface LineLinks {
  twoLines: boolean;
  prev: number[];
  next: number[];
}
const linkCache = new WeakMap<Onset[], LineLinks>();

function lineOf(onset: { line?: Hand } | undefined): Hand {
  return onset?.line ?? 0;
}

function links(onsets: Onset[]): LineLinks {
  const cached = linkCache.get(onsets);
  if (cached) return cached;
  const twoLines = onsets.some((o) => o.line !== undefined);
  const prev: number[] = onsets.map(() => -1);
  const next: number[] = onsets.map(() => -1);
  const last: Record<Hand, number> = { 0: -1, 1: -1 };
  onsets.forEach((onset, i) => {
    const line = lineOf(onset);
    const before = last[line];
    if (before !== -1) {
      prev[i] = before;
      next[before] = i;
    }
    last[line] = i;
  });
  const result = { twoLines, prev, next };
  linkCache.set(onsets, result);
  return result;
}

/** Whether a press in `zone` may play `onset`: on a two-hand level, only its own hand's. */
function zoneMayPlay(onsets: Onset[], onset: Onset | undefined, zone: Hand): boolean {
  return !links(onsets).twoLines || lineOf(onset) === zone;
}

/** Gap from onset `index` back to the previous onset (on its own line), in quarters (a quarter for the first). */
function gapQuartersBefore(onsets: Onset[], index: number): number {
  const onset = onsets[index];
  const prev = onsets[links(onsets).prev[index] ?? -1];
  if (!onset || !prev) return 1;
  return Math.max(0.25, onset.beat - prev.beat);
}

/** Grade windows for a note that comes `gapMs` after the previous one. */
export function gradeWindows(gapMs: number): { perfect: number; good: number; ok: number } {
  const scale = Math.min(WINDOW_MAX_SCALE, Math.max(1, Math.sqrt(gapMs / WINDOW_REFERENCE_GAP_MS)));
  return { perfect: PERFECT_MS * scale, good: GOOD_MS * scale, ok: OK_MS * scale };
}

function gradeFor(absErrorMs: number, gapMs: number): Grade {
  const w = gradeWindows(gapMs);
  if (absErrorMs <= w.perfect) return "perfect";
  if (absErrorMs <= w.good) return "good";
  if (absErrorMs <= w.ok) return "ok";
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
  const { prev: prevLinks, next: nextLinks } = links(onsets);
  const prev = onsets[prevLinks[index] ?? -1];
  const next = onsets[nextLinks[index] ?? -1];
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
  /** False until the first matched hit: that one sets the phase outright (it carries any
   * leftover latency-calibration error, which shouldn't leak into the following notes). */
  private hasHit = false;
  private readonly startTime: number;
  private readonly grid: boolean;
  private gridOffset = 0;

  /** Next-note scoring: the pulse is anchored fully on each tap (what's graded is the rhythm
   * between taps), and the tempo may wander further (drift is reported, not graded). */
  private readonly sequential: boolean;

  constructor(startTime: number, nominal: number, grid = false, sequential = false) {
    this.startTime = startTime;
    this.grid = grid;
    this.sequential = sequential && !grid;
    this.anchorTime = startTime;
    this.secPerQuarter = nominal;
    const clamp = this.sequential ? SEQUENTIAL_CLAMP_FRACTION : PULSE_CLAMP_FRACTION;
    this.min = nominal * (1 - clamp);
    this.max = nominal * (1 + clamp);
  }

  predict(beat: number): number {
    if (this.grid) return this.startTime + beat * this.secPerQuarter + this.gridOffset;
    return this.anchorTime + (beat - this.anchorBeat) * this.secPerQuarter;
  }

  currentSecPerQuarter(): number {
    return this.secPerQuarter;
  }

  /** Re-anchor the pulse on `beat` at `time` (the player came back in on a shifted beat); the
   * tempo estimate is kept. */
  resync(beat: number, time: number): void {
    this.anchorBeat = beat;
    this.anchorTime = time;
    this.hasHit = true;
  }

  /** Inverse of predict: where in the music (in beats) a given time falls on this pulse. */
  beatAt(time: number): number {
    if (this.grid) return (time - this.startTime - this.gridOffset) / this.secPerQuarter;
    return this.anchorBeat + (time - this.anchorTime) / this.secPerQuarter;
  }

  update(beat: number, time: number): void {
    if (this.grid) {
      const error = time - (this.startTime + beat * this.secPerQuarter);
      const next = this.gridOffset + GRID_OFFSET_RATE * (error - this.gridOffset);
      this.gridOffset = Math.max(-GRID_OFFSET_MAX_SEC, Math.min(GRID_OFFSET_MAX_SEC, next));
      return;
    }
    const predicted = this.predict(beat);
    const corrected = this.hasHit && !this.sequential ? predicted + PHASE_CORRECTION * (time - predicted) : time;
    this.hasHit = true;
    // Tempo only from notes a real distance apart: two hands landing on the same beat (or a
    // hair apart in floating point) say nothing about the tempo, only about the phase.
    if (beat - this.anchorBeat >= MIN_TEMPO_STEP_QUARTERS) {
      const instantaneous = (time - this.anchorTime) / (beat - this.anchorBeat);
      const blended = this.secPerQuarter + PULSE_SMOOTHING * (instantaneous - this.secPerQuarter);
      this.secPerQuarter = Math.min(this.max, Math.max(this.min, blended));
    }
    this.anchorBeat = beat;
    this.anchorTime = corrected;
  }
}

interface MatchResult {
  index: number;
  errorMs: number;
}

/** Nearest unmatched onset to `hitTime` that this zone may play, within its match window, or null. */
function findBestMatch(onsets: Onset[], matchedOnsets: ReadonlySet<number>, estimator: PulseEstimator, hitTime: number, zone: Hand): MatchResult | null {
  let bestIndex = -1;
  let bestErrorMs = 0;
  let bestAbsErrorMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < onsets.length; i++) {
    if (matchedOnsets.has(i)) continue;
    const onset = onsets[i];
    if (!onset || !zoneMayPlay(onsets, onset, zone)) continue;
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
  /** Count-in only: this tap was the player coming back in on a shifted beat, and the pulse was
   * re-anchored on it. */
  resynced?: boolean;
  /** Next-note scoring: notes this tap skipped over (the gap fitted the note after), now missed. */
  skipped?: number[];
}

/** Count-in re-entry: two stray taps whose offsets from the notes agree within this many seconds
 * mean the player is back, just on a shifted beat. */
const RESYNC_AGREEMENT_SEC = 0.08;
/** …and the two taps must come within this many beats of each other. */
const RESYNC_SPAN_BEATS = 3;

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
  /** Predicted audio time of `beat` on the player's current pulse (e.g. a held note's end). */
  predictTime(beat: number): number;
  /** The player's current pulse, in seconds per quarter note. */
  secPerQuarter(): number;
  /** Where in the music (beats) `time` falls on the current pulse: the clock that keeps going
   * at the player's own tempo even while they are silent. */
  beatAt(time: number): number;
  /** The note's moment has passed unplayed: stop expecting it, so a later tap attempts the
   * notes that follow instead. */
  markMissed(onsetIndex: number): void;
}

function durationMsFor(onset: Onset, secPerQuarter: number): number {
  return onset.quarters * secPerQuarter * 1000;
}

/** The release window around a sustained note's end, in ms: how early and how late still counts as clean. */
export function releaseWindowMs(durationMs: number): { early: number; late: number } {
  return {
    early: Math.max(RELEASE_EARLY_MIN_MS, RELEASE_EARLY_FRACTION * durationMs),
    late: Math.max(RELEASE_LATE_MIN_MS, RELEASE_LATE_FRACTION * durationMs),
  };
}

function gradeRelease(releaseTime: number, predictedEnd: number, durationMs: number): { errorMs: number; grade: Grade } {
  const errorMs = (releaseTime - predictedEnd) * 1000;
  const earlyWindowMs = Math.max(RELEASE_EARLY_MIN_MS, RELEASE_EARLY_FRACTION * durationMs);
  const lateWindowMs = Math.max(RELEASE_LATE_MIN_MS, RELEASE_LATE_FRACTION * durationMs);
  let overshootMs = 0;
  if (errorMs < -earlyWindowMs) overshootMs = -earlyWindowMs - errorMs;
  else if (errorMs > lateWindowMs) overshootMs = errorMs - lateWindowMs;
  const grade: Grade = overshootMs <= 0 ? "perfect" : overshootMs < RELEASE_OK_EXTRA_MS ? "ok" : "miss";
  return { errorMs, grade };
}

/**
 * Live, incremental judge for feedback during play. `startTime` is the audio-clock time of
 * beat 0 (the end of the count-in). Each onset can be matched by at most one hit; the pulse
 * estimate is updated after every match so a slowly-drifting player is still judged against
 * their own tempo. Holds are tracked per zone: at most one onset is "held" per zone at a time.
 */
export interface JudgeOptions {
  /** Judge against the fixed metronome grid instead of the player's own pulse (practice mode). */
  grid?: boolean;
  /** The live judge's own pairing of onsets to hits (onset index → hit index). When given, the
   * offline judgement grades exactly the attempts the player saw graded during play. */
  matches?: Map<number, number>;
  /**
   * Count-in only, "next note" scoring: each tap is the next note of its hand, graded by the
   * time since the previous tap at the player's own tempo. Silence doesn't move the music on.
   * Two exceptions keep one stumble from shifting everything after it: a tap much too soon is an
   * extra tap, and a gap that clearly fits the note after next counts the note between as missed.
   */
  sequential?: boolean;
}

export function createLiveJudge(onsets: Onset[], startTime: number, bpm: number, options: JudgeOptions = {}): LiveJudge {
  const nominal = nominalSecPerQuarter(bpm);
  const grid = options.grid === true;
  const sequential = options.sequential === true && !grid;
  const estimator = new PulseEstimator(startTime, nominal, grid, sequential);
  const matchedOnsets = new Set<number>();
  /** Next-note scoring: each hand's last matched note (its beat and tap time). */
  const lastByZone = new Map<Hand, { beat: number; time: number }>();
  const heldByZone = new Map<0 | 1, number>();
  const onsetGradeByIndex = new Map<number, Grade>();
  const missedOnsets = new Set<number>();
  const twoLines = links(onsets).twoLines;

  /** The first note still open from index `from` on that a press in `zone` may play. */
  /**
   * Matching is by time: a tap goes to the nearest note still open, within that note's window,
   * on the current pulse (the metronome grid in practice, the player's own pulse in count-in).
   * Notes the clock has settled as missed are no longer open, so a player who lost their place
   * is judged correctly again the moment they come back in.
   */
  function matchByTime(hitTime: number, zone: Hand): MatchResult | null {
    const closed = new Set<number>([...matchedOnsets, ...missedOnsets]);
    return findBestMatch(onsets, closed, estimator, hitTime, zone);
  }

  /** The nearest open note to a tap regardless of window (within about a beat), for re-entry. */
  function nearestOpen(hitTime: number, zone: Hand): { index: number; offsetSec: number } | null {
    let best: { index: number; offsetSec: number } | null = null;
    const spq = estimator.currentSecPerQuarter();
    for (let i = 0; i < onsets.length; i++) {
      const onset = onsets[i];
      if (!onset || matchedOnsets.has(i) || missedOnsets.has(i) || !zoneMayPlay(onsets, onset, zone)) continue;
      const offsetSec = hitTime - estimator.predict(onset.beat);
      if (Math.abs(offsetSec) > spq * 1.1) continue;
      if (!best || Math.abs(offsetSec) < Math.abs(best.offsetSec)) best = { index: i, offsetSec };
    }
    return best;
  }

  /** Notes the current tap skipped over (next-note scoring). */
  let skippedNow: number[] = [];

  /** Next-note scoring: the hand's next open note, or the one after when the gap clearly fits it. */
  function matchNext(hitTime: number, zone: Hand): MatchResult | null {
    const open: number[] = [];
    for (let i = 0; i < onsets.length && open.length < 2; i++) {
      const onset = onsets[i];
      if (!onset || matchedOnsets.has(i) || missedOnsets.has(i) || !zoneMayPlay(onsets, onset, zone)) continue;
      if (open.length === 1 && (onsets[open[0]!]?.beat ?? 0) === onset.beat) continue;
      open.push(i);
    }
    const first = open[0];
    if (first === undefined) return null;
    const spq = estimator.currentSecPerQuarter();
    const errorFor = (i: number) => (hitTime - estimator.predict(onsets[i]?.beat ?? 0)) * 1000;
    const last = lastByZone.get(zone);
    if (!last) {
      // The first note of this hand: nothing to measure a gap from but the count-in. A tap well
      // before it (during the count-in) is an extra tap.
      if (lastByZone.size === 0 && hitTime < estimator.predict(onsets[first]?.beat ?? 0) - 0.5 * spq) return null;
      return { index: first, errorMs: errorFor(first) };
    }
    const gap = hitTime - last.time;
    const expectedFirst = ((onsets[first]?.beat ?? 0) - last.beat) * spq;
    if (gap < EXTRA_TAP_FRACTION * expectedFirst) return null;
    const second = open[1];
    if (second !== undefined) {
      const expectedSecond = ((onsets[second]?.beat ?? 0) - last.beat) * spq;
      const window = gradeWindows(gapQuartersBefore(onsets, second) * spq * 1000).ok / 1000;
      if (Math.abs(gap - expectedSecond) < Math.abs(gap - expectedFirst) && Math.abs(gap - expectedSecond) <= window) {
        missedOnsets.add(first);
        skippedNow.push(first);
        return { index: second, errorMs: errorFor(second) };
      }
    }
    return { index: first, errorMs: errorFor(first) };
  }

  /** The last stray tap in count-in mode, waiting for a second one that agrees with it. */
  let pendingReentry: { time: number; index: number; offsetSec: number } | null = null;

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
      skippedNow = [];
      let match = sequential ? matchNext(hit.time, hit.zone) : matchByTime(hit.time, hit.zone);
      let resynced = false;
      if (!match && !grid && !sequential) {
        // Count-in: no metronome to come back to, only the player's own pulse. A stray tap may
        // be the player re-entering on a shifted beat; a second stray that agrees confirms it,
        // and the pulse is re-anchored there.
        const near = nearestOpen(hit.time, hit.zone);
        const previous = pendingReentry;
        if (
          near &&
          previous &&
          near.index > previous.index &&
          hit.time - previous.time < RESYNC_SPAN_BEATS * estimator.currentSecPerQuarter() &&
          Math.abs(near.offsetSec - previous.offsetSec) < RESYNC_AGREEMENT_SEC
        ) {
          estimator.resync(onsets[near.index]?.beat ?? 0, hit.time);
          match = { index: near.index, errorMs: 0 };
          resynced = true;
          pendingReentry = null;
        } else {
          pendingReentry = near ? { time: hit.time, index: near.index, offsetSec: near.offsetSec } : null;
        }
      }
      if (!match) return { onsetIndex: null, errorMs: null, grade: null };
      if (!resynced) pendingReentry = null;

      matchedOnsets.add(match.index);
      const onset = onsets[match.index];
      // The very first note has no pulse of the player's own to be judged against yet, only the
      // count-in (plus any calibration error), so it gets the widest windows.
      const isFirst = matchedOnsets.size === 1 && !grid;
      const gapMs = isFirst ? Number.POSITIVE_INFINITY : gapQuartersBefore(onsets, match.index) * estimator.currentSecPerQuarter() * 1000;
      // A re-entry is graded "ok": the player is back, but was off the count until now.
      const grade: Grade = resynced ? "ok" : gradeFor(Math.abs(match.errorMs), gapMs);
      // Two hands share one pulse, so one hand's stumble must not knock the other hand's notes
      // off: on a two-hand level only confident attacks (perfect or good) steer the pulse.
      const steers = !resynced && (!twoLines || isFirst || grade === "perfect" || grade === "good");
      // Next-note scoring: a hesitation (or a rush) far off the beat moves the anchor to this tap,
      // so the rhythm after it is measured from here, but says nothing about the tempo.
      if (onset && sequential && grade === "miss") estimator.resync(onset.beat, hit.time);
      else if (onset && steers) estimator.update(onset.beat, hit.time);
      onsetGradeByIndex.set(match.index, grade);
      heldByZone.set(hit.zone, match.index);
      if (onset) lastByZone.set(hit.zone, { beat: onset.beat, time: hit.time });

      return { onsetIndex: match.index, errorMs: match.errorMs, grade, resynced, skipped: skippedNow };
    },
    judgeRelease(release: Release): LiveReleaseJudgement {
      return releaseHeld(release.zone, release.time);
    },
    implicitRelease(zone: 0 | 1, time: number): LiveReleaseJudgement {
      return releaseHeld(zone, time);
    },
    predictTime(beat: number): number {
      return estimator.predict(beat);
    },
    secPerQuarter(): number {
      return estimator.currentSecPerQuarter();
    },
    beatAt(time: number): number {
      return estimator.beatAt(time);
    },
    markMissed(onsetIndex: number): void {
      if (!matchedOnsets.has(onsetIndex)) missedOnsets.add(onsetIndex);
    },
  };
}

interface MatchedPoint {
  onsetIndex: number;
  beat: number;
  time: number;
  /** The line (hand) the note is on. */
  line: Hand;
}

/** Same online-pulse matching as the live judge, run over a whole hit list at once. */
function matchHitsToOnsets(
  onsets: Onset[],
  hits: Hit[],
  startTime: number,
  bpm: number,
  grid: boolean,
): { onsetToHit: Map<number, number>; extraHitIndices: number[] } {
  const estimator = new PulseEstimator(startTime, nominalSecPerQuarter(bpm), grid);
  const matchedOnsets = new Set<number>();
  const onsetToHit = new Map<number, number>();
  const extraHitIndices: number[] = [];

  const order = hits
    .map((_, i) => i)
    .sort((a, b) => (hits[a]?.time ?? 0) - (hits[b]?.time ?? 0));

  for (const hitIndex of order) {
    const hit = hits[hitIndex];
    if (!hit) continue;
    const match = findBestMatch(onsets, matchedOnsets, estimator, hit.time, hit.zone);
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

/** The median hit-vs-click offset, clamped to the live judge's limit. */
function clampedMedianOffset(points: MatchedPoint[], startTime: number, nominal: number): number {
  if (points.length === 0) return 0;
  const offsets = points.map((p) => p.time - (startTime + p.beat * nominal)).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const median = offsets.length % 2 ? (offsets[mid] ?? 0) : ((offsets[mid - 1] ?? 0) + (offsets[mid] ?? 0)) / 2;
  return Math.max(-GRID_OFFSET_MAX_SEC, Math.min(GRID_OFFSET_MAX_SEC, median));
}

/** Two-hand levels: a tap this far (ms) off its neighbours' pulse doesn't shape that pulse. */
const PULSE_OUTLIER_MS = 2 * OK_MS;

const GRADE_SCORE: Record<Grade, number> = { perfect: 1, good: 0.9, ok: 0.65, miss: 0 };
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

  // Local tempo from consecutive notes of the same hand: across two hands, notes can be a
  // fraction of a beat apart, which would magnify ordinary timing spread into "unsteadiness".
  const ratios: number[] = [];
  for (const line of [0, 1] as const) {
    const sorted = matchedPoints.filter((p) => p.line === line).sort((a, b) => a.beat - b.beat);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      const dBeat = cur.beat - prev.beat;
      if (dBeat <= 0) continue;
      ratios.push((cur.time - prev.time) / dBeat / nominal);
    }
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
 * zone, if one lands before the next press (any zone; on a two-hand level, the same zone, since
 * the other hand playing doesn't let this one go); otherwise that next press's time, since a
 * held key/finger with no release event is implicitly let go the moment the next note is
 * pressed. Onsets with neither (typically the very last note, if never explicitly released) are
 * left unresolved (no entry).
 */
function computeReleaseTimes(onsets: Onset[], onsetToHit: Map<number, number>, hits: Hit[], releases: Release[]): Map<number, number> {
  const perZone = links(onsets).twoLines;
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
    const nextPress = perZone ? matches.slice(i + 1).find((m) => m.zone === match.zone) : matches[i + 1];
    const nextPressTime = nextPress?.time ?? Number.POSITIVE_INFINITY;

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
  predict: (beat: number) => number,
  nominal: number,
): { eventIndex: number; grade: Grade; reason: string | null }[] {
  const twoLines = links(onsets).twoLines;
  return restSpansList.map((rest) => {
    // On a two-hand level a rest belongs to one hand: only that hand's notes and presses count.
    const line = lineOf(rest);
    const sameLine = (o: Onset) => !twoLines || lineOf(o) === line;
    // The onset immediately preceding this rest (by eventIndex order, the closest onset whose
    // eventIndex is less than the rest's).
    let prevOnsetIndex = -1;
    onsets.forEach((o, i) => {
      if (sameLine(o) && o.eventIndex < rest.eventIndex && (prevOnsetIndex === -1 || o.eventIndex > (onsets[prevOnsetIndex]?.eventIndex ?? -1))) prevOnsetIndex = i;
    });

    const restStart = predict(rest.beat);
    const restEnd = predict(rest.beat + rest.quarters);

    // The next onset after the rest, whose own early-tap allowance overlaps the rest's tail.
    const nextOnset = onsets.find((o) => sameLine(o) && o.beat >= rest.beat + rest.quarters - 1e-6);
    const nextOnsetIndex = nextOnset ? onsets.indexOf(nextOnset) : -1;
    const nextWindowMs = nextOnsetIndex === -1 ? 0 : matchWindowMs(onsets, nextOnsetIndex, nominal);
    const excludeAfter = nextOnset ? predict(nextOnset.beat) - nextWindowMs / 1000 : Number.POSITIVE_INFINITY;

    const pressedDuringRest = hits.some((h) => (!twoLines || h.zone === line) && h.time >= restStart && h.time < Math.min(restEnd, excludeAfter));
    if (pressedDuringRest) return { eventIndex: rest.eventIndex, grade: "miss" as Grade, reason: "you tapped during it" };

    const prevReleaseTime = prevOnsetIndex === -1 ? undefined : releaseTimes.get(prevOnsetIndex);
    const heldAllowanceSec = Math.max(REST_HELD_THROUGH_MS / 1000, REST_HELD_THROUGH_FRACTION * (restEnd - restStart));
    const heldThroughRest = prevReleaseTime !== undefined && prevReleaseTime > restStart + heldAllowanceSec;
    if (heldThroughRest) return { eventIndex: rest.eventIndex, grade: "miss" as Grade, reason: "held through it" };

    return { eventIndex: rest.eventIndex, grade: "perfect" as Grade, reason: null };
  });
}

/**
 * Offline judgement of a full run: one-to-one matches presses to onsets in time order (via the
 * same online pulse tracking as the live judge), grades each match by its error relative to a
 * locally-fitted pulse, resolves each note's release, and grades rests.
 */
/** Next-note scoring: how far a gap's tempo may be from the run's median and still say
 * something about the tempo (beyond that it's a hesitation or a rush, graded on its own note). */
const SEQUENTIAL_PAIR_TOLERANCE = 0.3;

/**
 * Next-note scoring: the player's tempo from the gaps between consecutive taps of each hand
 * (seconds per quarter, with the beat midpoint of each gap), leaving out hesitations and rushes.
 */
function sequentialTempoPairs(points: MatchedPoint[]): { mid: number; spq: number }[] {
  const pairs: { mid: number; spq: number }[] = [];
  for (const line of [0, 1] as const) {
    const sorted = points.filter((p) => p.line === line).sort((a, b) => a.beat - b.beat);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const dBeat = cur.beat - prev.beat;
      if (dBeat < MIN_TEMPO_STEP_QUARTERS) continue;
      pairs.push({ mid: (cur.beat + prev.beat) / 2, spq: (cur.time - prev.time) / dBeat });
    }
  }
  const m = median(pairs.map((p) => p.spq));
  return m === null ? [] : pairs.filter((p) => Math.abs(p.spq / m - 1) <= SEQUENTIAL_PAIR_TOLERANCE);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function judgeRun(onsets: Onset[], restSpansList: RestSpan[], startTime: number, bpm: number, hits: Hit[], releases: Release[], options: JudgeOptions = {}): RunResult {
  const nominal = nominalSecPerQuarter(bpm);
  const grid = options.grid === true;
  const { onsetToHit, extraHitIndices } = options.matches
    ? { onsetToHit: options.matches, extraHitIndices: hits.map((_, i) => i).filter((i) => ![...options.matches!.values()].includes(i)) }
    : matchHitsToOnsets(onsets, hits, startTime, bpm, grid);

  let matchedPoints: MatchedPoint[] = [];
  for (const [onsetIndex, hitIndex] of onsetToHit) {
    const onset = onsets[onsetIndex];
    const hit = hits[hitIndex];
    if (!onset || !hit) continue;
    matchedPoints.push({ onsetIndex, beat: onset.beat, time: hit.time, line: lineOf(onset) });
  }
  // Two hands: the pulse is fitted through both hands' taps, so a wild attack in one hand would
  // skew the other hand's grades. Points far off the fit through their neighbours are left out
  // of the pulse (they are still graded, against it).
  if (links(onsets).twoLines && !grid) {
    const all = matchedPoints;
    matchedPoints = all.filter((p) => Math.abs(p.time - predictTimeAt(all, p.beat, p.onsetIndex, startTime, nominal)) * 1000 <= PULSE_OUTLIER_MS);
  }

  // In grid mode every time is judged against the click, shifted only by the player's median
  // offset (clamped, as in the live judge); otherwise against the locally fitted own pulse.
  const gridOffset = grid ? clampedMedianOffset(matchedPoints, startTime, nominal) : 0;
  const sequential = options.sequential === true && !grid;
  const byBeat = [...matchedPoints].sort((a, b) => a.beat - b.beat);
  const tempoPairs = sequential ? sequentialTempoPairs(matchedPoints) : [];
  const runSpq = median(tempoPairs.map((p) => p.spq));
  /** Next-note scoring: from the previous tap, at the local tempo (the rhythm between taps). */
  const predictFromPrevious = (beat: number, excludeOnsetIndex: number | null): number => {
    let previous: MatchedPoint | undefined;
    for (const p of byBeat) {
      if (p.beat >= beat - 1e-9) break;
      if (p.onsetIndex !== excludeOnsetIndex) previous = p;
    }
    if (!previous) return startTime + beat * nominal;
    const near = tempoPairs.filter((p) => Math.abs(p.mid - beat) <= LOCAL_FIT_WINDOW_QUARTERS * 2).map((p) => p.spq);
    const spq = median(near) ?? runSpq ?? nominal;
    return previous.time + (beat - previous.beat) * spq;
  };
  const predict = (beat: number, excludeOnsetIndex: number | null = null): number =>
    grid ? startTime + beat * nominal + gridOffset : sequential ? predictFromPrevious(beat, excludeOnsetIndex) : predictTimeAt(matchedPoints, beat, excludeOnsetIndex, startTime, nominal);

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
    const relativeErrorMs = (hit.time - predict(onset.beat, index)) * 1000;
    const grade = gradeFor(Math.abs(relativeErrorMs), gapQuartersBefore(onsets, index) * nominal * 1000);

    const releaseTime = releaseTimes.get(index) ?? null;
    let releaseErrorMs: number | null = null;
    let releaseGrade: Grade | null = null;
    // Only sustained notes (longer than a quarter) are hold-graded: a quarter or shorter is
    // "played" the instant it's tapped, and a normal short tap on it is simply correct.
    if (releaseTime !== null && onset.quarters > SUSTAINED_MIN_QUARTERS) {
      const predictedEnd = predict(onset.beat + onset.quarters);
      const durationMs = onset.quarters * nominal * 1000;
      const result = gradeRelease(releaseTime, predictedEnd, durationMs);
      releaseErrorMs = result.errorMs;
      releaseGrade = result.grade;
    }

    return { onset, hitTime: hit.time, strictErrorMs, relativeErrorMs, grade, releaseTime, releaseErrorMs, releaseGrade };
  });

  const restJudgements = judgeRests(restSpansList, onsets, releaseTimes, hits, (beat) => predict(beat), nominal);

  const extraHits = extraHitIndices.map((i) => hits[i]).filter((h): h is Hit => h !== undefined);
  const onsetScore = computeOnsetScore(judgements);
  const holdRestScore = computeHoldRestScore(judgements, restJudgements);
  const accuracy = computeAccuracy(onsetScore, holdRestScore, extraHits.length);
  let handAccuracy: [number, number] | undefined;
  if (links(onsets).twoLines) {
    const forHand = (hand: Hand): number => {
      const handJudgements = judgements.filter((j) => lineOf(j.onset) === hand);
      const restLine = new Map(restSpansList.map((r) => [r.eventIndex, lineOf(r)]));
      const handRests = restJudgements.filter((r) => restLine.get(r.eventIndex) === hand);
      const handExtras = extraHits.filter((h) => h.zone === hand).length;
      return computeAccuracy(computeOnsetScore(handJudgements), computeHoldRestScore(handJudgements, handRests), handExtras);
    };
    handAccuracy = [forHand(0), forHand(1)];
  }
  let playedBpm: number;
  let driftPercent: number;
  let steadiness: number;
  if (sequential) {
    // Tempo, drift and steadiness from the gaps between taps, hesitations left out. The tempo is
    // reported, not graded: steadiness is only how evenly the beat was kept from note to note.
    playedBpm = runSpq ? 60 / runSpq : bpm;
    const beats = tempoPairs.map((p) => p.mid);
    const span = beats.length ? Math.max(...beats) - Math.min(...beats) : 0;
    const first = median(tempoPairs.filter((p) => p.mid <= Math.min(...beats) + span / 4).map((p) => p.spq));
    const last = median(tempoPairs.filter((p) => p.mid >= Math.max(...beats) - span / 4).map((p) => p.spq));
    driftPercent = first && last && tempoPairs.length >= 4 ? (first / last - 1) * 100 : 0;
    const ratios = runSpq ? tempoPairs.map((p) => p.spq / runSpq) : [];
    const mean = ratios.reduce((a, r) => a + r, 0) / Math.max(1, ratios.length);
    const wobblePercent = ratios.length > 1 ? Math.sqrt(ratios.reduce((a, r) => a + (r - mean) ** 2, 0) / ratios.length) * 100 : 0;
    steadiness = Math.min(100, Math.max(0, 100 - LOCAL_VARIANCE_PENALTY_PER_PERCENT * wobblePercent));
  } else {
    playedBpm = computePlayedBpm(matchedPoints, bpm);
    driftPercent = computeDriftPercent(onsets, matchedPoints);
    steadiness = computeSteadiness(matchedPoints, bpm, playedBpm);
  }

  const result: RunResult = { judgements, extraHits, restJudgements, accuracy, steadiness, playedBpm, driftPercent };
  if (handAccuracy) result.handAccuracy = handAccuracy;
  return result;
}

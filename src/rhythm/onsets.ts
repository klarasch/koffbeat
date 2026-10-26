// Derives the list of tap-able onsets and rest spans from a Level's written rhythm.

import type { Hand, Level, Onset, RestSpan, RhythmEvent } from "../types";
import { eventQuarters, levelLines } from "./durations";

/** Beat positions are kept to a millionth of a quarter note. */
const BEAT_GRID = 1e9;

interface FlatEvent {
  eventIndex: number;
  line: Hand;
  beat: number;
  quarters: number;
  rest: boolean;
  tie: boolean;
}

/** One line's events, bar by bar, starting at event index `firstIndex`. */
function flattenLine(bars: RhythmEvent[][], line: Hand, firstIndex: number): FlatEvent[] {
  const flat: FlatEvent[] = [];
  let exact = 0;
  let eventIndex = firstIndex;
  for (const bar of bars) {
    for (const event of bar) {
      const quarters = eventQuarters(event);
      // Rounded so a run of triplets (each 2/3 long) lands exactly on the beat it fills, and
      // the two hands agree on when a shared beat comes.
      const beat = Math.round(exact * BEAT_GRID) / BEAT_GRID;
      flat.push({ eventIndex, line, beat, quarters, rest: event.rest, tie: event.tie === true && !event.rest });
      exact += quarters;
      eventIndex += 1;
    }
  }
  return flat;
}

/**
 * Every line's events. Event indices run through the left hand's line first, then the right
 * hand's, so one index names one written symbol on the staff whichever line it's on.
 */
function flattenLines(level: Level): FlatEvent[][] {
  const result: FlatEvent[][] = [];
  let next = 0;
  levelLines(level).forEach((bars, line) => {
    const flat = flattenLine(bars, line === 0 ? 0 : 1, next);
    next += flat.length;
    result.push(flat);
  });
  return result;
}

/** Sorted by beat; on the same beat, the left hand's first. */
function byBeat<T extends { beat: number; line?: Hand }>(a: T, b: T): number {
  return a.beat - b.beat || (a.line ?? 0) - (b.line ?? 0);
}

/**
 * Onsets for notes that start a new sound: skips rests and events that are the continuation of
 * a tie (the previous event has `tie: true`). Beat positions are in quarter notes from the
 * start of bar 1. `quarters` is the note's full sounding length — for a tied chain, the sum of
 * every event in the chain, so the note is held (and released) as a single note. On a two-hand
 * level both lines' onsets are merged in beat order, each tagged with its `line`.
 */
export function levelOnsets(level: Level): Onset[] {
  const lines = flattenLines(level);
  const twoLines = lines.length > 1;
  const onsets: Onset[] = [];

  for (const flat of lines) {
    let previousTied = false;
    for (let i = 0; i < flat.length; i++) {
      const event = flat[i];
      if (!event) continue;
      if (!event.rest && !previousTied) {
        let quarters = event.quarters;
        let j = i;
        let next = flat[j + 1];
        while (flat[j]?.tie && next) {
          quarters += next.quarters;
          j += 1;
          next = flat[j + 1];
        }
        const onset: Onset = { eventIndex: event.eventIndex, beat: event.beat, quarters };
        if (twoLines) onset.line = event.line;
        onsets.push(onset);
      }
      previousTied = event.tie;
    }
  }

  return twoLines ? onsets.sort(byBeat) : onsets;
}

/**
 * One span per written rest symbol (consecutive rests are kept separate, not merged), so each
 * can be graded and coloured individually.
 */
export function restSpans(level: Level): RestSpan[] {
  const lines = flattenLines(level);
  const twoLines = lines.length > 1;
  const spans = lines.flat().filter((e) => e.rest).map((e): RestSpan => {
    const span: RestSpan = { eventIndex: e.eventIndex, beat: e.beat, quarters: e.quarters };
    if (twoLines) span.line = e.line;
    return span;
  });
  return twoLines ? spans.sort(byBeat) : spans;
}

/** True for each event index that ties into the next event (a continuation, not a new sound). */
export function tieFlags(level: Level): boolean[] {
  return flattenLines(level).flat().map((e) => e.tie);
}

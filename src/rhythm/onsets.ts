// Derives the list of tap-able onsets and rest spans from a Level's written rhythm.

import type { Level, Onset, RestSpan } from "../types";
import { eventQuarters } from "./durations";

interface FlatEvent {
  eventIndex: number;
  beat: number;
  quarters: number;
  rest: boolean;
  tie: boolean;
}

function flattenEvents(level: Level): FlatEvent[] {
  const flat: FlatEvent[] = [];
  let beat = 0;
  let eventIndex = 0;
  for (const bar of level.bars) {
    for (const event of bar) {
      const quarters = eventQuarters(event);
      flat.push({ eventIndex, beat, quarters, rest: event.rest, tie: event.tie === true && !event.rest });
      beat += quarters;
      eventIndex += 1;
    }
  }
  return flat;
}

/**
 * Onsets for notes that start a new sound: skips rests and events that are the continuation of
 * a tie (the previous event has `tie: true`). Beat positions are in quarter notes from the
 * start of bar 1. `quarters` is the note's full sounding length — for a tied chain, the sum of
 * every event in the chain, so the note is held (and released) as a single note.
 */
export function levelOnsets(level: Level): Onset[] {
  const flat = flattenEvents(level);
  const onsets: Onset[] = [];
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
      onsets.push({ eventIndex: event.eventIndex, beat: event.beat, quarters });
    }
    previousTied = event.tie;
  }

  return onsets;
}

/**
 * One span per written rest symbol (consecutive rests are kept separate, not merged), so each
 * can be graded and coloured individually.
 */
export function restSpans(level: Level): RestSpan[] {
  const flat = flattenEvents(level);
  return flat.filter((e) => e.rest).map((e) => ({ eventIndex: e.eventIndex, beat: e.beat, quarters: e.quarters }));
}

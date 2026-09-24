// Derives the list of tap-able onsets from a Level's written rhythm.

import type { Level, Onset } from "../types";
import { barQuarters, eventQuarters } from "./durations";

/**
 * Onsets for notes that start a new sound: skips rests and events that are
 * the continuation of a tie (the previous event has `tie: true`). Beat
 * positions are in quarter notes from the start of bar 1.
 */
export function levelOnsets(level: Level): Onset[] {
  const onsets: Onset[] = [];
  let beat = 0;
  let eventIndex = 0;
  let previousTied = false;

  for (const bar of level.bars) {
    const barStart = beat;
    let offsetInBar = 0;
    for (const event of bar) {
      if (!event.rest && !previousTied) {
        onsets.push({ eventIndex, beat: barStart + offsetInBar });
      }
      offsetInBar += eventQuarters(event);
      previousTied = event.tie === true && !event.rest;
      eventIndex += 1;
    }
    beat = barStart + barQuarters(level.meter);
  }

  return onsets;
}

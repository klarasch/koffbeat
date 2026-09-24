// Duration arithmetic over written rhythm notation. Pure, no timing/audio concerns here.

import type { Level, Meter, RhythmEvent } from "../types";

const BASE_QUARTERS: Record<RhythmEvent["value"], number> = {
  w: 4,
  h: 2,
  q: 1,
  "8": 0.5,
  "16": 0.25,
};

/** Duration of a single event in quarter notes, dots included. */
export function eventQuarters(e: RhythmEvent): number {
  const base = BASE_QUARTERS[e.value];
  return e.dots === 1 ? base * 1.5 : base;
}

/** Total duration of one bar in a given meter, in quarter notes (beats * 4/beatUnit). */
export function barQuarters(meter: Meter): number {
  return (meter.beats * 4) / meter.beatUnit;
}

const EPSILON = 1e-6;

/**
 * Validates a level's bars against its meter and tie placement.
 * Returns a list of human-readable error messages (empty when valid).
 */
export function validateLevel(level: Level): string[] {
  const errors: string[] = [];
  const expected = barQuarters(level.meter);

  level.bars.forEach((bar, barIndex) => {
    const total = bar.reduce((sum, e) => sum + eventQuarters(e), 0);
    if (Math.abs(total - expected) > EPSILON) {
      errors.push(`Bar ${barIndex + 1} totals ${total} quarter notes, expected ${expected} to fill the meter.`);
    }

    bar.forEach((e, eventIndex) => {
      if (!e.tie) return;
      const isLastInBar = eventIndex === bar.length - 1;
      const isLastBar = barIndex === level.bars.length - 1;
      if (isLastInBar && isLastBar) {
        errors.push(`Bar ${barIndex + 1}, event ${eventIndex + 1} is tied but is the last event of the level.`);
        return;
      }
      const next = isLastInBar ? level.bars[barIndex + 1]?.[0] : bar[eventIndex + 1];
      if (next && next.rest) {
        errors.push(`Bar ${barIndex + 1}, event ${eventIndex + 1} is tied into a rest.`);
      }
    });
  });

  return errors;
}

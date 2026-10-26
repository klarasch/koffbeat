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
  const dotted = e.dots === 1 ? base * 1.5 : base;
  return e.tuplet === 3 ? (dotted * 2) / 3 : dotted;
}

/** The level's lines: both hands' on a two-hand level, else the single line. */
export function levelLines(level: Level): RhythmEvent[][][] {
  return level.lines && level.lines.length > 0 ? level.lines : [level.bars];
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
  const lines = levelLines(level);
  const errors: string[] = [];
  if (lines.length > 2) errors.push(`A level has at most two lines, found ${lines.length}.`);
  const barCount = lines[0]?.length ?? 0;
  lines.forEach((bars, lineIndex) => {
    if (bars.length !== barCount) errors.push(`Line ${lineIndex + 1} has ${bars.length} bars, expected ${barCount}.`);
    const prefix = lines.length > 1 ? `${lineIndex === 0 ? "Left hand" : "Right hand"}, b` : "B";
    for (const error of validateBars(bars, level)) errors.push(prefix + error.slice(1));
  });
  return errors;
}

function validateBars(levelBars: RhythmEvent[][], level: Level): string[] {
  const errors: string[] = [];
  const expected = barQuarters(level.meter);

  levelBars.forEach((bar, barIndex) => {
    const total = bar.reduce((sum, e) => sum + eventQuarters(e), 0);
    if (Math.abs(total - expected) > EPSILON) {
      errors.push(`Bar ${barIndex + 1} totals ${total} quarter notes, expected ${expected} to fill the meter.`);
    }

    bar.forEach((e, eventIndex) => {
      if (!e.tie) return;
      const isLastInBar = eventIndex === bar.length - 1;
      const isLastBar = barIndex === levelBars.length - 1;
      if (isLastInBar && isLastBar) {
        errors.push(`Bar ${barIndex + 1}, event ${eventIndex + 1} is tied but is the last event of the level.`);
        return;
      }
      const next = isLastInBar ? levelBars[barIndex + 1]?.[0] : bar[eventIndex + 1];
      if (next && next.rest) {
        errors.push(`Bar ${barIndex + 1}, event ${eventIndex + 1} is tied into a rest.`);
      }
    });

    // Triplets come in complete groups of three of the same written value.
    let run = 0;
    bar.forEach((e, eventIndex) => {
      if (e.tuplet !== 3) return;
      const prev = run > 0 ? bar[eventIndex - 1] : undefined;
      if (run > 0 && prev && prev.value !== e.value) errors.push(`Bar ${barIndex + 1}, event ${eventIndex + 1} changes value inside a triplet.`);
      run = (run + 1) % 3;
    });
    if (run !== 0) errors.push(`Bar ${barIndex + 1} has an incomplete triplet.`);
  });

  return errors;
}

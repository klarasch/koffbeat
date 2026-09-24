// Introductory level bank: four 4/4 levels at 80 bpm, each four bars, each
// introducing one new rhythmic idea over the previous level.

import type { Level, RhythmEvent } from "../types";

const METER = { beats: 4, beatUnit: 4 } as const;
const BPM = 80;

function note(value: RhythmEvent["value"], opts: Partial<Omit<RhythmEvent, "value" | "rest">> = {}): RhythmEvent {
  return { value, dots: opts.dots ?? 0, rest: false, ...(opts.tie !== undefined ? { tie: opts.tie } : {}) };
}

function rest(value: RhythmEvent["value"]): RhythmEvent {
  return { value, dots: 0, rest: true };
}

/** Level 1: quarter notes only, steady pulse. */
const level1: Level = {
  id: "quarters",
  title: "Steady quarters",
  meter: METER,
  bpm: BPM,
  bars: [
    [note("q"), note("q"), note("q"), note("q")],
    [note("q"), note("q"), note("q"), note("q")],
    [note("q"), note("q"), note("q"), note("q")],
    [note("q"), note("q"), note("q"), note("q")],
  ],
};

/** Level 2: introduces half notes alongside quarters. */
const level2: Level = {
  id: "quarters-halves",
  title: "Quarters and halves",
  meter: METER,
  bpm: BPM,
  bars: [
    [note("h"), note("h")],
    [note("h"), note("q"), note("q")],
    [note("q"), note("q"), note("h")],
    [note("q"), note("q"), note("q"), note("q")],
  ],
};

/** Level 3: introduces quarter rests. */
const level3: Level = {
  id: "quarters-rests",
  title: "Quarters with rests",
  meter: METER,
  bpm: BPM,
  bars: [
    [note("q"), note("q"), note("q"), note("q")],
    [note("q"), rest("q"), note("q"), note("q")],
    [rest("q"), note("q"), note("q"), note("q")],
    [note("q"), rest("q"), rest("q"), note("q")],
  ],
};

/** Level 4: introduces pairs of eighth notes. */
const level4: Level = {
  id: "quarters-eighths",
  title: "Quarters and eighth pairs",
  meter: METER,
  bpm: BPM,
  bars: [
    [note("q"), note("q"), note("8"), note("8"), note("q")],
    [note("8"), note("8"), note("q"), note("q"), note("q")],
    [note("q"), note("8"), note("8"), note("8"), note("8"), note("q")],
    [note("q"), note("q"), note("q"), note("q")],
  ],
};

export const LEVELS: Level[] = [level1, level2, level3, level4];

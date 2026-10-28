// Shared contracts between modules. Change only with care: every module depends on these.

/** Time signature, e.g. 4/4 → { beats: 4, beatUnit: 4 }. */
export interface Meter {
  beats: number;
  beatUnit: number;
}

/** Written note value. "w" whole, "h" half, "q" quarter, "8" eighth, "16" sixteenth. */
export type NoteValue = "w" | "h" | "q" | "8" | "16";

/** One written symbol on a rhythm line (a note or a rest). */
export interface RhythmEvent {
  value: NoteValue;
  dots: 0 | 1;
  rest: boolean;
  /** Tied to the next event: the next event is sounded as a continuation, not a new onset. */
  tie?: boolean;
  /**
   * Part of a triplet: three of these fill the time of two of the same written value (so a
   * quarter-note triplet lasts 2/3 of a quarter). Triplet events come in groups of three.
   */
  tuplet?: 3;
}

/** Which hand plays a line: 0 = left (zone 0: F, left half), 1 = right (zone 1: J, right half). */
export type Hand = 0 | 1;

/** A playable exercise: one rhythm line, or two independent lines (one per hand). */
export interface Level {
  id: string;
  title: string;
  meter: Meter;
  /** Tempo in quarter notes per minute. */
  bpm: number;
  /** Events grouped by bar; each bar must fill the meter exactly. For a two-hand level, the
   * left hand's line (the same as `lines[0]`). */
  bars: RhythmEvent[][];
  /**
   * Two-hand levels only: `lines[0]` is the left hand's bars, `lines[1]` the right hand's, each
   * with the same number of bars. Absent for a one-line level; read through `levelLines()`.
   */
  lines?: RhythmEvent[][][];
}

/** A moment the player must tap, derived from a Level. */
export interface Onset {
  /** Index into the flattened event list (bar by bar; on a two-hand level, the left hand's line
   * first, then the right hand's) of the note that starts here. */
  eventIndex: number;
  /** Which line (and so which hand/zone) plays it. Absent means line 0 of a one-line level. */
  line?: Hand;
  /** Position from the start of bar 1, in quarter notes. */
  beat: number;
  /** Sounding length, in quarter notes. A tied chain counts as one note with the summed length. */
  quarters: number;
}

/** A silent span between notes, one per written rest symbol (consecutive rests are not merged). */
export interface RestSpan {
  /** Index into the flattened event list of the rest symbol. */
  eventIndex: number;
  /** Which line the rest is on. Absent means line 0 of a one-line level. */
  line?: Hand;
  /** Position from the start of bar 1, in quarter notes. */
  beat: number;
  /** Length, in quarter notes. */
  quarters: number;
}

/** A player tap, already latency-corrected, in AudioContext seconds. */
export interface Hit {
  time: number;
  zone: 0 | 1;
}

/** A player release (finger up / key up), already latency-corrected, in AudioContext seconds. */
export interface Release {
  time: number;
  zone: 0 | 1;
}

export type Grade = "perfect" | "good" | "ok" | "miss";

export interface OnsetJudgement {
  onset: Onset;
  /** Matched hit time, or null when missed. */
  hitTime: number | null;
  /** Error vs the fixed grid from the count-in tempo, in ms (positive = late). */
  strictErrorMs: number | null;
  /** Error vs the player's own (slowly drifting) pulse, in ms. */
  relativeErrorMs: number | null;
  /** Onset (attack-timing) grade. */
  grade: Grade;
  /** Matched release time (explicit release, or the next press as a fallback), or null when never released. */
  releaseTime: number | null;
  /** Error vs the predicted note end, in ms (positive = held too long). */
  releaseErrorMs: number | null;
  /** Hold/release grade, or null when there's nothing to grade it against. */
  releaseGrade: Grade | null;
}

export interface RunResult {
  judgements: OnsetJudgement[];
  /** Hits that matched no onset. */
  extraHits: Hit[];
  /** Per-rest grading: was the rest actually silent. */
  restJudgements: { eventIndex: number; grade: Grade; reason: string | null }[];
  /**
   * 0–100: 70% onset (attack) timing score + 30% hold/rest correctness score, judged against
   * the player's own pulse. See judge.ts's computeAccuracy for the exact blend.
   */
  accuracy: number;
  /** Two-hand levels only: the same accuracy blend per hand, [left, right]. */
  handAccuracy?: [number, number];
  /** 0–100: how steady the player's pulse stayed relative to the count-in tempo. */
  steadiness: number;
  /** Player's average tempo in quarter-note BPM, estimated from their hits. */
  playedBpm: number;
  /** Tempo change from the first to the last bar, in percent (positive = rushed). */
  driftPercent: number;
  /** Count-in only: the tempo the player kept in each bar (quarter-note BPM), null where unknown. */
  tempoByBar?: (number | null)[];
}

/** Playback support level, the "mode ladder". Phase A implements practice and countIn. */
export type Mode = "learn" | "practice" | "countIn" | "exam";

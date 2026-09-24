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
}

/** A playable exercise. Phase A uses a single rhythm line. */
export interface Level {
  id: string;
  title: string;
  meter: Meter;
  /** Tempo in quarter notes per minute. */
  bpm: number;
  /** Events grouped by bar; each bar must fill the meter exactly. */
  bars: RhythmEvent[][];
}

/** A moment the player must tap, derived from a Level. */
export interface Onset {
  /** Index into the flattened event list (bar by bar) of the note that starts here. */
  eventIndex: number;
  /** Position from the start of bar 1, in quarter notes. */
  beat: number;
}

/** A player tap, already latency-corrected, in AudioContext seconds. */
export interface Hit {
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
  grade: Grade;
}

export interface RunResult {
  judgements: OnsetJudgement[];
  /** Hits that matched no onset. */
  extraHits: Hit[];
  /** 0–100: are the note proportions right, judged against the player's own pulse. */
  accuracy: number;
  /** 0–100: how steady the player's pulse stayed relative to the count-in tempo. */
  steadiness: number;
  /** Player's average tempo in quarter-note BPM, estimated from their hits. */
  playedBpm: number;
  /** Tempo change from the first to the last bar, in percent (positive = rushed). */
  driftPercent: number;
}

/** Playback support level, the "mode ladder". Phase A implements practice and countIn. */
export type Mode = "learn" | "practice" | "countIn" | "exam";

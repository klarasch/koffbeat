import { describe, expect, it } from "vitest";
import type { Level, RhythmEvent } from "../types";
import { barQuarters, eventQuarters, validateLevel } from "./durations";
import { LEVELS } from "./levels";

function note(value: RhythmEvent["value"], dots: 0 | 1 = 0): RhythmEvent {
  return { value, dots, rest: false };
}

function rest(value: RhythmEvent["value"], dots: 0 | 1 = 0): RhythmEvent {
  return { value, dots, rest: true };
}

describe("eventQuarters", () => {
  it("converts base note values to quarter-note units", () => {
    expect(eventQuarters(note("w"))).toBe(4);
    expect(eventQuarters(note("h"))).toBe(2);
    expect(eventQuarters(note("q"))).toBe(1);
    expect(eventQuarters(note("8"))).toBe(0.5);
    expect(eventQuarters(note("16"))).toBe(0.25);
  });

  it("multiplies dotted notes by 1.5", () => {
    expect(eventQuarters(note("q", 1))).toBe(1.5);
    expect(eventQuarters(note("h", 1))).toBe(3);
  });

  it("treats rests the same as notes of the same value", () => {
    expect(eventQuarters(rest("q"))).toBe(1);
  });
});

describe("barQuarters", () => {
  it("computes 4/4 as 4 quarter notes", () => {
    expect(barQuarters({ beats: 4, beatUnit: 4 })).toBe(4);
  });

  it("computes 3/4 as 3 quarter notes", () => {
    expect(barQuarters({ beats: 3, beatUnit: 4 })).toBe(3);
  });

  it("computes 6/8 as 3 quarter notes", () => {
    expect(barQuarters({ beats: 6, beatUnit: 8 })).toBe(3);
  });
});

describe("validateLevel", () => {
  const meter = { beats: 4, beatUnit: 4 };

  function level(bars: RhythmEvent[][]): Level {
    return { id: "t", title: "t", meter, bpm: 80, bars };
  }

  it("accepts a level whose bars exactly fill the meter", () => {
    expect(validateLevel(level([[note("q"), note("q"), note("q"), note("q")]]))).toEqual([]);
  });

  it("reports a bar that underfills the meter", () => {
    const errors = validateLevel(level([[note("q"), note("q")]]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Bar 1/);
  });

  it("reports a bar that overfills the meter", () => {
    const errors = validateLevel(level([[note("w"), note("q")]]));
    expect(errors).toHaveLength(1);
  });

  it("reports a tie on the very last event of the level", () => {
    const errors = validateLevel(level([[note("q"), note("q"), note("q"), { ...note("q"), tie: true }]]));
    expect(errors.some((e) => /last event/.test(e))).toBe(true);
  });

  it("reports a tie into a rest", () => {
    const errors = validateLevel(
      level([
        [{ ...note("q"), tie: true }, rest("q"), note("q"), note("q")],
      ]),
    );
    expect(errors.some((e) => /tied into a rest/.test(e))).toBe(true);
  });

  it("allows a tie across the bar line into a note", () => {
    const errors = validateLevel(
      level([
        [note("q"), note("q"), note("q"), { ...note("q"), tie: true }],
        [note("q"), note("q"), note("q"), note("q")],
      ]),
    );
    expect(errors).toEqual([]);
  });

  it("validates every shipped level", () => {
    for (const lvl of LEVELS) {
      expect(validateLevel(lvl)).toEqual([]);
    }
  });
});

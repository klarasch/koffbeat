import { describe, expect, it } from "vitest";
import type { Level, RhythmEvent } from "../types";
import { levelOnsets } from "./onsets";

function note(value: RhythmEvent["value"], opts: Partial<RhythmEvent> = {}): RhythmEvent {
  return { value, dots: 0, rest: false, ...opts };
}

function rest(value: RhythmEvent["value"]): RhythmEvent {
  return { value, dots: 0, rest: true };
}

const meter = { beats: 4, beatUnit: 4 };

function level(bars: RhythmEvent[][]): Level {
  return { id: "t", title: "t", meter, bpm: 80, bars };
}

describe("levelOnsets", () => {
  it("gives one onset per quarter note, at successive beats", () => {
    const onsets = levelOnsets(level([[note("q"), note("q"), note("q"), note("q")]]));
    expect(onsets).toEqual([
      { eventIndex: 0, beat: 0 },
      { eventIndex: 1, beat: 1 },
      { eventIndex: 2, beat: 2 },
      { eventIndex: 3, beat: 3 },
    ]);
  });

  it("skips rests", () => {
    const onsets = levelOnsets(level([[note("q"), rest("q"), note("q"), note("q")]]));
    expect(onsets).toEqual([
      { eventIndex: 0, beat: 0 },
      { eventIndex: 2, beat: 2 },
      { eventIndex: 3, beat: 3 },
    ]);
  });

  it("produces no onset for a tied continuation", () => {
    const onsets = levelOnsets(level([[note("h", { tie: true }), note("h")]]));
    // event 1 is the tied continuation of event 0: no onset for it.
    expect(onsets).toEqual([{ eventIndex: 0, beat: 0 }]);
  });

  it("continues beat positions across bar lines, including ties over the bar line", () => {
    const onsets = levelOnsets(
      level([
        [note("q"), note("q"), note("q"), note("q", { tie: true })],
        [note("q"), note("q"), note("q"), note("q")],
      ]),
    );
    expect(onsets.map((o) => o.beat)).toEqual([0, 1, 2, 3, 5, 6, 7]);
    expect(onsets.map((o) => o.eventIndex)).toEqual([0, 1, 2, 3, 5, 6, 7]);
  });

  it("handles eighth-note pairs", () => {
    const onsets = levelOnsets(level([[note("q"), note("8"), note("8"), note("q"), note("q")]]));
    expect(onsets.map((o) => o.beat)).toEqual([0, 1, 1.5, 2, 3]);
  });
});

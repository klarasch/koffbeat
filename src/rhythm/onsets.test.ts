import { describe, expect, it } from "vitest";
import type { Level, RhythmEvent } from "../types";
import { levelOnsets, restSpans } from "./onsets";

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
  it("gives one onset per quarter note, at successive beats, each one quarter long", () => {
    const onsets = levelOnsets(level([[note("q"), note("q"), note("q"), note("q")]]));
    expect(onsets).toEqual([
      { eventIndex: 0, beat: 0, quarters: 1 },
      { eventIndex: 1, beat: 1, quarters: 1 },
      { eventIndex: 2, beat: 2, quarters: 1 },
      { eventIndex: 3, beat: 3, quarters: 1 },
    ]);
  });

  it("skips rests", () => {
    const onsets = levelOnsets(level([[note("q"), rest("q"), note("q"), note("q")]]));
    expect(onsets).toEqual([
      { eventIndex: 0, beat: 0, quarters: 1 },
      { eventIndex: 2, beat: 2, quarters: 1 },
      { eventIndex: 3, beat: 3, quarters: 1 },
    ]);
  });

  it("produces no onset for a tied continuation, and sums the tied chain's length onto the onset", () => {
    const onsets = levelOnsets(level([[note("h", { tie: true }), note("h")]]));
    // event 1 is the tied continuation of event 0: no onset for it, but its length is added.
    expect(onsets).toEqual([{ eventIndex: 0, beat: 0, quarters: 4 }]);
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
    // The tied quarter (event 3, tied into event 4) is held as one 2-quarter note.
    expect(onsets[3]?.quarters).toBe(2);
  });

  it("handles eighth-note pairs", () => {
    const onsets = levelOnsets(level([[note("q"), note("8"), note("8"), note("q"), note("q")]]));
    expect(onsets.map((o) => o.beat)).toEqual([0, 1, 1.5, 2, 3]);
  });
});

describe("restSpans", () => {
  it("gives one span per rest symbol, with its own length", () => {
    const spans = restSpans(level([[note("q"), rest("q"), note("h"), rest("q")]]));
    expect(spans).toEqual([
      { eventIndex: 1, beat: 1, quarters: 1 },
      { eventIndex: 3, beat: 4, quarters: 1 },
    ]);
  });

  it("keeps consecutive rests as separate spans, not merged", () => {
    const spans = restSpans(level([[note("q"), rest("q"), rest("q"), note("q")]]));
    expect(spans).toEqual([
      { eventIndex: 1, beat: 1, quarters: 1 },
      { eventIndex: 2, beat: 2, quarters: 1 },
    ]);
  });

  it("returns an empty list when there are no rests", () => {
    expect(restSpans(level([[note("q"), note("q"), note("q"), note("q")]]))).toEqual([]);
  });
});

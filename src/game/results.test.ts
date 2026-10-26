import { describe, expect, it } from "vitest";
import { judgeRun } from "../rhythm/judge";
import { LEVELS } from "../rhythm/levels";
import { levelOnsets, restSpans } from "../rhythm/onsets";
import { attackWords, releaseWords, teacherNotes } from "./results";

const start = 10;

describe("teacher feedback", () => {
  it("words attacks by grade and direction", () => {
    expect(attackWords("perfect", -10)).toBe("on time");
    expect(attackWords("good", -70)).toBe("a touch early");
    expect(attackWords("ok", 120)).toBe("late");
    expect(attackWords("miss", -300)).toBe("too soon");
    expect(releaseWords(-400)).toBe("let go too soon");
    expect(releaseWords(300)).toBe("held too long");
  });

  it("notices rushed eighth notes", () => {
    const level = LEVELS[3]!; // quarters and eighth pairs
    const onsets = levelOnsets(level);
    const spq = 60 / level.bpm;
    // Every eighth note comes 60 ms early; the quarters are on time.
    const hits = onsets.map((o) => ({ time: start + o.beat * spq - (o.quarters === 0.5 ? 0.06 : 0), zone: 0 as const }));
    const notes = teacherNotes(judgeRun(onsets, restSpans(level), start, level.bpm, hits, [], { grid: true }), "practice");
    expect(notes.some((n) => n.startsWith("You rush the eighth notes"))).toBe(true);
  });

  it("notices long notes cut short", () => {
    const level = LEVELS[1]!; // quarters and halves
    const onsets = levelOnsets(level);
    const spq = 60 / level.bpm;
    const hits = onsets.map((o) => ({ time: start + o.beat * spq, zone: 0 as const }));
    const releases = onsets.map((o) => ({ time: start + o.beat * spq + (o.quarters > 1 ? o.quarters * spq * 0.4 : 0.1), zone: 0 as const }));
    const notes = teacherNotes(judgeRun(onsets, restSpans(level), start, level.bpm, hits, releases), "countIn");
    expect(notes).toContain("You let the long notes go too soon: hold them for their full length.");
  });

  it("praises clean playing", () => {
    const level = LEVELS[0]!;
    const onsets = levelOnsets(level);
    const spq = 60 / level.bpm;
    const hits = onsets.map((o) => ({ time: start + o.beat * spq, zone: 0 as const }));
    expect(teacherNotes(judgeRun(onsets, restSpans(level), start, level.bpm, hits, []), "practice")).toEqual(["Clean playing. Try it a little faster."]);
  });
});

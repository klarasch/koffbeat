import { beforeEach, describe, expect, it } from "vitest";
import { validateLevel } from "../rhythm/durations";
import {
  countsForStep,
  firstOpenLesson,
  firstOpenPiece,
  firstOpenStep,
  LESSONS,
  lessonDone,
  loadProgress,
  PASS_ACCURACY,
  pieceDone,
  pieceLevel,
  pieceSeed,
  PIECES,
  recordResult,
  stepDone,
} from "./lessons";

const PINNED_SEED = 1147039243;

function stubStorage(): void {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as Storage;
}

describe("lesson pieces", () => {
  it("derives stable, distinct seeds from lesson id and piece", () => {
    expect(pieceSeed("read-1", 0)).toBe(pieceSeed("read-1", 0));
    const seeds = new Set(LESSONS.flatMap((l) => Array.from({ length: PIECES }, (_, p) => pieceSeed(l.id, p))));
    expect(seeds.size).toBe(LESSONS.length * PIECES);
    // Pinned so an accidental change to the hash (which would reshuffle every learner's pieces) is noticed.
    expect(pieceSeed("read-1", 0)).toBe(PINNED_SEED);
    for (const s of seeds) expect(s).toBeGreaterThanOrEqual(0);
  });

  it("gives every step of a piece the same music, only the tempo differs", () => {
    for (const lesson of LESSONS) {
      for (let piece = 0; piece < PIECES; piece++) {
        const [first, ...rest] = lesson.steps.map((step) => pieceLevel(lesson, piece, step.bpm));
        expect(validateLevel(first!), `${lesson.id} piece ${piece}`).toEqual([]);
        expect(first!.bars).toHaveLength(lesson.bars);
        for (const other of rest) {
          expect(other.id).toBe(first!.id);
          expect(other.bars).toEqual(first!.bars);
          expect(other.lines).toEqual(first!.lines);
        }
      }
    }
    // Different pieces are different music (the first lesson is all quarters, so look further on).
    const lesson = LESSONS[5]!;
    expect(pieceLevel(lesson, 0, 60).bars).not.toEqual(pieceLevel(lesson, 1, 60).bars);
  });

  it("includes a 3 against 2 lesson, and a play-along Learn step in reading lessons", () => {
    expect(LESSONS.some((l) => l.title.toLowerCase().includes("3 against 2"))).toBe(true);
    expect(LESSONS[0]!.steps.map((s) => [s.label, s.mode, Boolean(s.guide)])).toEqual([
      ["Learn", "practice", true],
      ["Practice", "practice", false],
      ["Count-in", "countIn", false],
    ]);
  });
});

describe("lesson progress", () => {
  beforeEach(stubStorage);
  const lesson = LESSONS[0]!;

  it("counts a run only at the suggested tempo or faster", () => {
    const step = lesson.steps[1]!;
    expect(countsForStep(step, step.bpm)).toBe(true);
    expect(countsForStep(step, step.bpm + 5)).toBe(true);
    expect(countsForStep(step, step.bpm - 5)).toBe(false);
    recordResult(lesson, 0, 1, 99, step.bpm - 5);
    expect(stepDone(loadProgress(), lesson, 0, 1)).toBe(false);
    recordResult(lesson, 0, 1, PASS_ACCURACY - 1, step.bpm);
    expect(stepDone(loadProgress(), lesson, 0, 1)).toBe(false);
    recordResult(lesson, 0, 1, PASS_ACCURACY, step.bpm);
    expect(stepDone(loadProgress(), lesson, 0, 1)).toBe(true);
    // A worse later run does not take the best away.
    recordResult(lesson, 0, 1, 10, step.bpm);
    expect(stepDone(loadProgress(), lesson, 0, 1)).toBe(true);
  });

  it("keeps progress per piece; one finished piece finishes the lesson", () => {
    lesson.steps.forEach((step, i) => recordResult(lesson, 1, i, 95, step.bpm));
    const p = loadProgress();
    expect(pieceDone(p, lesson, 1)).toBe(true);
    expect(pieceDone(p, lesson, 0)).toBe(false);
    expect(lessonDone(p, lesson)).toBe(true);
    expect(firstOpenPiece(p, lesson)).toBe(0);
    expect(firstOpenLesson(p)).toBe(1);
  });

  it("defaults to the first unfinished piece and step", () => {
    recordResult(lesson, 0, 0, 90, lesson.steps[0]!.bpm);
    const p = loadProgress();
    expect(firstOpenPiece(p, lesson)).toBe(0);
    expect(firstOpenStep(p, lesson, 0)).toBe(1);
    expect(firstOpenStep(p, lesson, 2)).toBe(0);
    expect(firstOpenLesson(p)).toBe(0);
  });
});

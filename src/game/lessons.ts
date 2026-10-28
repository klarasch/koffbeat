// The lesson path: an ordered list of lessons, each introducing one idea. Every lesson has a few
// fixed pieces (the same music every time, so there is something to practise), and each piece is
// played in steps that take away help one at a time. Progress (the best accuracy per step of
// each piece) is kept on this device. Pure data and storage; main.ts turns a step into a
// playable level.

import { type Key, t } from "../i18n";
import { generateLevel, tierName } from "../rhythm/generate";
import { generateTwoHandLevel, stageName } from "../rhythm/twoHands";
import type { Hand, Level, Mode } from "../types";

export interface LessonStep {
  /** In the current language (read when shown, so a language switch needs no reload). */
  label: string;
  mode: Mode;
  /** The suggested tempo: a step counts as done only at this tempo or faster. */
  bpm: number;
  /** Play-along: the game plays every note quietly with you (after a first listen). */
  guide?: boolean;
  /** Two-hand lessons: practise this hand alone (the other is played for you). */
  solo?: Hand;
}

export interface Lesson {
  id: string;
  title: string;
  /** One-line reading lessons: the tier whose new idea this lesson introduces. */
  tier: number;
  /** Two-hand lessons: how the hands relate (see TWO_HAND_STAGES). */
  stage?: number;
  /** Bars in each piece; all steps of a lesson play the same piece. */
  bars: 4 | 8 | 16;
  steps: LessonStep[];
}

/** A step counts as done at this accuracy or better. */
export const PASS_ACCURACY = 85;

/** Stages 3 (independence) and 4 (3 against 2) give each hand its own part to learn. */
export function handsAreIndependent(stage: number, cross = false): boolean {
  return stage >= 3 || cross;
}

/** Fixed pieces per lesson. */
export const PIECES = 3;

function step(key: Key, rest: Omit<LessonStep, "label">): LessonStep {
  return {
    get label() {
      return t(key);
    },
    ...rest,
  };
}

const READING_STEPS: LessonStep[] = [
  step("step.learn", { mode: "practice", bpm: 55, guide: true }),
  step("step.practice", { mode: "practice", bpm: 65 }),
  step("step.countIn", { mode: "countIn", bpm: 65 }),
];

/** Hands that play in turn or in unison: nothing to learn hand by hand, so straight to both. */
const SHARED_HANDS_STEPS: LessonStep[] = [
  step("step.learn", { mode: "practice", bpm: 55, guide: true }),
  step("step.together", { mode: "practice", bpm: 60 }),
  step("step.countIn", { mode: "countIn", bpm: 60 }),
];

/** Independent hands: each hand alone first, then together. */
const TWO_HAND_STEPS: LessonStep[] = [
  step("step.right", { mode: "practice", bpm: 55, solo: 1 }),
  step("step.left", { mode: "practice", bpm: 55, solo: 0 }),
  step("step.together", { mode: "practice", bpm: 60 }),
  step("step.countIn", { mode: "countIn", bpm: 60 }),
];

/** Two-hand lessons: each stage with a reading tier the hands are comfortable with by then. */
const TWO_HAND_LESSONS: [stage: number, tier: number][] = [
  [1, 4],
  [2, 4],
  [3, 5],
  [4, 4],
];

export const LESSONS: Lesson[] = [
  ...Array.from({ length: 12 }, (_, i): Lesson => ({
    id: `read-${i + 1}`,
    get title() {
      return tierName(i + 1);
    },
    tier: i + 1,
    bars: 8,
    steps: READING_STEPS,
  })),
  ...TWO_HAND_LESSONS.map(([stage, tier]): Lesson => ({
    id: `hands-${stage}`,
    get title() {
      return t("title.lessonTwoHands", { stage: stageName(stage).toLowerCase() });
    },
    tier,
    stage,
    bars: 4,
    steps: handsAreIndependent(stage) ? TWO_HAND_STEPS : SHARED_HANDS_STEPS,
  })),
];

/**
 * The seed of a piece (0-based): a hash of the lesson id and piece number, so the same piece
 * comes back every time (for as long as the generator itself is unchanged).
 */
export function pieceSeed(lessonId: string, piece: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${lessonId}#${piece + 1}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

/** The notes of a lesson piece at `bpm`; identical for every step of the lesson. */
export function pieceLevel(lesson: Lesson, piece: number, bpm: number): Level {
  const seed = pieceSeed(lesson.id, piece);
  return lesson.stage
    ? generateTwoHandLevel({ stage: lesson.stage, tier: lesson.tier, bars: lesson.bars, bpm, seed })
    : generateLevel({ tier: lesson.tier, bars: lesson.bars, bpm, seed });
}

const PROGRESS_KEY = "resonance.lessonProgress2";

/** Best accuracy per step at the goal tempo: "lessonId/piece" → one number per step (0 = not done). */
export type Progress = Record<string, number[]>;

const progressKey = (lesson: Lesson, piece: number) => `${lesson.id}/${piece}`;

export function loadProgress(): Progress {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Progress) : {};
  } catch {
    return {};
  }
}

/** Does a run at `bpm` count towards the step? Slower than the suggestion shows accuracy only. */
export function countsForStep(step: LessonStep, bpm: number): boolean {
  return bpm >= step.bpm;
}

/** Keeps the best accuracy for a step of a piece, if it was played at the goal tempo or faster. */
export function recordResult(lesson: Lesson, piece: number, stepIndex: number, accuracy: number, bpm: number): void {
  const step = lesson.steps[stepIndex];
  if (!step || !countsForStep(step, bpm)) return;
  const progress = loadProgress();
  const key = progressKey(lesson, piece);
  const steps = progress[key] ?? [];
  steps[stepIndex] = Math.max(steps[stepIndex] ?? 0, Math.round(accuracy));
  progress[key] = steps;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Not persisted; harmless.
  }
}

export function stepDone(progress: Progress, lesson: Lesson, piece: number, stepIndex: number): boolean {
  return (progress[progressKey(lesson, piece)]?.[stepIndex] ?? 0) >= PASS_ACCURACY;
}

/** A piece is finished when all its steps are done. */
export function pieceDone(progress: Progress, lesson: Lesson, piece: number): boolean {
  return lesson.steps.every((_, i) => stepDone(progress, lesson, piece, i));
}

/** A lesson is done when one of its pieces is finished. */
export function lessonDone(progress: Progress, lesson: Lesson): boolean {
  return Array.from({ length: PIECES }, (_, piece) => pieceDone(progress, lesson, piece)).some(Boolean);
}

/** The first piece not yet finished (or the first piece, when all are). */
export function firstOpenPiece(progress: Progress, lesson: Lesson): number {
  const open = Array.from({ length: PIECES }, (_, piece) => piece).find((piece) => !pieceDone(progress, lesson, piece));
  return open ?? 0;
}

/** The first step of a piece not yet done (or the last step, when all are). */
export function firstOpenStep(progress: Progress, lesson: Lesson, piece: number): number {
  const open = lesson.steps.findIndex((_, i) => !stepDone(progress, lesson, piece, i));
  return open === -1 ? lesson.steps.length - 1 : open;
}

/** The first lesson not yet done (or the last lesson, when all are). */
export function firstOpenLesson(progress: Progress): number {
  const open = LESSONS.findIndex((lesson) => !lessonDone(progress, lesson));
  return open === -1 ? LESSONS.length - 1 : open;
}

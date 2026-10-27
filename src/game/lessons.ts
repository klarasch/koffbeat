// The lesson path: an ordered list of lessons, each introducing one idea, each played in a few
// steps that take away help one at a time. Progress (the best accuracy per step) is kept on
// this device. Pure data and storage; main.ts turns a lesson step into a playable level.

import { TIER_NAMES } from "../rhythm/generate";
import { TWO_HAND_STAGES } from "../rhythm/twoHands";
import type { Hand, Mode } from "../types";

export interface LessonStep {
  label: string;
  mode: Mode;
  bpm: number;
  bars: 4 | 8 | 16;
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
  steps: LessonStep[];
}

/** A step counts as done at this accuracy or better. */
export const PASS_ACCURACY = 85;

const READING_STEPS: LessonStep[] = [
  { label: "Learn", mode: "practice", bpm: 55, bars: 4 },
  { label: "Practice", mode: "practice", bpm: 65, bars: 8 },
  { label: "Count-in", mode: "countIn", bpm: 65, bars: 8 },
];

const TWO_HAND_STEPS: LessonStep[] = [
  { label: "Right hand", mode: "practice", bpm: 55, bars: 4, solo: 1 },
  { label: "Left hand", mode: "practice", bpm: 55, bars: 4, solo: 0 },
  { label: "Together", mode: "practice", bpm: 60, bars: 4 },
  { label: "Count-in", mode: "countIn", bpm: 60, bars: 4 },
];

/** Two-hand lessons: each stage with a reading tier the hands are comfortable with by then. */
const TWO_HAND_LESSONS: [stage: number, tier: number][] = [
  [1, 4],
  [2, 4],
  [3, 5],
  [4, 4],
];

export const LESSONS: Lesson[] = [
  ...TIER_NAMES.map((name, i): Lesson => ({ id: `read-${i + 1}`, title: name, tier: i + 1, steps: READING_STEPS })),
  ...TWO_HAND_LESSONS.map(([stage, tier]): Lesson => ({
    id: `hands-${stage}`,
    title: `Two hands: ${TWO_HAND_STAGES[stage - 1]?.toLowerCase()}`,
    tier,
    stage,
    steps: TWO_HAND_STEPS,
  })),
];

const PROGRESS_KEY = "resonance.lessonProgress";

/** Best accuracy per lesson step: lesson id → one number per step (0 = not played). */
export type Progress = Record<string, number[]>;

export function loadProgress(): Progress {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Progress) : {};
  } catch {
    return {};
  }
}

/** Keeps the best accuracy for a lesson step. */
export function recordResult(lessonId: string, stepIndex: number, accuracy: number): void {
  const progress = loadProgress();
  const steps = progress[lessonId] ?? [];
  steps[stepIndex] = Math.max(steps[stepIndex] ?? 0, Math.round(accuracy));
  progress[lessonId] = steps;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Not persisted; harmless.
  }
}

export function stepDone(progress: Progress, lesson: Lesson, stepIndex: number): boolean {
  return (progress[lesson.id]?.[stepIndex] ?? 0) >= PASS_ACCURACY;
}

export function lessonDone(progress: Progress, lesson: Lesson): boolean {
  return lesson.steps.every((_, i) => stepDone(progress, lesson, i));
}

/** The first step not yet done (or the last step, when all are). */
export function firstOpenStep(progress: Progress, lesson: Lesson): number {
  const open = lesson.steps.findIndex((_, i) => !stepDone(progress, lesson, i));
  return open === -1 ? lesson.steps.length - 1 : open;
}

/** The first lesson not yet done (or the last lesson, when all are). */
export function firstOpenLesson(progress: Progress): number {
  const open = LESSONS.findIndex((lesson) => !lessonDone(progress, lesson));
  return open === -1 ? LESSONS.length - 1 : open;
}

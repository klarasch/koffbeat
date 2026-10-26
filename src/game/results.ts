// Builds the results overlay shown after a run: two headline scores, tempo detail, and the
// Retry / Next level / Home actions. Pure DOM builder — timing and judging happen in play.ts.

import type { Grade, Mode, OnsetJudgement, RunResult } from "../types";

export interface ResultsCallbacks {
  onRetry: () => void;
  onNext: () => void;
  onHome: () => void;
}

/**
 * How the tempo *changed during the run* (first bar vs last bar of the player's own pulse) —
 * distinct from how it compared to the count-in target. "steady throughout" below |drift| = 2%,
 * since the drift estimate is noisy at low magnitudes.
 */
export function driftWords(driftPercent: number): string {
  const rounded = Math.round(Math.abs(driftPercent));
  if (rounded < 2) return "steady throughout";
  return driftPercent > 0 ? `you sped up ${rounded}% from start to end` : `you slowed down ${rounded}% from start to end`;
}

/** How the player's average tempo compared to the count-in's target tempo. */
export function tempoVsTargetWords(playedBpm: number, targetBpm: number): string {
  if (targetBpm <= 0) return "";
  const percent = ((playedBpm - targetBpm) / targetBpm) * 100;
  const rounded = Math.round(Math.abs(percent));
  if (rounded < 1) return "right on the count-in tempo";
  return percent > 0 ? `${rounded}% faster than the count-in` : `${rounded}% slower than the count-in`;
}

/** How far from "on the click" a mean signed error has to be to call it out by direction. */
const TIMING_NOTEWORTHY_MEAN_MS = 8;

/**
 * In practice mode a metronome is running throughout, so "tempo steadiness" and "drift" (which
 * describe how the player's *own* pulse wandered) aren't meaningful — the click itself is the
 * reference. This instead describes the player's timing relative to that click: mean signed
 * error (ahead/behind) and its spread (population standard deviation), both in ms.
 */
export function timingVsClickWords(judgements: OnsetJudgement[]): string {
  const errors = judgements.filter((j): j is OnsetJudgement & { strictErrorMs: number } => j.strictErrorMs !== null).map((j) => j.strictErrorMs);
  if (errors.length === 0) return "No taps detected.";

  const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
  const variance = errors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / errors.length;
  const spreadMs = Math.round(Math.sqrt(variance));
  const meanMs = Math.round(Math.abs(mean));

  if (meanMs < TIMING_NOTEWORTHY_MEAN_MS) return `Right on the click, ±${spreadMs} ms`;
  return `You play ${meanMs} ms ${mean > 0 ? "behind" : "ahead of"} the click, ±${spreadMs} ms`;
}

/** A teacher's word for an attack: how early or late, in proportion to the grade. */
export function attackWords(grade: Grade, errorMs: number): string {
  if (grade === "perfect") return "on time";
  const early = errorMs < 0;
  if (grade === "good") return early ? "a touch early" : "a touch late";
  if (grade === "ok") return early ? "early" : "late";
  return early ? "too soon" : "too late";
}

/** A teacher's word for letting go of a long note. */
export function releaseWords(errorMs: number): string {
  return errorMs < 0 ? "let go too soon" : "held too long";
}

const VALUE_NAMES: [number, string][] = [
  [0.25, "sixteenths"],
  [0.5, "eighth notes"],
  [0.75, "dotted eighths"],
  [1, "quarter notes"],
  [1.5, "dotted quarters"],
  [2, "half notes"],
  [3, "dotted halves"],
  [4, "whole notes"],
];

function valueName(quarters: number): string {
  let best = VALUE_NAMES[0]!;
  for (const entry of VALUE_NAMES) if (Math.abs(entry[0] - quarters) < Math.abs(best[0] - quarters)) best = entry;
  return best[1];
}

/** How far off on average (ms, either way) before a habit is worth a teacher's note. */
const HABIT_MS = 35;
const HOLD_HABIT_MS = 150;
/** Two hands: accuracy points between the hands before the weaker one gets a note. */
const HAND_GAP = 12;

/**
 * Up to three short notes a teacher would give after this run: rushing or dragging a note
 * value, cutting long notes short or holding them over, playing into rests, missed notes, and
 * (without a metronome) speeding up or slowing down.
 */
export function teacherNotes(result: RunResult, mode: Mode): string[] {
  const notes: string[] = [];

  // Two hands: when one hand is clearly the weaker, that's the first thing to work on.
  if (result.handAccuracy) {
    const [left, right] = result.handAccuracy;
    if (Math.abs(left - right) >= HAND_GAP) {
      const weak = left < right ? "left" : "right";
      notes.push(`Your ${weak} hand is less sure than your ${weak === "left" ? "right" : "left"}: play its line alone a few times, then put the hands together again.`);
    }
  }
  const played = result.judgements.filter((j) => j.relativeErrorMs !== null);

  // Rushing / dragging, by the note value it shows up on most.
  const byValue = new Map<string, number[]>();
  for (const j of played) {
    const name = valueName(j.onset.quarters);
    const list = byValue.get(name) ?? [];
    list.push(j.relativeErrorMs ?? 0);
    byValue.set(name, list);
  }
  let habit: { name: string; mean: number } | null = null;
  for (const [name, errors] of byValue) {
    if (errors.length < 3) continue;
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    if (Math.abs(mean) >= HABIT_MS && (!habit || Math.abs(mean) > Math.abs(habit.mean))) habit = { name, mean };
  }
  if (habit) notes.push(habit.mean < 0 ? `You rush the ${habit.name}: let them come a little later.` : `You drag the ${habit.name}: move them on a little sooner.`);

  const holds = result.judgements.filter((j) => j.releaseErrorMs !== null && j.releaseGrade !== null);
  if (holds.length >= 2) {
    const mean = holds.reduce((a, j) => a + (j.releaseErrorMs ?? 0), 0) / holds.length;
    if (mean <= -HOLD_HABIT_MS) notes.push("You let the long notes go too soon: hold them for their full length.");
    else if (mean >= HOLD_HABIT_MS) notes.push("You hold the long notes too long: let go as the next beat arrives.");
  }

  const spoiledRests = result.restJudgements.filter((r) => r.grade === "miss").length;
  if (spoiledRests > 0) notes.push(spoiledRests === 1 ? "One rest wasn't silent: keep your hands still through it." : `${spoiledRests} rests weren't silent: keep your hands still through them.`);

  const missed = result.judgements.filter((j) => j.hitTime === null).length;
  if (missed > 0 && notes.length < 3) notes.push(missed === 1 ? "One note was missed." : `${missed} notes were missed: if you lose your place, keep counting and come back in.`);

  if (mode !== "practice" && Math.abs(result.driftPercent) >= 3 && notes.length < 3) {
    notes.push(result.driftPercent > 0 ? `You sped up ${Math.round(result.driftPercent)}% over the piece: keep the count steady.` : `You slowed down ${Math.round(-result.driftPercent)}% over the piece: keep the count steady.`);
  }

  if (notes.length === 0) notes.push(result.accuracy >= 95 ? "Clean playing. Try it a little faster." : "Good. Play it again and aim for every note on the beat.");
  return notes.slice(0, 3);
}

function capitalize(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

/** How far from "on time" (or "predicted end", for a release) a ms error has to be to mention it. */
const NOTEWORTHY_ERROR_MS = 15;

/**
 * Plain-language detail for a note's tooltip, e.g. "Tapped 180 ms late · held 300 ms short".
 * Hold is only ever mentioned for a sustained note (releaseGrade is null for a quarter note or
 * shorter — those are "played" the instant they're tapped, so there's nothing to say about it).
 */
export function describeNoteJudgement(j: OnsetJudgement): string {
  if (j.hitTime === null) return "Not tapped";

  const parts: string[] = [];
  const onsetErr = j.relativeErrorMs ?? 0;
  parts.push(Math.abs(onsetErr) < NOTEWORTHY_ERROR_MS ? "tapped on time" : `tapped ${Math.round(Math.abs(onsetErr))} ms ${onsetErr > 0 ? "late" : "early"}`);

  if (j.releaseGrade !== null && j.releaseErrorMs !== null && j.releaseGrade !== "perfect") {
    const releaseErr = j.releaseErrorMs;
    parts.push(releaseErr < 0 ? `held ${Math.round(Math.abs(releaseErr))} ms short` : `held ${Math.round(Math.abs(releaseErr))} ms long`);
  }

  return capitalize(parts.join(" · "));
}

/** Plain-language detail for a rest's tooltip, e.g. "Rest: you tapped during it". */
export function describeRestJudgement(r: { grade: Grade; reason: string | null }): string {
  if (r.reason) return `Rest: ${r.reason}`;
  return r.grade === "miss" ? "Rest: not clean" : "Rest: held clean";
}

function hitCount(result: RunResult): number {
  return result.judgements.filter((j) => j.hitTime !== null).length;
}

/**
 * `mode` decides what the second score card and the detail line describe: in "practice" a
 * metronome runs throughout, so the player's *own* pulse (tempo steadiness, drift) isn't the
 * interesting number — how they land relative to that click is. In "countIn" (and any other
 * mode without a running metronome) the player's own pulse is all there is to judge, so
 * steadiness and drift are kept.
 */
export function buildResultsPanel(result: RunResult, targetBpm: number, mode: Mode, callbacks: ResultsCallbacks): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "results-panel";

  if (hitCount(result) === 0) {
    const noTaps = document.createElement("p");
    noTaps.className = "results-detail";
    noTaps.textContent = "No taps detected. Try again: tap the lower half of the screen, or press F / J.";
    panel.appendChild(noTaps);
    panel.appendChild(buildButtons(callbacks));
    return panel;
  }

  const grid = document.createElement("div");
  grid.className = "results-grid";

  // Left: the numbers, and how the notes landed.
  const numbers = document.createElement("div");
  numbers.className = "results-numbers";
  const scores = document.createElement("div");
  scores.className = "results-scores";
  scores.appendChild(scoreCard("Rhythm accuracy", result.accuracy));
  if (mode === "practice") scores.appendChild(textCard("Timing vs click", timingVsClickWords(result.judgements)));
  else scores.appendChild(scoreCard("Tempo steadiness", result.steadiness));
  numbers.append(scores, gradeTally(result));
  if (result.handAccuracy) {
    const handsLine = document.createElement("p");
    handsLine.className = "results-detail";
    handsLine.textContent = `Left hand ${Math.round(result.handAccuracy[0])} · right hand ${Math.round(result.handAccuracy[1])}`;
    numbers.appendChild(handsLine);
  }

  // Right: what a teacher would say.
  const advice = document.createElement("div");
  advice.className = "results-advice";
  const adviceLabel = document.createElement("span");
  adviceLabel.className = "option-label";
  adviceLabel.textContent = "Notes";
  const list = document.createElement("ul");
  list.className = "teacher-notes";
  for (const line of teacherNotes(result, mode)) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  advice.append(adviceLabel, list);
  grid.append(numbers, advice);
  panel.appendChild(grid);

  const detail = document.createElement("p");
  detail.className = "results-detail";
  const playedBpm = Math.round(result.playedBpm);
  detail.textContent =
    mode === "practice"
      ? `Played ${playedBpm} bpm, ${tempoVsTargetWords(result.playedBpm, targetBpm)}.`
      : `Played ${playedBpm} bpm, ${tempoVsTargetWords(result.playedBpm, targetBpm)}. ${capitalize(driftWords(result.driftPercent))}.`;
  panel.append(detail, buildButtons(callbacks));
  return panel;
}

/** "14 clean · 3 good · 1 close · 0 missed", each count in its grade colour. */
function gradeTally(result: RunResult): HTMLElement {
  const tally = document.createElement("p");
  tally.className = "grade-tally";
  const counts: Record<Grade, number> = { perfect: 0, good: 0, ok: 0, miss: 0 };
  for (const j of result.judgements) counts[j.hitTime === null ? "miss" : j.grade]++;
  const words: [Grade, string][] = [
    ["perfect", "clean"],
    ["good", "good"],
    ["ok", "close"],
    ["miss", "missed"],
  ];
  for (const [grade, word] of words) {
    const item = document.createElement("span");
    item.className = `tally-item tally-${grade}`;
    item.innerHTML = `<b></b> `;
    (item.firstChild as HTMLElement).textContent = String(counts[grade]);
    item.append(word);
    tally.appendChild(item);
  }
  return tally;
}

/** Shown instead of scores when a run ended early: lost the beat, or stopped with Esc. */
export function buildEndedEarlyPanel(title: string, detail: string, callbacks: ResultsCallbacks): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "results-panel ended-early";
  const heading = document.createElement("p");
  heading.className = "ended-title";
  heading.textContent = title;
  const text = document.createElement("p");
  text.className = "results-detail";
  text.textContent = detail ? `${detail} Try it again, or slow the tempo down on the home screen.` : "";
  panel.append(heading, text, buildButtons(callbacks));
  return panel;
}

function scoreCard(label: string, value: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "score-card";
  const labelEl = document.createElement("p");
  labelEl.className = "score-card-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "score-card-value";
  valueEl.textContent = String(Math.round(value));
  card.append(labelEl, valueEl);
  return card;
}

function textCard(label: string, text: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "score-card";
  const labelEl = document.createElement("p");
  labelEl.className = "score-card-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "score-card-text";
  valueEl.textContent = text;
  card.append(labelEl, valueEl);
  return card;
}

function buildButtons(callbacks: ResultsCallbacks): HTMLElement {
  const row = document.createElement("div");
  row.className = "results-buttons";
  const make = (label: string, key: string, onClick: () => void, primary = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "results-button primary" : "results-button";
    const text = document.createElement("span");
    text.textContent = label;
    const kbd = document.createElement("kbd");
    kbd.className = "kbd";
    kbd.textContent = key;
    button.append(text, kbd);
    button.addEventListener("click", onClick);
    return button;
  };
  row.append(make("Retry", "R", callbacks.onRetry), make("Next level", "↵", callbacks.onNext, true), make("Home", "Esc", callbacks.onHome));
  return row;
}

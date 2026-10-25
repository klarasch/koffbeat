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
    noTaps.textContent = "No taps detected. Try again — tap the lower half of the screen, or press F / J.";
    panel.appendChild(noTaps);
    panel.appendChild(buildButtons(callbacks));
    return panel;
  }

  const scores = document.createElement("div");
  scores.className = "results-scores";
  scores.appendChild(scoreCard("Rhythm accuracy", result.accuracy));
  if (mode === "practice") {
    scores.appendChild(textCard("Timing vs click", timingVsClickWords(result.judgements)));
  } else {
    scores.appendChild(scoreCard("Tempo steadiness", result.steadiness));
  }
  panel.appendChild(scores);

  const detail = document.createElement("p");
  detail.className = "results-detail";
  const playedBpm = Math.round(result.playedBpm);
  detail.textContent =
    mode === "practice"
      ? `Played ${playedBpm} bpm — ${tempoVsTargetWords(result.playedBpm, targetBpm)}.`
      : `Played ${playedBpm} bpm — ${tempoVsTargetWords(result.playedBpm, targetBpm)}. ${capitalize(driftWords(result.driftPercent))}.`;
  panel.appendChild(detail);

  panel.appendChild(buildButtons(callbacks));
  return panel;
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

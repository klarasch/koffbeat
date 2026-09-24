// Builds the results overlay shown after a run: two headline scores, tempo detail, and the
// Retry / Next level / Home actions. Pure DOM builder — timing and judging happen in play.ts.

import type { RunResult } from "../types";

export interface ResultsCallbacks {
  onRetry: () => void;
  onNext: () => void;
  onHome: () => void;
}

/** "you sped up 4%" / "you slowed down 4%" / "you stayed steady", from a signed drift percent. */
export function driftWords(driftPercent: number): string {
  const rounded = Math.round(Math.abs(driftPercent));
  if (rounded < 1) return "you stayed steady";
  return driftPercent > 0 ? `you sped up ${rounded}%` : `you slowed down ${rounded}%`;
}

function hitCount(result: RunResult): number {
  return result.judgements.filter((j) => j.hitTime !== null).length;
}

export function buildResultsPanel(result: RunResult, targetBpm: number, callbacks: ResultsCallbacks): HTMLElement {
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
  scores.appendChild(scoreCard("Tempo steadiness", result.steadiness));
  panel.appendChild(scores);

  const detail = document.createElement("p");
  detail.className = "results-detail";
  const playedBpm = Math.round(result.playedBpm);
  detail.textContent = `Played ${playedBpm} bpm vs ${targetBpm} bpm target — ${driftWords(result.driftPercent)}.`;
  panel.appendChild(detail);

  panel.appendChild(buildButtons(callbacks));
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

function buildButtons(callbacks: ResultsCallbacks): HTMLElement {
  const row = document.createElement("div");
  row.className = "results-buttons";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "results-button";
  retry.textContent = "Retry";
  retry.addEventListener("click", callbacks.onRetry);

  const next = document.createElement("button");
  next.type = "button";
  next.className = "results-button primary";
  next.textContent = "Next level";
  next.addEventListener("click", callbacks.onNext);

  const home = document.createElement("button");
  home.type = "button";
  home.className = "results-button";
  home.textContent = "Home";
  home.addEventListener("click", callbacks.onHome);

  row.append(retry, next, home);
  return row;
}

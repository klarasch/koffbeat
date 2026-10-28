// Builds the results overlay shown after a run: two headline scores, tempo detail, and the
// Retry / next / Home actions. Pure DOM builder — timing and judging happen in play.ts.

import type { Grade, Mode, OnsetJudgement, RunResult } from "../types";
import { stepper } from "./controls";

export interface ResultsCallbacks {
  /** Play the same exercise again, at `bpm` when the player changed it here. */
  onRetry: (bpm?: number) => void;
  /** Move on, at `bpm` when the player changed the tempo here. */
  onNext: (bpm?: number) => void;
  onHome: () => void;
  /** Hear the exercise played correctly. */
  onListen: () => void;
  /** Show the whole piece with every note marked by how it went. */
  onReview?: () => void;
}

/** The tempo the exercise was played at (Retry can change it) and the main action's label. */
export interface RetryOptions {
  bpm: number;
  nextLabel?: string;
  /** A lesson step: the tempo and accuracy it takes to pass. */
  goal?: { bpm: number; pass: number };
  /** Which action is the big one: another go (default), or moving on. */
  primary?: "retry" | "next";
}

/**
 * For a lesson step played slower than its goal tempo: whether it passed is plain to see, but it
 * doesn't count until it's played at the goal. Null when played at the goal or faster.
 */
export function goalNote(accuracy: number, playedBpm: number, goal: { bpm: number; pass: number }): string | null {
  if (playedBpm >= goal.bpm) return null;
  return accuracy >= goal.pass ? `Passed at ${playedBpm} bpm. The goal is ${goal.bpm}.` : `Not passed yet at ${playedBpm} bpm. The goal is ${goal.bpm}.`;
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
 * Plain-language detail for a note's tooltip, e.g. "Tapped 180 ms late, held 300 ms short".
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

  return capitalize(parts.join(", "));
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
export function buildResultsPanel(result: RunResult, targetBpm: number, mode: Mode, callbacks: ResultsCallbacks, retry?: RetryOptions): HTMLElement {
  if (hitCount(result) === 0) {
    const noTaps = document.createElement("p");
    noTaps.className = "results-detail";
    const touch = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;
    noTaps.textContent = touch ? "No taps detected. Try again: tap the lower half of the screen." : "No taps detected. Try again: tap the lower half of the screen, or press F / J.";
    return bentoPanel([cell([noTaps])], buildButtons(callbacks, retry));
  }

  // The two headline numbers side by side.
  const second = mode === "practice" ? textCard("Timing vs click", timingVsClickWords(result.judgements)) : scoreCard("Tempo steadiness", result.steadiness);
  const scores = document.createElement("div");
  scores.className = "bento-row";
  scores.append(cell([scoreCard("Rhythm accuracy", result.accuracy)]), cell([second]));

  // How the notes landed.
  const counts: HTMLElement[] = [gradeTally(result)];
  if (result.handAccuracy) {
    const handsLine = document.createElement("p");
    handsLine.className = "results-detail";
    handsLine.textContent = `Left hand ${Math.round(result.handAccuracy[0])}, right hand ${Math.round(result.handAccuracy[1])}`;
    counts.push(handsLine);
  }

  // What a teacher would say, and the way to see it on the music.
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
  const advice: HTMLElement[] = [adviceLabel, list];
  if (callbacks.onReview) {
    const review = document.createElement("button");
    review.type = "button";
    review.className = "review-link";
    review.textContent = "See where it went";
    review.addEventListener("click", callbacks.onReview);
    advice.push(review);
  }

  // The tempo it was played at.
  const detail = document.createElement("p");
  detail.className = "results-detail";
  const playedBpm = Math.round(result.playedBpm);
  detail.textContent =
    mode === "practice"
      ? `Played ${playedBpm} bpm, ${tempoVsTargetWords(result.playedBpm, targetBpm)}.`
      : `Played ${playedBpm} bpm, ${tempoVsTargetWords(result.playedBpm, targetBpm)}. ${capitalize(driftWords(result.driftPercent))}.`;
  const tempo: HTMLElement[] = [detail];
  if (mode !== "practice" && result.tempoByBar) {
    const chart = tempoChart(result.tempoByBar, targetBpm);
    if (chart) tempo.push(chart);
  }
  const goal = retry?.goal ? goalNote(result.accuracy, retry.bpm, retry.goal) : null;
  if (goal) {
    const goalLine = document.createElement("p");
    goalLine.className = "results-detail goal-note";
    goalLine.textContent = goal;
    tempo.push(goalLine);
  }
  return bentoPanel([scores, cell(counts), cell(advice, "bento-grow"), cell(tempo)], buildButtons(callbacks, retry));
}

/** One cell of the results block. */
function cell(children: HTMLElement[], extraClass = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `bento-cell ${extraClass}`.trim();
  el.append(...children);
  return el;
}

/**
 * The results as one ruled block (a "bento"): glass over the sand, a hairline around it and
 * between the cells, and the actions as its last row. Only the cells scroll; the actions stay put.
 */
function bentoPanel(cells: HTMLElement[], actions: HTMLElement, extraClass = ""): HTMLElement {
  const panel = document.createElement("div");
  panel.className = `results-panel ${extraClass}`.trim();
  const bento = document.createElement("div");
  bento.className = "bento";
  const scroll = document.createElement("div");
  scroll.className = "bento-scroll";
  scroll.append(...cells);
  actions.classList.add("bento-cell");
  bento.append(scroll, actions);
  panel.appendChild(bento);
  return panel;
}

/** "14 clean, 3 good, 1 close, 0 missed", each count in its grade colour. */
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
export function buildEndedEarlyPanel(title: string, detail: string, callbacks: ResultsCallbacks, retry?: RetryOptions): HTMLElement {
  const heading = document.createElement("p");
  heading.className = "ended-title";
  heading.textContent = title;
  const text = document.createElement("p");
  text.className = "results-detail";
  text.textContent = detail ? `${detail} Try it again, maybe a little slower, or hear it played first.` : "";
  return bentoPanel([cell([heading, text], "bento-grow")], buildButtons(callbacks, retry), "ended-early");
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

/** A secondary action: a quiet word, with its key shown on keyboards. */
function actionButton(label: string, key: string, onClick: () => void, extraClass = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `results-button ${extraClass}`.trim();
  const text = document.createElement("span");
  text.textContent = label;
  const kbd = document.createElement("kbd");
  kbd.className = "kbd";
  kbd.textContent = key;
  button.append(text, kbd);
  button.addEventListener("click", onClick);
  return button;
}

/** The main action, written like home's Play: a big word, and an arrow when it moves on. */
function mainButton(label: string, key: string, arrow: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "results-main";
  button.innerHTML = `<span class="results-main-word"></span><kbd class="kbd"></kbd>${arrow ? `<span class="results-main-arrow" aria-hidden="true">→</span>` : ""}`;
  (button.firstChild as HTMLElement).textContent = label;
  (button.children[1] as HTMLElement).textContent = key;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * The actions bar. First what applies to every choice (the tempo) and the side actions, then
 * the main action, big, with the other way on beside it.
 */
function actionsBar(main: HTMLButtonElement, other: HTMLButtonElement | null, top: HTMLElement[]): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "results-buttons";
  const topRow = document.createElement("div");
  topRow.className = "results-secondary";
  topRow.append(...top);
  const mainRow = document.createElement("div");
  mainRow.className = "results-main-row";
  mainRow.append(main);
  if (other) {
    other.classList.add("results-other");
    mainRow.append(other);
  }
  bar.append(topRow, mainRow);
  return bar;
}

function buildButtons(callbacks: ResultsCallbacks, retry?: RetryOptions): HTMLElement {
  // The tempo comes first: Retry and the next exercise both start at it.
  let bpm = retry?.bpm ?? 0;
  const original = bpm;
  const top: HTMLElement[] = [];
  const tempoGroup = document.createElement("div");
  tempoGroup.className = "retry-group";
  if (retry) {
    const tempo = stepper(
      (delta) => {
        bpm = Math.max(40, Math.min(200, bpm + delta * 5));
        paint();
      },
      () => {
        bpm = original;
        paint();
      },
      { less: "Slower", more: "Faster", reset: "Back to the tempo you played" },
    );
    tempo.el.classList.add("retry-tempo");
    const paint = () => {
      tempo.setText(`${bpm} bpm`, bpm !== original);
      tempoGroup.dataset.retryBpm = String(bpm);
    };
    paint();
    tempoGroup.appendChild(tempo.el);
    top.push(tempoGroup);
  }
  top.push(actionButton("Hear it", "H", callbacks.onListen), actionButton("Home", "Esc", callbacks.onHome, "home-action"));

  const doRetry = () => callbacks.onRetry(retry ? bpm : undefined);
  const doNext = () => callbacks.onNext(retry && bpm !== original ? bpm : undefined);
  const nextLabel = retry?.nextLabel ?? "Next level";
  // Moving on is the main action only once a lesson step is passed; otherwise it's another go.
  if (retry?.primary === "next") {
    return actionsBar(mainButton(nextLabel, "↵", true, doNext), actionButton("Retry", "R", doRetry), top);
  }
  return actionsBar(mainButton("Retry", "↵", false, doRetry), actionButton(`${nextLabel} →`, "N", doNext), top);
}

/** After listening to the exercise: the player's turn next. */
export function buildListenedPanel(callbacks: { onPlay: () => void; onListen: () => void; onHome: () => void }): HTMLElement {
  const heading = document.createElement("p");
  heading.className = "ended-title";
  heading.textContent = "Your turn";
  const text = document.createElement("p");
  text.className = "results-detail";
  text.textContent = "That's how it goes. Now play it yourself, or hear it once more.";
  const bar = actionsBar(mainButton("Play it", "↵", true, callbacks.onPlay), null, [actionButton("Hear again", "H", callbacks.onListen), actionButton("Home", "Esc", callbacks.onHome, "home-action")]);
  return bentoPanel([cell([heading, text], "bento-grow")], bar, "ended-early");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The tempo the player kept in each bar, as a line against the count-in tempo (dashed), so
 * rushing, dragging and wavering can be seen. Null when fewer than two bars have a tempo.
 */
export function tempoChart(tempoByBar: (number | null)[], targetBpm: number): HTMLElement | null {
  const known = tempoByBar.filter((b): b is number => b !== null);
  if (known.length < 2) return null;
  const W = 300;
  const H = 64;
  const PAD = 6;
  // At least ±10% around the target is shown, so a steady run looks flat rather than magnified.
  const lo = Math.min(targetBpm * 0.9, ...known) * 0.98;
  const hi = Math.max(targetBpm * 1.1, ...known) * 1.02;
  const x = (bar: number) => PAD + (tempoByBar.length === 1 ? 0 : (bar / (tempoByBar.length - 1)) * (W - 2 * PAD));
  const y = (bpm: number) => PAD + (1 - (bpm - lo) / (hi - lo)) * (H - 2 * PAD);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "tempo-chart-plot");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Tempo by bar: ${tempoByBar.map((b) => (b === null ? "unknown" : Math.round(b))).join(", ")} bpm`);

  const target = document.createElementNS(SVG_NS, "line");
  target.setAttribute("x1", "0");
  target.setAttribute("x2", String(W));
  target.setAttribute("y1", String(y(targetBpm)));
  target.setAttribute("y2", String(y(targetBpm)));
  target.setAttribute("class", "tempo-chart-target");
  svg.appendChild(target);

  // Bars without a tempo break the line rather than bridging the gap.
  let segment: string[] = [];
  const flush = () => {
    if (segment.length > 1) {
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("points", segment.join(" "));
      line.setAttribute("class", "tempo-chart-line");
      svg.appendChild(line);
    }
    segment = [];
  };
  tempoByBar.forEach((bpm, bar) => {
    if (bpm === null) return flush();
    segment.push(`${x(bar).toFixed(1)},${y(bpm).toFixed(1)}`);
  });
  flush();

  const wrap = document.createElement("div");
  wrap.className = "tempo-chart";
  const label = document.createElement("span");
  label.className = "option-label";
  label.textContent = "Your tempo, bar by bar";
  const plot = document.createElement("div");
  plot.className = "tempo-chart-area";
  plot.appendChild(svg);
  // Dots as HTML, so they stay round however the plot is stretched.
  tempoByBar.forEach((bpm, bar) => {
    if (bpm === null) return;
    const dot = document.createElement("span");
    dot.className = "tempo-chart-dot";
    dot.style.left = `${(x(bar) / W) * 100}%`;
    dot.style.top = `${(y(bpm) / H) * 100}%`;
    dot.title = `Bar ${bar + 1}: ${Math.round(bpm)} bpm`;
    plot.appendChild(dot);
  });
  const axis = document.createElement("div");
  axis.className = "tempo-chart-axis";
  const first = document.createElement("span");
  first.textContent = `bar 1: ${Math.round(known[0]!)}`;
  const mid = document.createElement("span");
  mid.textContent = `dashed: ${targetBpm} bpm`;
  const last = document.createElement("span");
  last.textContent = `bar ${tempoByBar.length}: ${Math.round(known[known.length - 1]!)}`;
  axis.append(first, mid, last);
  wrap.append(label, plot, axis);
  return wrap;
}

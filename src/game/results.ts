// Builds the results overlay shown after a run: two headline scores, tempo detail, and the
// Retry / next / Home actions. Pure DOM builder — timing and judging happen in play.ts.

import { kbd, setTextWithKeys } from "../ui/keys";
import { type Key, t } from "../i18n";
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
  /** Free practice with the metronome: the same exercise again with only a count-in. */
  onCountIn?: (bpm?: number) => void;
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
  return t(accuracy >= goal.pass ? "res.passed" : "res.notPassed", { played: playedBpm, goal: goal.bpm });
}

/**
 * How the tempo *changed during the run* (first bar vs last bar of the player's own pulse) —
 * distinct from how it compared to the count-in target. "steady throughout" below |drift| = 2%,
 * since the drift estimate is noisy at low magnitudes.
 */
export function driftWords(driftPercent: number): string {
  const rounded = Math.round(Math.abs(driftPercent));
  if (rounded < 2) return t("res.steady");
  return t(driftPercent > 0 ? "res.spedUp" : "res.slowedDown", { n: rounded });
}

/** How the player's average tempo compared to the count-in's target tempo. */
export function tempoVsTargetWords(playedBpm: number, targetBpm: number): string {
  if (targetBpm <= 0) return "";
  const percent = ((playedBpm - targetBpm) / targetBpm) * 100;
  const rounded = Math.round(Math.abs(percent));
  if (rounded < 1) return t("res.onCountIn");
  return t(percent > 0 ? "res.fasterThanCountIn" : "res.slowerThanCountIn", { n: rounded });
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
  if (errors.length === 0) return t("res.noTapsShort");

  const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
  const variance = errors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / errors.length;
  const spreadMs = Math.round(Math.sqrt(variance));
  const meanMs = Math.round(Math.abs(mean));

  if (meanMs < TIMING_NOTEWORTHY_MEAN_MS) return t("res.onClick", { spread: spreadMs });
  return t(mean > 0 ? "res.behind" : "res.ahead", { ms: meanMs, spread: spreadMs });
}

/** A teacher's word for an attack: how early or late, in proportion to the grade. */
export function attackWords(grade: Grade, errorMs: number): string {
  if (grade === "perfect") return t("attack.onTime");
  const early = errorMs < 0;
  if (grade === "good") return t(early ? "attack.touchEarly" : "attack.touchLate");
  if (grade === "ok") return t(early ? "attack.early" : "attack.late");
  return t(early ? "attack.tooSoon" : "attack.tooLate");
}

/** A teacher's word for letting go of a long note. */
export function releaseWords(errorMs: number): string {
  return t(errorMs < 0 ? "release.soon" : "release.long");
}

/** Note values in quarters; the names are the `value.<quarters>` strings. */
const VALUE_QUARTERS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

/** The key of the note value nearest `quarters`. */
function valueKey(quarters: number): string {
  let best: number = VALUE_QUARTERS[0];
  for (const q of VALUE_QUARTERS) if (Math.abs(q - quarters) < Math.abs(best - quarters)) best = q;
  return String(best);
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
      notes.push(t("note.weakHand", { weak }));
    }
  }
  const played = result.judgements.filter((j) => j.relativeErrorMs !== null);

  // Rushing / dragging, by the note value it shows up on most.
  const byValue = new Map<string, number[]>();
  for (const j of played) {
    const name = valueKey(j.onset.quarters);
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
  if (habit) notes.push(t(habit.mean < 0 ? "note.rush" : "note.drag", { name: t(`value.${habit.name}` as Key) }));

  const holds = result.judgements.filter((j) => j.releaseErrorMs !== null && j.releaseGrade !== null);
  if (holds.length >= 2) {
    const mean = holds.reduce((a, j) => a + (j.releaseErrorMs ?? 0), 0) / holds.length;
    if (mean <= -HOLD_HABIT_MS) notes.push(t("note.holdSoon"));
    else if (mean >= HOLD_HABIT_MS) notes.push(t("note.holdLong"));
  }

  const spoiledRests = result.restJudgements.filter((r) => r.grade === "miss").length;
  if (spoiledRests > 0) notes.push(spoiledRests === 1 ? t("note.restOne") : t("note.restMany", { n: spoiledRests }));

  const missed = result.judgements.filter((j) => j.hitTime === null).length;
  if (missed > 0 && notes.length < 3) notes.push(missed === 1 ? t("note.missedOne") : t("note.missedMany", { n: missed }));

  if (mode !== "practice" && Math.abs(result.driftPercent) >= 3 && notes.length < 3) {
    notes.push(result.driftPercent > 0 ? t("note.spedUp", { n: Math.round(result.driftPercent) }) : t("note.slowedDown", { n: Math.round(-result.driftPercent) }));
  }

  if (notes.length === 0) notes.push(t(result.accuracy >= 95 ? "note.clean" : "note.good"));
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
  if (j.hitTime === null) return t("tip.notTapped");

  const parts: string[] = [];
  const onsetErr = j.relativeErrorMs ?? 0;
  parts.push(Math.abs(onsetErr) < NOTEWORTHY_ERROR_MS ? t("tip.onTime") : t(onsetErr > 0 ? "tip.late" : "tip.early", { ms: Math.round(Math.abs(onsetErr)) }));

  if (j.releaseGrade !== null && j.releaseErrorMs !== null && j.releaseGrade !== "perfect") {
    const releaseErr = j.releaseErrorMs;
    parts.push(t(releaseErr < 0 ? "tip.short" : "tip.long", { ms: Math.round(Math.abs(releaseErr)) }));
  }

  return capitalize(parts.join(", "));
}

/** Plain-language detail for a rest's tooltip, e.g. "Rest: you tapped during it". */
export function describeRestJudgement(r: { grade: Grade; reason: string | null }): string {
  // The judge words its reasons in English; map the known ones to the current language.
  const reason = r.reason === "you tapped during it" ? t("tip.restTapped") : r.reason === "held through it" ? t("tip.restHeld") : r.reason;
  if (reason) return t("tip.rest", { reason });
  return t(r.grade === "miss" ? "tip.restNotClean" : "tip.restClean");
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
    setTextWithKeys(noTaps, t(touch ? "res.noTapsTouch" : "res.noTapsKeys"));
    return bentoPanel([cell([noTaps])], buildButtons(callbacks, retry));
  }

  // The two headline numbers side by side.
  const second = mode === "practice" ? textCard(t("res.timingVsClick"), timingVsClickWords(result.judgements)) : scoreCard(t("res.steadiness"), result.steadiness, { verdict: t(steadinessVerdictKey(result.steadiness)), caption: t("res.steadinessCaption") });
  const scores = document.createElement("div");
  scores.className = "bento-row";
  scores.append(cell([scoreCard(t("res.accuracy"), result.accuracy)]), cell([second]));

  // How the notes landed.
  const counts: HTMLElement[] = [gradeTally(result)];
  if (result.handAccuracy) {
    const handsLine = document.createElement("p");
    handsLine.className = "results-detail";
    handsLine.textContent = t("res.handsLine", { left: Math.round(result.handAccuracy[0]), right: Math.round(result.handAccuracy[1]) });
    counts.push(handsLine);
  }

  // What a teacher would say, and the way to see it on the music.
  const adviceLabel = document.createElement("span");
  adviceLabel.className = "option-label";
  adviceLabel.textContent = t("res.notes");
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
    review.textContent = t("res.review");
    review.addEventListener("click", callbacks.onReview);
    advice.push(review);
  }

  // The tempo it was played at.
  const detail = document.createElement("p");
  detail.className = "results-detail";
  const playedBpm = Math.round(result.playedBpm);
  const played = t("res.played", { bpm: playedBpm, vs: tempoVsTargetWords(result.playedBpm, targetBpm) });
  detail.textContent = mode === "practice" ? played : `${played} ${capitalize(driftWords(result.driftPercent))}.`;
  const tempo: HTMLElement[] = [detail];
  if (mode !== "practice" && result.tempoByBar) {
    const chart = tempoChart(result.tempoByBar, targetBpm);
    if (chart) {
      tempo.push(chart);
      const chartNote = document.createElement("p");
      chartNote.className = "results-detail chart-caption";
      chartNote.textContent = t("res.chartCaption");
      tempo.push(chartNote);
    }
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
  watchScrollHint(scroll);
  actions.classList.add("bento-cell");
  bento.append(scroll, actions);
  panel.appendChild(bento);
  return panel;
}

/** Marks the scroll area with `more-below` while content is hidden under its bottom edge (drives the fade). */
function watchScrollHint(scroll: HTMLElement): void {
  const update = (): void => {
    scroll.classList.toggle("more-below", scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2);
  };
  scroll.addEventListener("scroll", update, { passive: true });
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(update);
    ro.observe(scroll);
    for (const child of Array.from(scroll.children)) ro.observe(child);
  }
  window.addEventListener("resize", update);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
}

/** i18n key of the one-word verdict on a tempo steadiness score. */
export function steadinessVerdictKey(score: number): "res.steadyHigh" | "res.steadyMid" | "res.steadyLow" {
  return score >= 90 ? "res.steadyHigh" : score >= 75 ? "res.steadyMid" : "res.steadyLow";
}

/** "14 clean, 3 good, 1 close, 0 missed", each count in its grade colour. */
function gradeTally(result: RunResult): HTMLElement {
  const tally = document.createElement("p");
  tally.className = "grade-tally";
  const counts: Record<Grade, number> = { perfect: 0, good: 0, ok: 0, miss: 0 };
  for (const j of result.judgements) counts[j.hitTime === null ? "miss" : j.grade]++;
  const words: [Grade, string][] = [
    ["perfect", t("res.tallyClean")],
    ["good", t("res.tallyGood")],
    ["ok", t("res.tallyClose")],
    ["miss", t("res.tallyMissed")],
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
  text.textContent = detail ? `${detail}${t("ended.tryAgain")}` : "";
  return bentoPanel([cell([heading, text], "bento-grow")], buildButtons(callbacks, retry), "ended-early");
}

function scoreCard(label: string, value: number, extra?: { verdict?: string; caption?: string }): HTMLElement {
  const card = document.createElement("div");
  card.className = "score-card";
  const labelEl = document.createElement("p");
  labelEl.className = "score-card-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "score-card-value";
  valueEl.textContent = String(Math.round(value));
  card.append(labelEl, valueEl);
  if (extra?.verdict) {
    const verdictEl = document.createElement("p");
    verdictEl.className = "score-card-verdict";
    verdictEl.textContent = extra.verdict;
    card.appendChild(verdictEl);
  }
  if (extra?.caption) {
    const captionEl = document.createElement("p");
    captionEl.className = "results-detail";
    captionEl.textContent = extra.caption;
    card.appendChild(captionEl);
  }
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
  button.append(text, kbd(key));
  button.addEventListener("click", onClick);
  return button;
}

/** The main action, written like home's Play: a big word, and an arrow when it moves on. */
function mainButton(label: string, key: string, arrow: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "results-main";
  button.innerHTML = `<span class="results-main-word"></span>${arrow ? `<span class="results-main-arrow" aria-hidden="true">→</span>` : ""}`;
  (button.firstChild as HTMLElement).textContent = label;
  button.insertBefore(kbd(key, "kbd-big"), button.children[1] ?? null);
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
      { less: t("home.slower"), more: t("home.faster"), reset: t("res.backToPlayed") },
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
  top.push(actionButton(t("res.hearIt"), "H", callbacks.onListen));
  const onCountIn = callbacks.onCountIn;
  if (onCountIn) top.push(actionButton(t("res.withCountIn"), "C", () => onCountIn(retry ? bpm : undefined), "count-in-action"));
  top.push(actionButton(t("res.home"), "Esc", callbacks.onHome, "home-action"));

  const doRetry = () => callbacks.onRetry(retry ? bpm : undefined);
  const doNext = () => callbacks.onNext(retry && bpm !== original ? bpm : undefined);
  const nextLabel = retry?.nextLabel ?? t("next.level");
  // Moving on is the main action only once a lesson step is passed; otherwise it's another go.
  if (retry?.primary === "next") {
    return actionsBar(mainButton(nextLabel, "↵", true, doNext), actionButton(t("res.retry"), "R", doRetry), top);
  }
  return actionsBar(mainButton(t("res.retry"), "↵", false, doRetry), actionButton(`${nextLabel} →`, "N", doNext), top);
}

/** After listening to the exercise: the player's turn next. */
export function buildListenedPanel(callbacks: { onPlay: () => void; onListen: () => void; onHome: () => void }): HTMLElement {
  const heading = document.createElement("p");
  heading.className = "ended-title";
  heading.textContent = t("res.yourTurn");
  const text = document.createElement("p");
  text.className = "results-detail";
  text.textContent = t("res.yourTurnText");
  const bar = actionsBar(mainButton(t("res.playIt"), "↵", true, callbacks.onPlay), null, [actionButton(t("res.hearAgain"), "H", callbacks.onListen), actionButton(t("res.home"), "Esc", callbacks.onHome, "home-action")]);
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
  svg.setAttribute("aria-label", t("chart.aria", { list: tempoByBar.map((b) => (b === null ? t("chart.unknown") : Math.round(b))).join(", ") }));

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
  label.textContent = t("chart.title");
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
    dot.title = t("chart.dot", { bar: bar + 1, bpm: Math.round(bpm) });
    plot.appendChild(dot);
  });
  const axis = document.createElement("div");
  axis.className = "tempo-chart-axis";
  const first = document.createElement("span");
  first.textContent = t("chart.first", { bpm: Math.round(known[0]!) });
  const mid = document.createElement("span");
  mid.textContent = t("chart.dashed", { bpm: targetBpm });
  const last = document.createElement("span");
  last.textContent = t("chart.last", { bar: tempoByBar.length, bpm: Math.round(known[known.length - 1]!) });
  axis.append(first, mid, last);
  wrap.append(label, plot, axis);
  return wrap;
}

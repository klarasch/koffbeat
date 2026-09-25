import type { AudioEngine } from "../audio/engine";
import { attachInput } from "./input";

/** Result of matching tapped times against the click grid used to elicit them. */
export interface CalibrationResult {
  /** Median signed error (tap − nearest click), in seconds. Subtract this from future taps. */
  offsetSec: number;
  /** Interquartile range of the matched errors, in milliseconds (lower = more consistent). */
  spreadMs: number;
  /** True when enough usable taps were collected and they were consistent enough to trust. */
  ok: boolean;
}

const LOCAL_STORAGE_KEY = "resonance.latencyOffset";
/** Taps whose error to the nearest click exceeds this are discarded as mis-taps, not latency. */
const OUTLIER_THRESHOLD_SEC = 0.25;
/** Minimum number of usable (non-outlier, post-warmup) taps required to trust the result. */
const MIN_USABLE_TAPS = 6;
/** Maximum IQR, in ms, for the result to be considered reliable. */
const MAX_SPREAD_MS = 60;
/** Number of leading taps dropped as "finding the beat" warmup. */
const WARMUP_TAPS_DROPPED = 2;

/**
 * Pure calibration math: matches each tap to its nearest click, drops warmup taps and outliers,
 * and summarizes the remaining errors as a median offset plus an IQR spread.
 */
export function computeOffset(tapTimes: number[], clickTimes: number[]): CalibrationResult {
  if (clickTimes.length === 0 || tapTimes.length <= WARMUP_TAPS_DROPPED) {
    return { offsetSec: 0, spreadMs: 0, ok: false };
  }

  const sortedClicks = [...clickTimes].sort((a, b) => a - b);
  const warmedUpTaps = tapTimes.slice(WARMUP_TAPS_DROPPED);

  const errors: number[] = [];
  for (const tap of warmedUpTaps) {
    const nearestClick = findNearest(sortedClicks, tap);
    const error = tap - nearestClick;
    if (Math.abs(error) <= OUTLIER_THRESHOLD_SEC) {
      errors.push(error);
    }
  }

  if (errors.length < MIN_USABLE_TAPS) {
    return { offsetSec: 0, spreadMs: 0, ok: false };
  }

  errors.sort((a, b) => a - b);
  const offsetSec = median(errors);
  const spreadMs = iqr(errors) * 1000;
  const ok = errors.length >= MIN_USABLE_TAPS && spreadMs < MAX_SPREAD_MS;

  return { offsetSec, spreadMs, ok };
}

/** Binary-search nearest-value lookup in a sorted array. */
function findNearest(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midValue = sorted[mid] as number;
    if (midValue === value) {
      return midValue;
    }
    if (midValue < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const candidate = sorted[lo] as number;
  const prevCandidate = sorted[lo - 1];
  if (prevCandidate === undefined) {
    return candidate;
  }
  return Math.abs(prevCandidate - value) <= Math.abs(candidate - value) ? prevCandidate : candidate;
}

/** Assumes `sorted` is already sorted ascending. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] as number;
    const b = sorted[mid] as number;
    return (a + b) / 2;
  }
  return sorted[mid] as number;
}

/** Interquartile range (Q3 − Q1) of an already-sorted array, using linear interpolation. */
function iqr(sorted: number[]): number {
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return q3 - q1;
}

/** Assumes `sorted` is already sorted ascending. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) {
    return sorted[0] as number;
  }
  const position = q * (sorted.length - 1);
  const base = Math.floor(position);
  const rest = position - base;
  const lower = sorted[base] as number;
  const upper = sorted[base + 1];
  if (upper === undefined) {
    return lower;
  }
  return lower + rest * (upper - lower);
}

/** Loads the saved latency offset (seconds), defaulting to 0 if unset or unavailable. */
export function loadOffset(): number {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw === null) {
      return 0;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Persists the latency offset (seconds). Silently no-ops if storage is unavailable. */
export function saveOffset(sec: number): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, String(sec));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — calibration just won't persist.
  }
}

const CALIBRATION_BPM = 90;
const CALIBRATION_CLICK_COUNT = 16;
const SECONDS_PER_BEAT = 60 / CALIBRATION_BPM;

/**
 * Renders a minimal calibration UI into `container`, runs the tap-along test, and resolves
 * with the offset once the user saves it (or with the previously saved offset if they skip).
 */
export function runCalibration(engine: AudioEngine, container: HTMLElement): Promise<number> {
  return new Promise((resolve) => {
    container.innerHTML = "";
    applyContainerStyles(container);

    const heading = document.createElement("h2");
    heading.textContent = "Latency calibration";
    heading.style.margin = "0 0 8px";

    const explanation = document.createElement("p");
    explanation.textContent = "Tap along with the clicks on the pad (or F / J on a keyboard). This measures your device’s audio delay so your taps are judged fairly.";
    explanation.style.margin = "0 0 20px";
    explanation.style.opacity = "0.85";

    const statusLine = document.createElement("p");
    statusLine.style.minHeight = "1.2em";
    statusLine.style.margin = "0 0 20px";

    const startButton = createButton("Start");
    const skipButton = createButton("Skip for now");
    skipButton.style.marginLeft = "12px";
    skipButton.style.opacity = "0.7";

    // Taps go to their own pad. Reusing the Start button as the tap target meant every tap also
    // "clicked" Start, restarting the round on top of the one still playing.
    const tapPad = document.createElement("div");
    tapPad.textContent = "Tap here";
    tapPad.style.display = "none";
    tapPad.style.alignItems = "center";
    tapPad.style.justifyContent = "center";
    tapPad.style.height = "40vh";
    tapPad.style.margin = "0 0 20px";
    tapPad.style.borderRadius = "16px";
    tapPad.style.background = "#161a22";
    tapPad.style.border = "1px solid #2a303c";
    tapPad.style.fontSize = "18px";
    tapPad.style.letterSpacing = "0.08em";

    const resultBox = document.createElement("div");
    resultBox.style.display = "none";

    const resultText = document.createElement("p");
    const retryButton = createButton("Retry");
    const saveButton = createButton("Save");
    saveButton.style.marginLeft = "12px";
    const skipAfterButton = createButton("Skip");
    skipAfterButton.style.marginLeft = "12px";
    skipAfterButton.style.opacity = "0.7";

    resultBox.appendChild(resultText);
    resultBox.appendChild(retryButton);
    resultBox.appendChild(saveButton);
    resultBox.appendChild(skipAfterButton);

    const startRow = document.createElement("div");
    startRow.appendChild(startButton);
    startRow.appendChild(skipButton);

    container.appendChild(heading);
    container.appendChild(explanation);
    container.appendChild(statusLine);
    container.appendChild(tapPad);
    container.appendChild(startRow);
    container.appendChild(resultBox);

    let lastOffsetSec = 0;
    let detach: (() => void) | null = null;
    let running = false;

    startButton.addEventListener("click", () => {
      if (running) return;
      void startRound();
    });

    const skip = (): void => {
      if (running) return;
      // Saving marks calibration as done, so it isn't forced again; the home screen link reruns it.
      const offset = loadOffset();
      saveOffset(offset);
      resolve(offset);
    };
    skipButton.addEventListener("click", skip);
    skipAfterButton.addEventListener("click", skip);

    retryButton.addEventListener("click", () => {
      resultBox.style.display = "none";
      startRow.style.display = "block";
      statusLine.textContent = "";
    });

    saveButton.addEventListener("click", () => {
      saveOffset(lastOffsetSec);
      resolve(lastOffsetSec);
    });

    async function startRound(): Promise<void> {
      running = true;
      startRow.style.display = "none";
      resultBox.style.display = "none";
      statusLine.textContent = "Get ready...";

      await engine.unlock();

      const clickTimes: number[] = [];
      const tapTimes: number[] = [];

      tapPad.style.display = "flex";
      detach = attachInput(tapPad, engine, (hit) => tapTimes.push(hit.time), () => 0);

      const startTime = engine.now() + 0.8;
      for (let i = 0; i < CALIBRATION_CLICK_COUNT; i++) {
        const clickTime = startTime + i * SECONDS_PER_BEAT;
        clickTimes.push(clickTime);
        engine.scheduleClick(clickTime, i % 4 === 0);
      }

      statusLine.textContent = "Tap along with the clicks...";

      const totalDurationSec = startTime - engine.now() + CALIBRATION_CLICK_COUNT * SECONDS_PER_BEAT + 0.3;
      await wait(totalDurationSec);

      detach();
      detach = null;
      tapPad.style.display = "none";
      running = false;

      const result = computeOffset(tapTimes, clickTimes);
      lastOffsetSec = result.ok ? result.offsetSec : loadOffset();

      const offsetMs = Math.round(result.offsetSec * 1000);
      statusLine.textContent = "";
      resultText.textContent = result.ok
        ? `Your device latency: ${Math.abs(offsetMs)} ms ${offsetMs >= 0 ? "(taps landed late)" : "(taps landed early)"}`
        : `Not enough consistent taps (${tapTimes.length} taps, spread ${Math.round(result.spreadMs)} ms). Try again, or skip for now.`;
      resultBox.style.display = "block";
      saveButton.style.display = result.ok ? "inline-block" : "none";
    }
  });
}

function applyContainerStyles(container: HTMLElement): void {
  container.style.background = "#0b0d12";
  container.style.color = "#e8e4da";
  container.style.fontFamily = "system-ui, sans-serif";
  container.style.padding = "24px";
  container.style.borderRadius = "8px";
  container.style.textAlign = "center";
}

function createButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.type = "button";
  button.style.background = "#e8e4da";
  button.style.color = "#0b0d12";
  button.style.border = "none";
  button.style.borderRadius = "6px";
  button.style.padding = "12px 24px";
  button.style.fontSize = "16px";
  button.style.cursor = "pointer";
  return button;
}

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

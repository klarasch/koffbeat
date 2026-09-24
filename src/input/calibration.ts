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
    explanation.textContent = "Tap along with the clicks, in time, using the button below (or F / J on a keyboard).";
    explanation.style.margin = "0 0 20px";
    explanation.style.opacity = "0.85";

    const statusLine = document.createElement("p");
    statusLine.style.minHeight = "1.2em";
    statusLine.style.margin = "0 0 20px";

    const startButton = createButton("Start");
    const resultBox = document.createElement("div");
    resultBox.style.display = "none";

    const resultText = document.createElement("p");
    const retryButton = createButton("Retry");
    const saveButton = createButton("Save");
    saveButton.style.marginLeft = "12px";

    resultBox.appendChild(resultText);
    resultBox.appendChild(retryButton);
    resultBox.appendChild(saveButton);

    container.appendChild(heading);
    container.appendChild(explanation);
    container.appendChild(statusLine);
    container.appendChild(startButton);
    container.appendChild(resultBox);

    let lastOffsetSec = 0;
    let detach: (() => void) | null = null;

    startButton.addEventListener("click", () => {
      void startRound();
    });

    retryButton.addEventListener("click", () => {
      resultBox.style.display = "none";
      startButton.style.display = "inline-block";
      statusLine.textContent = "";
    });

    saveButton.addEventListener("click", () => {
      saveOffset(lastOffsetSec);
      if (detach) {
        detach();
        detach = null;
      }
      resolve(lastOffsetSec);
    });

    async function startRound(): Promise<void> {
      startButton.style.display = "none";
      resultBox.style.display = "none";
      statusLine.textContent = "Get ready...";

      await engine.unlock();

      const clickTimes: number[] = [];
      const tapTimes: number[] = [];

      if (detach) {
        detach();
        detach = null;
      }
      detach = attachInput(
        startButton,
        engine,
        (hit) => {
          tapTimes.push(hit.time);
        },
        () => 0,
      );

      const startTime = engine.now() + 0.5;
      for (let i = 0; i < CALIBRATION_CLICK_COUNT; i++) {
        const clickTime = startTime + i * SECONDS_PER_BEAT;
        clickTimes.push(clickTime);
        engine.scheduleClick(clickTime, i % 4 === 0);
      }

      statusLine.textContent = "Tap along...";
      startButton.style.display = "inline-block";
      startButton.textContent = "Tap here";

      const totalDurationSec = startTime - engine.now() + CALIBRATION_CLICK_COUNT * SECONDS_PER_BEAT + 0.3;
      await wait(totalDurationSec);

      if (detach) {
        detach();
        detach = null;
      }
      startButton.style.display = "none";
      startButton.textContent = "Start";

      const result = computeOffset(tapTimes, clickTimes);
      lastOffsetSec = result.ok ? result.offsetSec : loadOffset();

      const offsetMs = Math.round(result.offsetSec * 1000);
      statusLine.textContent = "";
      resultText.textContent = result.ok
        ? `Your device latency: ${Math.abs(offsetMs)} ms ${offsetMs >= 0 ? "(taps landed late)" : "(taps landed early)"}`
        : `Not enough consistent taps (spread ${Math.round(result.spreadMs)} ms). Try tapping steadily on the beat.`;
      resultBox.style.display = "block";
      saveButton.disabled = !result.ok;
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

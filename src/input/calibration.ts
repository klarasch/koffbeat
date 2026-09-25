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
const OUTLIER_THRESHOLD_SEC = 0.3;
/** Minimum number of usable (non-outlier, post-warmup) taps required to trust the result. */
const MIN_USABLE_TAPS = 6;
/** Maximum IQR, in ms, for the result to be considered reliable. */
const MAX_SPREAD_MS = 80;
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
const SECONDS_PER_BEAT = 60 / CALIBRATION_BPM;
const BEATS_PER_BAR = 4;
/** One listening bar, then up to ~29 s of tapping before giving up. */
const MAX_BARS = 12;
/** The round ends as soon as this many recent taps are consistent (computeOffset drops 2 as warmup). */
const TAPS_NEEDED = 10;

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

    const progress = document.createElement("div");
    progress.style.display = "flex";
    progress.style.justifyContent = "center";
    progress.style.gap = "8px";
    progress.style.margin = "0 0 16px";
    const progressDots: HTMLElement[] = [];
    for (let i = 0; i < TAPS_NEEDED; i++) {
      const dot = document.createElement("span");
      dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#2a303c;transition:background 120ms;";
      progress.appendChild(dot);
      progressDots.push(dot);
    }
    progress.style.visibility = "hidden";
    container.insertBefore(progress, tapPad);

    /**
     * One bar of counted clicks, then clicks continue until the latest TAPS_NEEDED taps are
     * consistent — so it doesn't matter when the player starts tapping.
     */
    async function startRound(): Promise<void> {
      running = true;
      startRow.style.display = "none";
      resultBox.style.display = "none";
      statusLine.textContent = "Listen…";

      await engine.unlock();

      const startTime = engine.now() + 0.6;
      const clickTimes: number[] = [];
      for (let i = 0; i < MAX_BARS * BEATS_PER_BAR; i++) clickTimes.push(startTime + i * SECONDS_PER_BEAT);
      const tappingFrom = startTime + (BEATS_PER_BAR - 0.5) * SECONDS_PER_BEAT;
      const endTime = startTime + MAX_BARS * BEATS_PER_BAR * SECONDS_PER_BEAT;

      /** Taps that land near a click after the listening bar. */
      const usableTaps: number[] = [];
      tapPad.style.display = "flex";
      progress.style.visibility = "visible";
      progressDots.forEach((dot) => {
        dot.style.background = "#2a303c";
      });
      detach = attachInput(
        tapPad,
        engine,
        (hit) => {
          if (hit.time < tappingFrom) return;
          const nearest = clickTimes.reduce((best, c) => (Math.abs(c - hit.time) < Math.abs(best - hit.time) ? c : best), Number.POSITIVE_INFINITY);
          if (Math.abs(hit.time - nearest) <= OUTLIER_THRESHOLD_SEC) usableTaps.push(hit.time);
        },
        () => 0,
        // Calibration only measures attack (tap) latency; releases aren't part of this test.
        () => {},
      );

      engine.startMetronome(startTime, SECONDS_PER_BEAT, BEATS_PER_BAR, MAX_BARS);

      let result: CalibrationResult = { offsetSec: 0, spreadMs: 0, ok: false };
      await new Promise<void>((done) => {
        const timer = setInterval(() => {
          const t = engine.now();
          const beat = Math.floor((t - startTime) / SECONDS_PER_BEAT);
          if (beat < BEATS_PER_BAR) {
            statusLine.textContent = beat < 0 ? "Listen…" : `Listen…  ${BEATS_PER_BAR - beat}`;
          } else if (usableTaps.length < TAPS_NEEDED) {
            statusLine.textContent = usableTaps.length === 0 ? "Tap along whenever you’re ready" : "Keep tapping on the beat";
          } else {
            statusLine.textContent = "Keep it steady…";
          }
          const recent = usableTaps.slice(-TAPS_NEEDED);
          progressDots.forEach((dot, i) => {
            dot.style.background = i < recent.length ? "#7fe0c4" : "#2a303c";
          });
          if (recent.length >= TAPS_NEEDED) result = computeOffset(recent, clickTimes);
          if (result.ok || t >= endTime) {
            clearInterval(timer);
            done();
          }
        }, 50);
      });

      engine.stopAll();
      if (detach) detach();
      detach = null;
      tapPad.style.display = "none";
      progress.style.visibility = "hidden";
      running = false;

      lastOffsetSec = result.ok ? result.offsetSec : loadOffset();
      const offsetMs = Math.round(result.offsetSec * 1000);
      statusLine.textContent = "";
      resultText.textContent = result.ok
        ? `Your device latency: ${Math.abs(offsetMs)} ms ${offsetMs >= 0 ? "(taps landed late)" : "(taps landed early)"}`
        : usableTaps.length < TAPS_NEEDED
          ? `Only ${usableTaps.length} taps landed near the clicks. Try again, or skip for now.`
          : `Taps weren’t steady enough yet (spread ${Math.round(result.spreadMs)} ms). Try again, or skip for now.`;
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

import type { AudioEngine } from "../audio/engine";
import { t } from "../i18n";
import { attachInput } from "./input";
import { setTextWithKeys } from "../ui/keys";

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
    container.classList.add("cal");

    const label = document.createElement("p");
    label.className = "cal-label";
    label.textContent = t("cal.label");

    const heading = document.createElement("h1");
    heading.className = "cal-heading";
    heading.textContent = t("cal.heading");

    const explanation = document.createElement("p");
    explanation.className = "cal-text";
    setTextWithKeys(explanation, t("cal.text"));

    const statusLine = document.createElement("p");
    statusLine.className = "cal-status";

    const startButton = createButton(t("cal.start"), "primary");
    const skipButton = createButton(t("cal.skipForNow"), "secondary");
    // While a round runs, the only way out: stops it and leaves calibration.
    const cancelButton = createButton(t("cal.cancel"), "secondary");
    const cancelRow = document.createElement("div");
    cancelRow.className = "cal-actions";
    cancelRow.append(cancelButton);
    cancelRow.hidden = true;

    // Taps go to their own pad. Reusing the Start button as the tap target meant every tap also
    // "clicked" Start, restarting the round on top of the one still playing.
    const tapPad = document.createElement("div");
    tapPad.className = "cal-pad";
    tapPad.textContent = t("cal.pad");
    tapPad.hidden = true;

    const resultBox = document.createElement("div");
    resultBox.className = "cal-result";
    resultBox.hidden = true;
    const resultNumber = document.createElement("p");
    resultNumber.className = "cal-number";
    const resultText = document.createElement("p");
    resultText.className = "cal-text";
    const saveButton = createButton(t("cal.save"), "primary");
    const retryButton = createButton(t("cal.retry"), "secondary");
    const skipAfterButton = createButton(t("cal.skip"), "secondary");
    const resultActions = document.createElement("div");
    resultActions.className = "cal-actions";
    resultActions.append(saveButton, retryButton, skipAfterButton);
    resultBox.append(resultNumber, resultText, resultActions);

    const startRow = document.createElement("div");
    startRow.className = "cal-actions";
    startRow.append(startButton, skipButton);

    // Ten slim bars that fill as steady taps land.
    const progress = document.createElement("div");
    progress.className = "cal-progress";
    progress.hidden = true;
    const progressBars: HTMLElement[] = [];
    for (let i = 0; i < TAPS_NEEDED; i++) {
      const bar = document.createElement("span");
      progress.appendChild(bar);
      progressBars.push(bar);
    }

    container.append(label, heading, explanation, statusLine, progress, tapPad, cancelRow, startRow, resultBox);

    let lastOffsetSec = 0;
    let detach: (() => void) | null = null;
    let running = false;
    /** Set by Cancel (or Escape) to end the running round early. */
    let cancelled = false;

    startButton.addEventListener("click", () => {
      if (running) return;
      void startRound();
    });

    const skip = (): void => {
      if (running) return;
      // Saving marks calibration as done, so it isn't forced again; the home screen link reruns it.
      const offset = loadOffset();
      saveOffset(offset);
      finish(offset);
    };
    skipButton.addEventListener("click", skip);
    skipAfterButton.addEventListener("click", skip);
    const cancel = (): void => {
      if (running) cancelled = true;
      else skip();
    };
    cancelButton.addEventListener("click", cancel);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);

    retryButton.addEventListener("click", () => {
      resultBox.hidden = true;
      startRow.hidden = false;
      statusLine.textContent = "";
    });

    saveButton.addEventListener("click", () => {
      saveOffset(lastOffsetSec);
      finish(lastOffsetSec);
    });

    function finish(offset: number): void {
      window.removeEventListener("keydown", onKey);
      container.classList.remove("cal");
      resolve(offset);
    }

    /**
     * One bar of counted clicks, then clicks continue until the latest TAPS_NEEDED taps are
     * consistent — so it doesn't matter when the player starts tapping.
     */
    async function startRound(): Promise<void> {
      running = true;
      cancelled = false;
      startRow.hidden = true;
      cancelRow.hidden = false;
      resultBox.hidden = true;
      statusLine.textContent = t("cal.listen");

      await engine.unlock();

      const startTime = engine.now() + 0.6;
      const clickTimes: number[] = [];
      for (let i = 0; i < MAX_BARS * BEATS_PER_BAR; i++) clickTimes.push(startTime + i * SECONDS_PER_BEAT);
      const tappingFrom = startTime + (BEATS_PER_BAR - 0.5) * SECONDS_PER_BEAT;
      const endTime = startTime + MAX_BARS * BEATS_PER_BAR * SECONDS_PER_BEAT;

      /** Taps that land near a click after the listening bar. */
      const usableTaps: number[] = [];
      tapPad.hidden = false;
      progress.hidden = false;
      progressBars.forEach((bar) => bar.classList.remove("on"));
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
          const now = engine.now();
          const beat = Math.floor((now - startTime) / SECONDS_PER_BEAT);
          if (beat < BEATS_PER_BAR) {
            statusLine.textContent = beat < 0 ? t("cal.listen") : t("cal.listenN", { n: BEATS_PER_BAR - beat });
          } else if (usableTaps.length < TAPS_NEEDED) {
            statusLine.textContent = usableTaps.length === 0 ? t("cal.tapWhenReady") : t("cal.keepTapping");
          } else {
            statusLine.textContent = t("cal.keepSteady");
          }
          const recent = usableTaps.slice(-TAPS_NEEDED);
          progressBars.forEach((bar, i) => bar.classList.toggle("on", i < recent.length));
          if (recent.length >= TAPS_NEEDED) result = computeOffset(recent, clickTimes);
          if (result.ok || now >= endTime || cancelled) {
            clearInterval(timer);
            done();
          }
        }, 50);
      });

      engine.stopAll();
      if (detach) detach();
      detach = null;
      tapPad.hidden = true;
      progress.hidden = true;
      cancelRow.hidden = true;
      running = false;
      if (cancelled) {
        skip();
        return;
      }

      lastOffsetSec = result.ok ? result.offsetSec : loadOffset();
      const offsetMs = Math.round(result.offsetSec * 1000);
      statusLine.textContent = "";
      resultNumber.textContent = result.ok ? `${Math.abs(offsetMs)} ms` : t("cal.notYet");
      resultText.textContent = result.ok
        ? t("cal.resultOk", { when: t(offsetMs >= 0 ? "cal.delayLate" : "cal.delayEarly") })
        : usableTaps.length < TAPS_NEEDED
          ? t("cal.fewTaps", { n: usableTaps.length })
          : t("cal.unsteady", { ms: Math.round(result.spreadMs) });
      resultBox.hidden = false;
      saveButton.hidden = !result.ok;
    }
  });
}

function createButton(label: string, kind: "primary" | "secondary"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cal-button ${kind}`;
  button.textContent = label;
  return button;
}

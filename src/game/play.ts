// The play screen: staff + count-in + tap area, driven by requestAnimationFrame reading the
// audio clock (never setTimeout for anything musical), ending in the results overlay.

import type { AudioEngine } from "../audio/engine";
import { loadOffset } from "../input/calibration";
import { attachInput } from "../input/input";
import { renderStaff } from "../notation/staff";
import { createLiveJudge, judgeRun } from "../rhythm/judge";
import { levelOnsets } from "../rhythm/onsets";
import type { Grade, Hit, Level, Mode } from "../types";
import { buildResultsPanel } from "./results";

export interface PlayCallbacks {
  onHome: () => void;
  onRetry: () => void;
  onNext: () => void;
}

/** How long after the count-in's last click ends do we still accept hits, in quarter notes. */
const END_MARGIN_QUARTERS = 2;
/** countIn mode has no metronome to anchor the player, so give a more generous end margin. */
const END_MARGIN_QUARTERS_COUNT_IN = 3;
/** Lead-in before the count-in's first click, in seconds — gives the scheduler headroom. */
const LEAD_IN_SEC = 0.3;
const GRADE_FLASH_MS = 260;

export function startPlay(container: HTMLElement, engine: AudioEngine, level: Level, mode: Mode, callbacks: PlayCallbacks): void {
  container.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "play-screen";

  const scene = document.createElement("div");
  scene.id = "scene";
  screen.appendChild(scene);

  const topbar = document.createElement("div");
  topbar.className = "play-topbar";
  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "home-button";
  homeButton.textContent = "Home";
  topbar.appendChild(homeButton);
  screen.appendChild(topbar);

  const dotsRow = document.createElement("div");
  dotsRow.className = "count-in-dots";
  const dots: HTMLDivElement[] = [];
  for (let i = 0; i < level.meter.beats; i++) {
    const dot = document.createElement("div");
    dot.className = "count-in-dot";
    dots.push(dot);
    dotsRow.appendChild(dot);
  }
  screen.appendChild(dotsRow);

  const staffArea = document.createElement("div");
  staffArea.className = "staff-area";
  const staffContainer = document.createElement("div");
  staffContainer.className = "staff-container";
  staffArea.appendChild(staffContainer);
  screen.appendChild(staffArea);

  const tapArea = document.createElement("div");
  tapArea.className = "tap-area";
  const zoneLeft = document.createElement("div");
  zoneLeft.className = "tap-zone tap-zone-left";
  const zoneLeftLabel = document.createElement("span");
  zoneLeftLabel.className = "tap-zone-label";
  zoneLeftLabel.textContent = "Tap";
  zoneLeft.appendChild(zoneLeftLabel);
  const zoneRight = document.createElement("div");
  zoneRight.className = "tap-zone tap-zone-right";
  const zoneRightLabel = document.createElement("span");
  zoneRightLabel.className = "tap-zone-label";
  zoneRightLabel.textContent = "Tap";
  zoneRight.appendChild(zoneRightLabel);
  tapArea.append(zoneLeft, zoneRight);
  screen.appendChild(tapArea);

  const gradeFlash = document.createElement("div");
  gradeFlash.className = "grade-flash";
  screen.appendChild(gradeFlash);

  const resultsOverlay = document.createElement("div");
  resultsOverlay.className = "results-overlay";
  resultsOverlay.hidden = true;
  screen.appendChild(resultsOverlay);

  container.appendChild(screen);

  const staff = renderStaff(staffContainer, level, { theme: "dark" });
  const onsets = levelOnsets(level);

  const secPerQuarter = 60 / level.bpm;
  const beatsPerBar = level.meter.beats;
  const startTime = engine.now() + beatsPerBar * secPerQuarter + LEAD_IN_SEC;
  const firstClickTime = engine.scheduleCountIn(startTime, beatsPerBar, secPerQuarter);

  if (mode === "practice") {
    engine.startMetronome(startTime, secPerQuarter, level.meter.beats, level.bars.length);
  }

  const offsetSec = loadOffset();
  const liveJudge = createLiveJudge(onsets, startTime, level.bpm);
  const hits: Hit[] = [];
  let matchedCount = 0;
  let ended = false;
  let rafId = 0;
  let flashTimeout: ReturnType<typeof setTimeout> | null = null;
  // countIn mode: no nominally-timed cursor, it jumps to the last-hit onset instead.
  let countInCursorBeat: number | null = null;

  const lastOnset = onsets[onsets.length - 1];
  const lastBeat = lastOnset ? lastOnset.beat : 0;
  const endMarginQuarters = mode === "countIn" ? END_MARGIN_QUARTERS_COUNT_IN : END_MARGIN_QUARTERS;
  const endTime = startTime + lastBeat * secPerQuarter + endMarginQuarters * secPerQuarter;

  function showGradeFlash(grade: Grade): void {
    gradeFlash.textContent = grade;
    gradeFlash.className = `grade-flash grade-${grade} show`;
    if (flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => {
      gradeFlash.classList.remove("show");
    }, GRADE_FLASH_MS);
  }

  function handleHit(hit: Hit): void {
    hits.push(hit);
    const judged = liveJudge.judgeHit(hit);
    if (judged.onsetIndex === null || judged.grade === null) return;

    matchedCount++;
    const onset = onsets[judged.onsetIndex];
    if (onset) {
      staff.mark(onset.eventIndex, judged.grade);
      if (mode === "countIn") {
        countInCursorBeat = onset.beat;
        staff.setCursor(onset.beat);
      }
    }
    showGradeFlash(judged.grade);
  }

  const detachInput = attachInput(tapArea, engine, handleHit, () => offsetSec);

  function updateCountInDots(t: number): void {
    for (let i = 0; i < dots.length; i++) {
      const clickTime = firstClickTime + i * secPerQuarter;
      const dot = dots[i];
      if (dot) dot.classList.toggle("lit", t >= clickTime);
    }
  }

  function updateCursor(t: number): void {
    if (mode === "practice") {
      staff.setCursor(t < startTime ? null : (t - startTime) / secPerQuarter);
      return;
    }
    if (countInCursorBeat !== null) staff.setCursor(countInCursorBeat);
  }

  function tick(): void {
    if (ended) return;
    const t = engine.now();

    updateCountInDots(t);
    updateCursor(t);

    if (matchedCount >= onsets.length || t >= endTime) {
      finish();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function teardown(): void {
    ended = true;
    cancelAnimationFrame(rafId);
    engine.stopAll();
    detachInput();
    if (flashTimeout) clearTimeout(flashTimeout);
  }

  function finish(): void {
    if (ended) return;
    teardown();

    const result = judgeRun(onsets, startTime, level.bpm, hits);
    staff.clearMarks();
    for (const judgement of result.judgements) {
      staff.mark(judgement.onset.eventIndex, judgement.grade);
    }
    staff.setCursor(null);

    // The last in-run grade flash (e.g. "PERFECT") must not linger once results are shown.
    gradeFlash.classList.remove("show");

    // The results panel replaces the tap area (which is no longer needed) rather than
    // overlaying the whole screen, so the staff with its final grade marks stays fully visible.
    tapArea.hidden = true;

    resultsOverlay.innerHTML = "";
    resultsOverlay.appendChild(
      buildResultsPanel(result, level.bpm, {
        onRetry: callbacks.onRetry,
        onNext: callbacks.onNext,
        onHome: callbacks.onHome,
      }),
    );
    resultsOverlay.hidden = false;
  }

  homeButton.addEventListener("click", () => {
    teardown();
    callbacks.onHome();
  });

  rafId = requestAnimationFrame(tick);
}

// The play screen: staff + count-in + tap area, driven by requestAnimationFrame reading the
// audio clock (never setTimeout for anything musical), ending in the results overlay. Notes are
// shown karaoke-style (upcoming/next/active/graded) rather than with a moving playhead — nothing
// on screen advances at the nominal tempo, only when the player actually plays.

import type { AudioEngine } from "../audio/engine";
import { loadOffset } from "../input/calibration";
import { attachInput } from "../input/input";
import { type NoteState, renderStaff } from "../notation/staff";
import { combineGrades, createLiveJudge, judgeRun } from "../rhythm/judge";
import { levelOnsets, restSpans } from "../rhythm/onsets";
import type { Grade, Hit, Level, Mode, Release, RunResult } from "../types";
import { buildResultsPanel, describeNoteJudgement, describeRestJudgement } from "./results";

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

/** True when event `index` ties into the next event (continuation, not a new sound). */
function flattenTieFlags(level: Level): boolean[] {
  const flags: boolean[] = [];
  for (const bar of level.bars) {
    for (const event of bar) {
      flags.push(event.tie === true && !event.rest);
    }
  }
  return flags;
}

/** Every event index in the tied chain starting at `startIndex` (just itself, when not tied). */
function tieChainIndices(tieFlags: boolean[], startIndex: number): number[] {
  const indices = [startIndex];
  let i = startIndex;
  while (tieFlags[i]) {
    i += 1;
    indices.push(i);
  }
  return indices;
}

interface TimelineNote {
  kind: "note";
  onsetIndex: number;
  beat: number;
  eventIndices: number[];
}
interface TimelineRest {
  kind: "rest";
  restIndex: number;
  beat: number;
  eventIndex: number;
}
type TimelineItem = TimelineNote | TimelineRest;

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
  const rests = restSpans(level);
  const tieFlags = flattenTieFlags(level);

  // The played sequence, in beat order: karaoke state (upcoming/next/active/graded) advances
  // through this list only when the player actually plays, never with the clock.
  const timeline: TimelineItem[] = [
    ...onsets.map((onset, onsetIndex): TimelineNote => ({ kind: "note", onsetIndex, beat: onset.beat, eventIndices: tieChainIndices(tieFlags, onset.eventIndex) })),
    ...rests.map((rest, restIndex): TimelineRest => ({ kind: "rest", restIndex, beat: rest.beat, eventIndex: rest.eventIndex })),
  ].sort((a, b) => a.beat - b.beat);
  const timelineIndexForOnset = new Map<number, number>();
  timeline.forEach((item, i) => {
    if (item.kind === "note") timelineIndexForOnset.set(item.onsetIndex, i);
  });

  function setTimelineState(item: TimelineItem, state: NoteState): void {
    if (item.kind === "note") {
      for (const eventIndex of item.eventIndices) staff.setState(eventIndex, state);
    } else {
      staff.setState(item.eventIndex, state);
    }
  }

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
  const releases: Release[] = [];
  let matchedCount = 0;
  let ended = false;
  let rafId = 0;
  let flashTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastResult: RunResult | null = null;
  let tooltipEl: HTMLDivElement | null = null;

  let nextPointer = 0;
  if (timeline.length > 0) {
    const first = timeline[0];
    // Before the run starts, the staff is shown from its first system (revealEvent(0) is a
    // no-op here since scrollTop already starts at 0, but this keeps the "position drives the
    // view" invariant explicit rather than relying on the initial scroll position).
    if (first) {
      setTimelineState(first, "next");
      staff.revealEvent(primaryEventIndex(first));
    }
  }

  const lastOnset = onsets[onsets.length - 1];
  const lastBeat = lastOnset ? lastOnset.beat + lastOnset.quarters : 0;
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

  function markSkippedAsMiss(fromIndex: number, toIndexExclusive: number): void {
    for (let i = fromIndex; i < toIndexExclusive; i++) {
      const item = timeline[i];
      if (item) setTimelineState(item, "miss");
    }
  }

  /** The event index that best represents a timeline item's on-screen position (a tie chain's first note). */
  function primaryEventIndex(item: TimelineItem): number {
    return item.kind === "note" ? (item.eventIndices[0] ?? item.onsetIndex) : item.eventIndex;
  }

  function setNext(index: number): void {
    nextPointer = index;
    const item = timeline[nextPointer];
    if (item) {
      setTimelineState(item, "next");
      staff.revealEvent(primaryEventIndex(item));
    }
  }

  /** After a note (at `timelineIndex`) gets its final release grade, advance the "next" pointer past it. */
  function advanceAfterRelease(timelineIndex: number, releaseGrade: Grade | null): void {
    const afterIndex = timelineIndex + 1;
    const afterItem = timeline[afterIndex];
    // The note bled well past its own release window into the rest that follows: the rest is
    // already spoiled, so grade and skip it immediately rather than waiting on the next press.
    if (afterItem && afterItem.kind === "rest" && releaseGrade === "miss") {
      setTimelineState(afterItem, "miss");
      setNext(afterIndex + 1);
      return;
    }
    setNext(afterIndex);
  }

  function finalizeRelease(onsetIndex: number, combinedGrade: Grade | null, releaseGrade: Grade | null): void {
    const timelineIndex = timelineIndexForOnset.get(onsetIndex);
    if (timelineIndex === undefined) return;
    const item = timeline[timelineIndex];
    if (item) setTimelineState(item, combinedGrade ?? "miss");
    advanceAfterRelease(timelineIndex, releaseGrade);
  }

  function handleHit(hit: Hit): void {
    hits.push(hit);

    // A held note in this zone with no explicit release yet (typically a keyboard key still
    // down) is implicitly released the moment a new press happens.
    const implicit = liveJudge.implicitRelease(hit.zone, hit.time);
    if (implicit.onsetIndex !== null) finalizeRelease(implicit.onsetIndex, implicit.combinedGrade, implicit.releaseGrade);

    const judged = liveJudge.judgeHit(hit);
    if (judged.onsetIndex === null || judged.grade === null) {
      // An unmatched press while a rest is the current target means the rest wasn't silent.
      const current = timeline[nextPointer];
      if (current && current.kind === "rest") setTimelineState(current, "miss");
      return;
    }

    matchedCount++;
    const timelineIndex = timelineIndexForOnset.get(judged.onsetIndex);
    if (timelineIndex !== undefined) {
      if (timelineIndex > nextPointer) markSkippedAsMiss(nextPointer, timelineIndex);
      nextPointer = timelineIndex;
      const item = timeline[timelineIndex];
      if (item) {
        setTimelineState(item, "active");
        staff.revealEvent(primaryEventIndex(item));
      }
    }
    showGradeFlash(judged.grade);
  }

  function handleRelease(release: Release): void {
    releases.push(release);
    const result = liveJudge.judgeRelease(release);
    if (result.onsetIndex !== null) finalizeRelease(result.onsetIndex, result.combinedGrade, result.releaseGrade);
  }

  const detachInput = attachInput(tapArea, engine, handleHit, () => offsetSec, handleRelease);

  function updateCountInDots(t: number): void {
    for (let i = 0; i < dots.length; i++) {
      const clickTime = firstClickTime + i * secPerQuarter;
      const dot = dots[i];
      if (dot) dot.classList.toggle("lit", t >= clickTime);
    }
  }

  function tick(): void {
    if (ended) return;
    const t = engine.now();

    updateCountInDots(t);

    if (matchedCount >= onsets.length || t >= endTime) {
      finish();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function hideTooltip(): void {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  function showTooltip(clientX: number, clientY: number, text: string): void {
    hideTooltip();
    const rect = staffArea.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = "note-tooltip";
    el.textContent = text;
    el.style.left = `${clientX - rect.left}px`;
    el.style.top = `${clientY - rect.top - 10}px`;
    staffArea.appendChild(el);
    tooltipEl = el;
  }

  function handleStaffTap(clientX: number, clientY: number): void {
    if (!ended || !lastResult) return;
    const eventIndex = staff.eventAt(clientX, clientY);
    if (eventIndex === null) {
      hideTooltip();
      return;
    }
    const noteJudgement = lastResult.judgements.find((j) => tieChainIndices(tieFlags, j.onset.eventIndex).includes(eventIndex));
    if (noteJudgement) {
      showTooltip(clientX, clientY, describeNoteJudgement(noteJudgement));
      return;
    }
    const restJudgement = lastResult.restJudgements.find((r) => r.eventIndex === eventIndex);
    if (restJudgement) {
      showTooltip(clientX, clientY, describeRestJudgement(restJudgement));
    }
  }

  staffContainer.addEventListener("pointerdown", (e) => handleStaffTap(e.clientX, e.clientY));

  function logDebugTable(result: RunResult): void {
    const rows = result.judgements.map((j) => ({
      beat: j.onset.beat,
      errorMs: j.relativeErrorMs === null ? null : Math.round(j.relativeErrorMs),
      releaseErrorMs: j.releaseErrorMs === null ? null : Math.round(j.releaseErrorMs),
    }));
    console.debug("resonance: per-note results", rows);
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

    const result = judgeRun(onsets, rests, startTime, level.bpm, hits, releases);
    lastResult = result;
    logDebugTable(result);

    staff.clearMarks();
    // The player reviews the whole staff after a run — let them scroll it freely, rather than
    // only the current line as during play.
    staff.setScrollable(true);
    for (const judgement of result.judgements) {
      const combined = combineGrades(judgement.grade, judgement.releaseGrade);
      for (const eventIndex of tieChainIndices(tieFlags, judgement.onset.eventIndex)) staff.setState(eventIndex, combined);
    }
    for (const restJudgement of result.restJudgements) {
      staff.setState(restJudgement.eventIndex, restJudgement.grade);
    }

    // The last in-run grade flash (e.g. "PERFECT") must not linger once results are shown.
    gradeFlash.classList.remove("show");

    // The results panel replaces the tap area (which is no longer needed) rather than
    // overlaying the whole screen, so the staff with its final grade marks stays fully visible.
    tapArea.hidden = true;

    resultsOverlay.innerHTML = "";
    resultsOverlay.appendChild(
      buildResultsPanel(result, level.bpm, mode, {
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

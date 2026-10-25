// The play screen: staff + count-in + tap area, driven by requestAnimationFrame reading the
// audio clock (never setTimeout for anything musical), ending in the results overlay. Notes are
// shown karaoke-style (upcoming/next/active/graded) rather than with a moving playhead — nothing
// on screen advances at the nominal tempo, only when the player actually plays.

import type { AudioEngine } from "../audio/engine";
import { loadOffset } from "../input/calibration";
import { attachInput } from "../input/input";
import { type NoteState, renderStaff } from "../notation/staff";
import { combineGrades, createLiveJudge, judgeRun, releaseWindowMs, SUSTAINED_MIN_QUARTERS } from "../rhythm/judge";
import type { HoldState, Scene } from "../scene/resonance";
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
const GRADE_FLASH_MS = 420;
/** Each 4-bar phrase draws the sand toward a new figure. */
const BARS_PER_FIGURE = 4;
const GRADE_VALUE: Record<Grade, number> = { perfect: 1, good: 0.85, ok: 0.55, miss: 0 };

/** A stable small integer from a level id, so a level always starts on the same figure. */
function figureSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 12;
}

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

export function startPlay(container: HTMLElement, engine: AudioEngine, scene: Scene, level: Level, mode: Mode, callbacks: PlayCallbacks): void {
  container.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "play-screen";

  const topbar = document.createElement("div");
  topbar.className = "play-topbar";
  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "home-button";
  homeButton.setAttribute("aria-label", "Home");
  homeButton.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const titleEl = document.createElement("div");
  titleEl.className = "play-title";
  titleEl.innerHTML = `<span class="play-title-name"></span><span class="play-title-meta"></span>`;
  (titleEl.firstChild as HTMLElement).textContent = level.title;
  (titleEl.lastChild as HTMLElement).textContent = `${level.bpm} bpm · ${mode === "practice" ? "practice" : "count-in"}`;
  topbar.append(homeButton, titleEl);
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
  staffArea.className = "staff-area glass";
  const staffContainer = document.createElement("div");
  staffContainer.className = "staff-container";
  staffArea.appendChild(staffContainer);
  screen.appendChild(staffArea);

  // The plate lives in the WebGL scene behind everything; this empty slot only tells it where to sit.
  const stage = document.createElement("div");
  stage.className = "stage";
  const plateSlot = document.createElement("div");
  plateSlot.className = "plate-slot";
  stage.appendChild(plateSlot);
  screen.appendChild(stage);

  const tapArea = document.createElement("div");
  tapArea.className = "tap-area";
  const zoneLeft = document.createElement("div");
  zoneLeft.className = "tap-zone tap-zone-left";
  const zoneLeftLabel = document.createElement("span");
  zoneLeftLabel.className = "tap-zone-label";
  zoneLeftLabel.textContent = "tap · F";
  zoneLeft.appendChild(zoneLeftLabel);
  const zoneRight = document.createElement("div");
  zoneRight.className = "tap-zone tap-zone-right";
  const zoneRightLabel = document.createElement("span");
  zoneRightLabel.className = "tap-zone-label";
  zoneRightLabel.textContent = "tap · J";
  zoneRight.appendChild(zoneRightLabel);
  tapArea.append(zoneLeft, zoneRight);
  stage.appendChild(tapArea);

  const gradeFlash = document.createElement("div");
  gradeFlash.className = "grade-flash";
  plateSlot.appendChild(gradeFlash);

  const resultsOverlay = document.createElement("div");
  resultsOverlay.className = "results-overlay";
  resultsOverlay.hidden = true;
  screen.appendChild(resultsOverlay);

  container.appendChild(screen);

  function placePlate(): void {
    const rect = plateSlot.getBoundingClientRect();
    const radius = Math.max(40, Math.min(rect.width * 0.44, rect.height * 0.46));
    scene.setPlate(rect.left + rect.width / 2, rect.top + rect.height / 2, radius);
  }
  const plateObserver = new ResizeObserver(placePlate);
  plateObserver.observe(plateSlot);
  placePlate();

  const baseFigure = figureSeed(level.id);
  let currentFigure = baseFigure;
  let coherence = 1;
  // The sand keeps whatever figure it last settled into; the piece's own figure takes over
  // as the player plays.
  scene.reset();
  scene.setFigure(baseFigure);
  scene.setCoherence(1);
  scene.setAmbient(0);
  scene.setDim(0);

  const staff = renderStaff(staffContainer, level, { theme: "dark" });
  // The card hugs a short piece instead of leaving empty glass; long pieces scroll inside it.
  const staffSvg = staffContainer.querySelector("svg");
  if (staffSvg) staffArea.style.maxHeight = `${Math.ceil(staffSvg.getBoundingClientRect().height) + 12}px`;
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
  engine.setAmbience(0.35, 1.5);
  const liveJudge = createLiveJudge(onsets, startTime, level.bpm);
  const hits: Hit[] = [];
  const releases: Release[] = [];
  let matchedCount = 0;
  let ended = false;
  let rafId = 0;
  let flashTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastResult: RunResult | null = null;
  let tooltipEl: HTMLDivElement | null = null;
  /** The sustained note currently held, if any, for the hold bar and the plate's ring. */
  let holding: { onsetIndex: number; eventIndex: number; quarters: number; startPerf: number; durationSec: number; earlyFrac: number; lateFrac: number } | null = null;
  /** Screen position of the latest press, for the plate ripple. */
  let lastPress: { x: number | null; y: number | null } = { x: null, y: null };
  let allTappedAt: number | null = null;

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

  function holdState(fraction: number): HoldState {
    if (!holding) return "filling";
    if (fraction < 1 - holding.earlyFrac) return "filling";
    if (fraction <= 1 + holding.lateFrac) return "ready";
    return "over";
  }

  function updateHold(): void {
    if (!holding) return;
    const fraction = (performance.now() - holding.startPerf) / 1000 / holding.durationSec;
    const state = holdState(fraction);
    staff.setHold(holding.eventIndex, holding.quarters, Math.min(1, fraction), state);
    scene.setHold({ progress: Math.min(1, fraction), state });
  }

  function endHold(onsetIndex: number | null): void {
    if (!holding || (onsetIndex !== null && holding.onsetIndex !== onsetIndex)) return;
    holding = null;
    staff.setHold(0, 0, null);
    scene.setHold(null);
  }

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
    endHold(onsetIndex);
    if (releaseGrade !== null) {
      // A sustained note's release lands like a second strike: a clean release keeps the figure.
      coherence = coherence * 0.8 + GRADE_VALUE[releaseGrade] * 0.2;
      scene.setCoherence(coherence);
      if (releaseGrade === "miss") scene.strike("miss");
    }
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
      coherence *= 0.8;
      scene.setCoherence(coherence);
      scene.strike("miss", lastPress.x, lastPress.y);
      return;
    }

    matchedCount++;
    coherence = coherence * 0.7 + GRADE_VALUE[judged.grade] * 0.3;
    scene.setCoherence(coherence);
    scene.strike(judged.grade, lastPress.x, lastPress.y);

    const onset = onsets[judged.onsetIndex];
    if (onset) {
      const barIndex = Math.floor(onset.beat / beatsPerBar);
      const figure = baseFigure + Math.floor(barIndex / BARS_PER_FIGURE);
      if (figure !== currentFigure) {
        currentFigure = figure;
        scene.setFigure(figure);
      }
      if (onset.quarters > SUSTAINED_MIN_QUARTERS) {
        const durationSec = Math.max(0.05, liveJudge.predictTime(onset.beat + onset.quarters) - hit.time);
        const window = releaseWindowMs(onset.quarters * liveJudge.secPerQuarter() * 1000);
        holding = {
          onsetIndex: judged.onsetIndex,
          eventIndex: onset.eventIndex,
          quarters: onset.quarters,
          startPerf: performance.now(),
          durationSec,
          earlyFrac: window.early / 1000 / durationSec,
          lateFrac: window.late / 1000 / durationSec,
        };
        updateHold();
      }
    }
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

  const detachInput = attachInput(tapArea, engine, handleHit, () => offsetSec, handleRelease, {
    ripple: !scene.supported,
    onPress: (_zone, x, y) => {
      lastPress = { x, y };
    },
  });

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
    updateHold();

    if (t >= endTime) {
      finish();
      return;
    }
    // Every note is tapped: wait for a held last note to be let go (or to run well past its
    // end), then a breath so the final strike can ring out, before showing the results.
    if (matchedCount >= onsets.length) {
      const nowPerf = performance.now();
      if (holding) {
        const fraction = (nowPerf - holding.startPerf) / 1000 / holding.durationSec;
        if (fraction > 1 + holding.lateFrac + 0.15) {
          finish();
          return;
        }
      } else {
        allTappedAt ??= nowPerf;
        if (nowPerf - allTappedAt > 450) {
          finish();
          return;
        }
      }
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
    endHold(null);
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
    screen.classList.add("finished");

    const quality = result.judgements.some((j) => j.hitTime !== null) ? result.accuracy / 100 : 0;
    scene.reveal(quality);
    engine.setAmbience(0.8, 3);
    if (quality > 0) engine.chime(quality);

    resultsOverlay.innerHTML = "";
    resultsOverlay.appendChild(
      buildResultsPanel(result, level.bpm, mode, {
        onRetry: () => leave(callbacks.onRetry),
        onNext: () => leave(callbacks.onNext),
        onHome: () => leave(callbacks.onHome),
      }),
    );
    resultsOverlay.hidden = false;
  }

  /** Leaving the screen for good: the plate stops following this layout. */
  function leave(then: () => void): void {
    teardown();
    plateObserver.disconnect();
    then();
  }

  homeButton.addEventListener("click", () => leave(callbacks.onHome));

  rafId = requestAnimationFrame(tick);
}

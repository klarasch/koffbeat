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
import { levelLines } from "../rhythm/durations";
import { levelOnsets, restSpans, tieFlags as levelTieFlags } from "../rhythm/onsets";
import type { Grade, Hand, Hit, Level, Mode, Release, RunResult } from "../types";
import { attackWords, buildEndedEarlyPanel, buildListenedPanel, buildResultsPanel, describeNoteJudgement, describeRestJudgement, releaseWords } from "./results";

export interface PlayCallbacks {
  onHome: () => void;
  /** Play the same exercise again, at `bpm` when given (the player changed the tempo). */
  onRetry: (bpm?: number) => void;
  onNext: () => void;
  /** Hear the same exercise played correctly. */
  onListen: () => void;
  /** A run reached its end (not stopped or lost), with its accuracy. */
  onComplete?: (accuracy: number) => void;
}

export interface PlayOptions {
  /** Count-in scoring: "next" (each tap is the next note) or "time" (nearest note on the pulse). */
  countInScoring?: "next" | "time";
  /** Two-hand levels: practise one hand; the other is played for you and isn't judged. */
  solo?: Hand;
  /** Play the exercise back correctly instead of judging the player. */
  demo?: boolean;
  /** Where this run sits in a sequence of steps (e.g. right hand, left hand, together). */
  steps?: { labels: string[]; current: number };
  /** Label of the results' main "next" action (default "Next level"). */
  nextLabel?: string;
}

/** How long after the count-in's last click ends do we still accept hits, in quarter notes. */
const END_MARGIN_QUARTERS = 2;
/** countIn mode has no metronome to anchor the player, so give a more generous end margin. */
const END_MARGIN_QUARTERS_COUNT_IN = 3;
/** Lead-in before the count-in's first click, in seconds — gives the scheduler headroom. */
const LEAD_IN_SEC = 0.3;
const GRADE_FLASH_MS = 420;
/** "Too obviously lost": this many notes missed in a row ends the run. */
const LOST_MISSED_NOTES = 4;
/** The music (or your own pulse) keeps going without you, so allow time to jump back on. */
const LOST_MISSED_NOTES_CLOCKED = 8;
/** …or this many taps in a row that match no note. */
const LOST_STRAY_TAPS = 5;
/** …or this many bars of silence past the note that was due. */
const LOST_SILENT_BARS = 2;

/** Every this many clean taps in a row, the sand blooms into a richer figure. */
const STREAK_MILESTONE = 8;

/** Each 4-bar phrase draws the sand toward a new figure. */
const BARS_PER_FIGURE = 4;
const GRADE_VALUE: Record<Grade, number> = { perfect: 1, good: 0.85, ok: 0.55, miss: 0 };

/**
 * Tap pitches: the drone's root and fifth, one per hand zone (left D4, right A3). No melody:
 * the tone marks the attack and the hold, and leaves the rhythm to speak for itself.
 */
const ZONE_PITCH: Record<0 | 1, number> = { 0: 293.66, 1: 220.0 };

/** A stable small integer from a level id, so a level always starts on the same figure. */
function figureSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 12;
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
  hand: Hand;
  onsetIndex: number;
  beat: number;
  eventIndices: number[];
}
interface TimelineRest {
  kind: "rest";
  hand: Hand;
  restIndex: number;
  beat: number;
  eventIndex: number;
}
type TimelineItem = TimelineNote | TimelineRest;

export function startPlay(container: HTMLElement, engine: AudioEngine, scene: Scene, level: Level, mode: Mode, callbacks: PlayCallbacks, options: PlayOptions = {}): void {
  const { solo, demo = false } = options;
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
  const twoHands = levelLines(level).length > 1;
  // Hands the player plays: both on a two-hand level, unless practising one of them.
  const hands: Hand[] = solo !== undefined && twoHands ? [solo] : twoHands ? [0, 1] : [0];
  (titleEl.lastChild as HTMLElement).textContent = `${level.bpm} bpm, ${demo ? "listening" : mode === "practice" ? "practice" : "count-in"}`;
  const escHint = document.createElement("span");
  escHint.className = "esc-hint";
  escHint.textContent = demo ? "Esc to stop" : "Esc to stop, R to retry";
  topbar.append(homeButton, titleEl);
  if (options.steps) {
    const steps = document.createElement("ol");
    steps.className = "step-indicator";
    steps.setAttribute("aria-label", "Steps");
    options.steps.labels.forEach((label, i) => {
      const li = document.createElement("li");
      li.textContent = label;
      if (i === options.steps?.current) li.setAttribute("aria-current", "step");
      if (i < (options.steps?.current ?? 0)) li.classList.add("done");
      steps.appendChild(li);
    });
    topbar.appendChild(steps);
  }
  topbar.appendChild(escHint);
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
  // A hairline under the beat bars with a dot gliding across each bar, in time.
  const sweep = document.createElement("div");
  sweep.className = "beat-sweep";
  const sweepDot = document.createElement("span");
  sweep.appendChild(sweepDot);
  dotsRow.appendChild(sweep);

  // Which bar the music is in, next to the beat meter.
  const barCounter = document.createElement("span");
  barCounter.className = "bar-counter";
  dotsRow.appendChild(barCounter);
  screen.appendChild(dotsRow);

  const staffArea = document.createElement("div");
  staffArea.className = "staff-area";
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
  zoneLeftLabel.textContent = demo ? "" : twoHands ? (solo === 1 ? "" : "left hand (F)") : "tap (F)";
  zoneLeft.appendChild(zoneLeftLabel);
  const zoneRight = document.createElement("div");
  zoneRight.className = "tap-zone tap-zone-right";
  const zoneRightLabel = document.createElement("span");
  zoneRightLabel.className = "tap-zone-label";
  zoneRightLabel.textContent = demo ? "" : twoHands ? (solo === 0 ? "" : "right hand (J)") : "tap (J)";
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

  /** While playing, the sand runs edge to edge; when the run ends it pulls back into view. */
  let immersive = true;
  function placePlate(): void {
    const rect = plateSlot.getBoundingClientRect();
    const framed = Math.max(40, Math.min(rect.width * 0.42, rect.height * 1.05));
    const radius = immersive ? Math.max(window.innerWidth * 0.62, framed * 1.6) : framed;
    scene.setPlate(rect.left + rect.width / 2, rect.top + rect.height * (immersive ? 0.52 : 0.5), radius);
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

  const staff = renderStaff(staffContainer, level, { theme: "light" });
  staff.setAnimate(true);
  // The notes area shows whole lines only, as many as fit in about 40% of the screen (at least
  // one), so a line is never sliced through — two-hand lines, with two staves each, are tall.
  // A short piece gets exactly its own height.
  /** Share of the screen height the notes may take: less once the results need the room. */
  let staffShare = 0.4;
  function fitStaffArea(): void {
    const { top, systemHeight, total } = staff.layout();
    // The view scrolls so the current line starts LEAD px from the top (staff.revealEvent), so
    // exactly `lines` lines fit in lines × systemHeight + LEAD, with nothing of the next one.
    const LEAD = 10;
    const lines = Math.max(1, Math.floor((window.innerHeight * staffShare) / systemHeight));
    // The last line's bottom breathing room is left out: the next line's upward stems and
    // brackets reach into it, and their tips would show at the bottom edge.
    const TAIL = 26;
    const height = Math.min(total - (top - LEAD), lines * systemHeight + LEAD - TAIL);
    staffArea.style.height = `${height + 8}px`;
    staffArea.style.maxHeight = "none";
    staffArea.style.flexShrink = "0";
    // Room below the music, so even the last line can scroll to the top of the window (without
    // it the scroll stops short and the view sits between two lines).
    staffContainer.style.paddingBottom = `${height}px`;
    staffContainer.style.boxSizing = "border-box";
    const current = timeline[Math.min(nextPointer, timeline.length - 1)];
    if (current) staff.revealEvent(primaryEventIndex(current));
  }
  window.addEventListener("resize", fitStaffArea);
  const allOnsets = levelOnsets(level);
  const allRests = restSpans(level);
  // Practising one hand: only its notes and rests are played and judged; the other hand's line
  // stays on the staff, faded, and is played for you.
  const inPlayedHands = (line: number | undefined) => hands.includes((line ?? 0) as Hand);
  const onsets = allOnsets.filter((o) => inPlayedHands(o.line));
  const rests = allRests.filter((r) => inPlayedHands(r.line));
  const tieFlags = levelTieFlags(level);

  // The played sequence, in beat order: karaoke state (upcoming/next/active/graded) advances
  // through this list only when the player actually plays, never with the clock.
  const timeline: TimelineItem[] = [
    ...onsets.map((onset, onsetIndex): TimelineNote => ({ kind: "note", hand: onset.line ?? 0, onsetIndex, beat: onset.beat, eventIndices: tieChainIndices(tieFlags, onset.eventIndex) })),
    ...rests.map((rest, restIndex): TimelineRest => ({ kind: "rest", hand: rest.line ?? 0, restIndex, beat: rest.beat, eventIndex: rest.eventIndex })),
  ].sort((a, b) => a.beat - b.beat || a.hand - b.hand);
  /** Each hand's own sequence, as indices into the timeline. */
  const timelineByHand: Record<Hand, number[]> = { 0: [], 1: [] };
  timeline.forEach((item, i) => timelineByHand[item.hand].push(i));
  /** The timeline index of the same hand's next item after `index`, or -1. */
  function nextInHand(index: number): number {
    const item = timeline[index];
    if (!item) return -1;
    return timelineByHand[item.hand].find((i) => i > index) ?? -1;
  }
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

  if (mode === "practice" || demo) {
    engine.startMetronome(startTime, secPerQuarter, level.meter.beats, level.bars.length);
  }
  // Notes the game plays itself, on the felt piano: every note when listening, otherwise the
  // other hand's line when practising one hand. stopAll cancels them with the metronome.
  for (const o of allOnsets) {
    const line = (o.line ?? 0) as Hand;
    const playedByGame = demo || !hands.includes(line);
    if (!playedByGame) continue;
    engine.scheduleNote(ZONE_PITCH[line], demo ? 0.75 : 0.45, startTime + o.beat * secPerQuarter, o.quarters * secPerQuarter * 0.92);
  }

  const offsetSec = loadOffset();
  /** The sounding tap note per zone, released with the finger or key. */
  const soundingByZone = new Map<0 | 1, number>();
  engine.setAmbience(0.35, 1.5);
  // Both modes run on a clock. Practice: the metronome's (taps judged against the click, so
  // drifting is never forgiven). Count-in: the player's own pulse, projected forward while they
  // are silent, so they can keep counting and catch on again. The karaoke marker and bar
  // highlight follow that clock, and every tap is an attempt at the next open note.
  const clockDriven = true;
  const grid = mode === "practice";
  // Count-in, next-note scoring: the music only moves on when the player plays; silence is
  // waiting, not missing (see JudgeOptions.sequential).
  const sequential = mode === "countIn" && !demo && options.countInScoring !== "time";
  const liveJudge = createLiveJudge(onsets, startTime, level.bpm, { grid, sequential });
  /** Next-note scoring: notes the player skipped over (judged missed when the tap came). */
  const skippedTimeline = new Set<number>();
  /** Live pairing of onset → hit index, handed to the final judgement. */
  const liveMatches = new Map<number, number>();
  const hits: Hit[] = [];
  const releases: Release[] = [];
  let matchedCount = 0;
  let ended = false;
  let rafId = 0;
  let flashTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastResult: RunResult | null = null;
  let tooltipEl: HTMLDivElement | null = null;
  /** The sustained note each hand is holding, if any, for its hold bar and the plate's ring. */
  interface Holding {
    onsetIndex: number;
    eventIndex: number;
    quarters: number;
    startPerf: number;
    durationSec: number;
    earlyFrac: number;
    lateFrac: number;
  }
  const holdingByHand = new Map<Hand, Holding>();
  /** The plate shows one ring: the hold started most recently. */
  function latestHolding(): Holding | null {
    let latest: Holding | null = null;
    for (const h of holdingByHand.values()) if (!latest || h.startPerf > latest.startPerf) latest = h;
    return latest;
  }
  /** Screen position of the latest press, for the plate ripple. */
  let lastPress: { x: number | null; y: number | null } = { x: null, y: null };
  let allTappedAt: number | null = null;
  let missedInARow = 0;
  let cleanStreak = 0;
  let streakFigures = 0;
  let strayInARow = 0;

  let nextPointer = 0;
  // Before the run starts, the staff is shown from its first system, each hand's first item
  // marked as next (revealEvent is a no-op here since scrollTop already starts at 0, but this
  // keeps the "position drives the view" invariant explicit).
  for (const hand of hands) {
    const first = timeline[timelineByHand[hand][0] ?? -1];
    if (first) {
      setTimelineState(first, "next");
      staff.revealEvent(primaryEventIndex(first));
    }
  }
  fitStaffArea();

  const lastBeat = allOnsets.reduce((end, o) => Math.max(end, o.beat + o.quarters), 0);
  const endMarginQuarters = mode === "countIn" ? END_MARGIN_QUARTERS_COUNT_IN : END_MARGIN_QUARTERS;
  const endTime = startTime + lastBeat * secPerQuarter + endMarginQuarters * secPerQuarter;

  function holdState(holding: Holding, fraction: number): HoldState {
    if (fraction < 1 - holding.earlyFrac) return "filling";
    if (fraction <= 1 + holding.lateFrac) return "ready";
    return "over";
  }

  function updateHold(): void {
    const latest = latestHolding();
    for (const holding of holdingByHand.values()) {
      const fraction = (performance.now() - holding.startPerf) / 1000 / holding.durationSec;
      const state = holdState(holding, fraction);
      staff.setHold(holding.eventIndex, holding.quarters, Math.min(1, fraction), state);
      if (holding === latest) scene.setHold({ progress: Math.min(1, fraction), state });
    }
  }

  /** Ends the hold on `onsetIndex` (every hold, with null). */
  function endHold(onsetIndex: number | null): void {
    for (const [hand, holding] of holdingByHand) {
      if (onsetIndex !== null && holding.onsetIndex !== onsetIndex) continue;
      holdingByHand.delete(hand);
      staff.setHold(holding.eventIndex, 0, null);
    }
    if (holdingByHand.size === 0) scene.setHold(null);
  }

  /** Says what just happened, the way a teacher would: "a touch early", "held too long"… */
  function showGradeFlash(grade: Grade, text: string = grade): void {
    gradeFlash.textContent = text;
    gradeFlash.className = `grade-flash grade-${grade} show`;
    if (flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => {
      gradeFlash.classList.remove("show");
    }, GRADE_FLASH_MS);
  }

  /** Rests already spoiled live (a tap during them, or a note held into them). */
  const spoiledRests = new Set<number>();

  /**
   * The player jumped ahead to a later note: notes in between were skipped (missed), while
   * rests in between were correctly left silent, unless something already spoiled them.
   */
  function settleSkipped(fromIndex: number, toIndexExclusive: number): void {
    for (let i = fromIndex; i < toIndexExclusive; i++) {
      const item = timeline[i];
      if (!item) continue;
      if (item.kind === "rest") setTimelineState(item, spoiledRests.has(item.restIndex) ? "miss" : "done");
      else {
        setTimelineState(item, "miss");
        missedInARow++;
      }
    }
  }

  function spoilRest(item: TimelineItem): void {
    if (item.kind !== "rest") return;
    spoiledRests.add(item.restIndex);
    setTimelineState(item, "miss");
  }

  /** The event index that best represents a timeline item's on-screen position (a tie chain's first note). */
  function primaryEventIndex(item: TimelineItem): number {
    return item.kind === "note" ? (item.eventIndices[0] ?? item.onsetIndex) : item.eventIndex;
  }

  function setNext(index: number): void {
    nextPointer = index;
    const item = timeline[nextPointer];
    // While the music rests, the sand settles flat.
    scene.setRest(item?.kind === "rest");
    if (item) {
      setTimelineState(item, "next");
      staff.revealEvent(primaryEventIndex(item));
    }
  }

  /** After a note (at `timelineIndex`) gets its final release grade, advance the "next" pointer past it. */
  function advanceAfterRelease(timelineIndex: number, releaseGrade: Grade | null): void {
    const afterIndex = twoHands ? nextInHand(timelineIndex) : timelineIndex + 1;
    const afterItem = timeline[afterIndex];
    // The note bled well past its own release window into the rest that follows: the rest is
    // already spoiled, so grade and skip it immediately rather than waiting on the next press.
    if (afterItem && afterItem.kind === "rest" && releaseGrade === "miss") {
      spoilRest(afterItem);
      if (!clockDriven) setNext(afterIndex + 1);
      return;
    }
    // In practice mode the clock moves the marker; otherwise the player's own playing does.
    if (!clockDriven) setNext(afterIndex);
  }

  function finalizeRelease(onsetIndex: number, combinedGrade: Grade | null, releaseGrade: Grade | null, releaseErrorMs: number | null = null): void {
    if (releaseGrade !== null && releaseGrade !== "perfect" && releaseErrorMs !== null) showGradeFlash(releaseGrade, releaseWords(releaseErrorMs));
    if ([...holdingByHand.values()].some((h) => h.onsetIndex === onsetIndex)) scene.release(releaseGrade ?? "neutral");
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

  /** A two-hand stray: the other hand has a note due right about now (the player swapped hands). */
  function otherHandDue(hit: Hit): boolean {
    if (!twoHands) return false;
    const windowSec = 0.25;
    return onsets.some((o, i) => (o.line ?? 0) !== hit.zone && !liveMatches.has(i) && Math.abs(liveJudge.predictTime(o.beat) - hit.time) < windowSec);
  }

  function handleHit(hit: Hit): void {
    hits.push(hit);

    // A held note in this zone with no explicit release yet (typically a keyboard key still
    // down) is implicitly released the moment a new press happens.
    const implicit = liveJudge.implicitRelease(hit.zone, hit.time);
    if (implicit.onsetIndex !== null) finalizeRelease(implicit.onsetIndex, implicit.combinedGrade, implicit.releaseGrade, implicit.releaseErrorMs);

    const judged = liveJudge.judgeHit(hit);
    const previousNote = soundingByZone.get(hit.zone);
    if (previousNote !== undefined) engine.noteOff(previousNote);
    // A matched tap rings the plate; a stray tap a soft, low one.
    soundingByZone.set(hit.zone, judged.onsetIndex === null ? engine.noteOn(146.83, 0.3) : engine.noteOn(ZONE_PITCH[hit.zone], 0.8));
    if (judged.onsetIndex === null || judged.grade === null) {
      // An unmatched press while a rest is this hand's current target means the rest wasn't silent.
      const current = timeline[twoHands ? (nowByHand.get(hit.zone) ?? -1) : nextPointer];
      const inOwnRest = current?.kind === "rest" && (!twoHands || current.hand === hit.zone);
      if (current && inOwnRest) spoilRest(current);
      showGradeFlash("miss", inOwnRest ? "that's a rest" : otherHandDue(hit) ? "other hand" : "extra tap");
      coherence *= 0.8;
      scene.setCoherence(coherence);
      scene.strike("miss", lastPress.x, lastPress.y);
      strayInARow++;
      checkLost();
      return;
    }
    strayInARow = 0;

    for (const skippedOnset of judged.skipped ?? []) {
      const index = timelineIndexForOnset.get(skippedOnset);
      const item = index === undefined ? undefined : timeline[index];
      if (index === undefined || !item) continue;
      skippedTimeline.add(index);
      setTimelineState(item, "miss");
      missedInARow++;
    }

    matchedCount++;
    liveMatches.set(judged.onsetIndex, hits.length - 1);
    coherence = coherence * 0.7 + GRADE_VALUE[judged.grade] * 0.3;
    scene.setCoherence(coherence);
    const onset = onsets[judged.onsetIndex];
    scene.strike(judged.grade, lastPress.x, lastPress.y, onset?.quarters ?? 1);

    // A run of clean taps is rewarded: every STREAK_MILESTONE in a row the figure blooms and
    // moves on to the next, richer pattern. Anything less than good breaks the run.
    if (judged.grade === "perfect" || judged.grade === "good") {
      cleanStreak++;
      if (cleanStreak % STREAK_MILESTONE === 0) {
        streakFigures++;
        scene.celebrate();
      }
    } else {
      cleanStreak = 0;
    }

    if (onset) {
      const barIndex = Math.floor(onset.beat / beatsPerBar);
      const figure = baseFigure + Math.floor(barIndex / BARS_PER_FIGURE) + streakFigures;
      if (figure !== currentFigure) {
        currentFigure = figure;
        scene.setFigure(figure);
      }
      if (onset.quarters > SUSTAINED_MIN_QUARTERS) {
        const durationSec = Math.max(0.05, liveJudge.predictTime(onset.beat + onset.quarters) - hit.time);
        const window = releaseWindowMs(onset.quarters * liveJudge.secPerQuarter() * 1000);
        holdingByHand.set(hit.zone, {
          onsetIndex: judged.onsetIndex,
          eventIndex: onset.eventIndex,
          quarters: onset.quarters,
          startPerf: performance.now(),
          durationSec,
          earlyFrac: window.early / 1000 / durationSec,
          lateFrac: window.late / 1000 / durationSec,
        });
        updateHold();
      }
    }
    const timelineIndex = timelineIndexForOnset.get(judged.onsetIndex);
    if (timelineIndex !== undefined) {
      // Notes skipped on the way here count as missed; this note continues or ends the streak.
      if (!clockDriven && timelineIndex > nextPointer) settleSkipped(nextPointer, timelineIndex);
      if (judged.grade === "miss") missedInARow++;
      checkLost();
      if (ended) return;
      if (judged.grade !== "miss") {
        missedInARow = 0;
        lastGoodHitTime = hit.time;
      }
      matchedTimeline.add(timelineIndex);
      const item = timeline[timelineIndex];
      if (item) setTimelineState(item, "active");
      if (!clockDriven) {
        nextPointer = timelineIndex;
        if (item) staff.revealEvent(primaryEventIndex(item));
      }
    }
    showGradeFlash(judged.grade, judged.resynced ? "back in" : attackWords(judged.grade, judged.errorMs ?? 0));
  }

  function handleRelease(release: Release): void {
    releases.push(release);
    const sounding = soundingByZone.get(release.zone);
    if (sounding !== undefined) {
      engine.noteOff(sounding);
      soundingByZone.delete(release.zone);
    }
    const result = liveJudge.judgeRelease(release);
    if (result.onsetIndex !== null) finalizeRelease(result.onsetIndex, result.combinedGrade, result.releaseGrade, result.releaseErrorMs);
  }

  // Listening takes no input: the game plays everything itself.
  const detachInput = demo
    ? () => {}
    : attachInput(tapArea, engine, handleHit, () => offsetSec, handleRelease, {
        ripple: !scene.supported,
        onPress: (_zone, x, y) => {
          lastPress = { x, y };
        },
      });

  /** The audio-clock time being heard right now (scheduled time plus the output delay). */
  function audibleTime(): number {
    const ctx = engine.ctx;
    const stamp = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (stamp?.contextTime !== undefined && stamp.performanceTime) return stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  const metronomeEnd = startTime + level.bars.length * beatsPerBar * secPerQuarter;

  /**
   * The count-in fills the beat squares one by one; in practice mode they then keep pulsing
   * with the metronome, so the pulse can be seen as well as heard. Both follow the audible
   * click, not the scheduled one, so the picture never runs ahead of the sound.
   */
  function updateBeatDots(): void {
    const t = audibleTime();
    const barSec = beatsPerBar * secPerQuarter;
    if (t < startTime) {
      for (let i = 0; i < dots.length; i++) {
        const clickAt = firstClickTime + i * secPerQuarter;
        dots[i]?.classList.toggle("lit", t >= clickAt && t < clickAt + secPerQuarter * 0.35);
        dots[i]?.classList.toggle("beat", t >= clickAt);
      }
      dotsRow.classList.toggle("running", t >= firstClickTime);
      sweepDot.style.transform = `translateX(${Math.max(0, Math.min(1, (t - firstClickTime) / barSec)) * 100}cqw)`;
      return;
    }
    // Practice: the meter keeps pulsing with the metronome. Count-in: silence is the point, so
    // the meter rests and the player keeps the pulse alone.
    const pulsing = mode === "practice" && t < metronomeEnd;
    dotsRow.classList.toggle("running", pulsing);
    const beat = Math.floor((t - startTime) / secPerQuarter);
    const phase = (t - startTime) / secPerQuarter - beat;
    for (let i = 0; i < dots.length; i++) {
      const on = pulsing && beat % beatsPerBar === i;
      dots[i]?.classList.toggle("lit", on && phase < 0.35);
      dots[i]?.classList.toggle("beat", on);
    }
    if (pulsing) sweepDot.style.transform = `translateX(${(((t - startTime) % barSec) / barSec) * 100}cqw)`;
  }

  let lostReason: string | null = null;

  function barOf(beat: number): number {
    return Math.floor(beat / beatsPerBar) + 1;
  }

  /** Ends the run when the player has clearly lost their place. */
  function checkLost(): void {
    if (ended) return;
    const current = timeline[nextPointer];
    const where = current ? ` in bar ${barOf(current.beat)}` : "";
    if (missedInARow >= (clockDriven ? LOST_MISSED_NOTES_CLOCKED : LOST_MISSED_NOTES)) lostReason = `${missedInARow} notes in a row were missed${where}.`;
    else if (strayInARow >= LOST_STRAY_TAPS) lostReason = `${strayInARow} taps in a row didn't match a note${where}.`;
    if (lostReason) finish("lost");
  }

  // ---- Practice clock ----
  /** Timeline items the player has matched (their state comes from the player, not the clock). */
  const matchedTimeline = new Set<number>();
  let lastGoodHitTime = startTime;
  /** Every item before this index has been settled by the clock. */
  let settledUpTo = 0;
  /** Each hand's karaoke position: the timeline index of its item due now. */
  const nowByHand = new Map<Hand, number>();
  let shownBar = -1;

  /** Beats after its onset at which a note's chance to be played has passed. */
  function closesAfterBeats(index: number): number {
    const item = timeline[index];
    if (!item) return 0;
    if (item.kind === "rest") return rests[item.restIndex]?.quarters ?? 1;
    const next = timeline.slice(index + 1).find((t) => t.kind === "note" && t.hand === item.hand);
    const gap = next ? next.beat - item.beat : 4;
    return Math.min(0.4 / secPerQuarter, 0.45 * gap);
  }

  /**
   * Practice mode, each frame: the note due now carries the karaoke marker, the current bar is
   * highlighted and kept in view, and items whose moment has passed are settled: an unplayed
   * note becomes a miss, a rest passed in silence turns ink.
   */
  function updateClock(): void {
    const heard = audibleTime();
    let beatNow = heard < startTime ? -1 : liveJudge.beatAt(heard - offsetSec);
    if (beatNow < 0) return;
    if (sequential) {
      // The music waits on the next note the player hasn't played yet.
      for (let i = settledUpTo; i < timeline.length; i++) {
        const item = timeline[i];
        if (item?.kind === "note" && !matchedTimeline.has(i) && !skippedTimeline.has(i)) {
          beatNow = Math.min(beatNow, item.beat + 0.01);
          break;
        }
      }
    }

    while (settledUpTo < timeline.length) {
      const item = timeline[settledUpTo];
      if (!item || beatNow < item.beat + closesAfterBeats(settledUpTo)) break;
      if (item.kind === "note" && demo) {
        setTimelineState(item, "done");
      } else if (item.kind === "note" && sequential) {
        // Only the player settles notes here: played, or skipped over (already marked missed).
        if (!matchedTimeline.has(settledUpTo) && !skippedTimeline.has(settledUpTo)) break;
      } else if (item.kind === "note" && !matchedTimeline.has(settledUpTo)) {
        setTimelineState(item, "miss");
        liveJudge.markMissed(item.onsetIndex);
        missedInARow++;
      } else if (item.kind === "rest") {
        setTimelineState(item, spoiledRests.has(item.restIndex) ? "miss" : "done");
      }
      settledUpTo++;
    }
    if (!demo) checkLost();
    if (ended) return;
    if (!demo && missedInARow >= 3 && heard - lastGoodHitTime > LOST_SILENT_BARS * beatsPerBar * secPerQuarter) {
      lostReason = `The playing stopped in bar ${barOf(beatNow)}.`;
      finish("lost");
      return;
    }

    // Each hand's marker sits on that hand's item due now.
    let moved = false;
    for (const hand of hands) {
      let current = -1;
      for (const i of timelineByHand[hand]) {
        const item = timeline[i];
        if (item && item.beat <= beatNow + 0.02) current = i;
        else break;
      }
      const nowIndex = nowByHand.get(hand) ?? -1;
      if (current === nowIndex || current < 0) continue;
      const previous = timeline[nowIndex];
      // The marker moves on; a note it leaves unplayed waits (upcoming ink) until it's settled.
      if (previous && nowIndex >= settledUpTo && !matchedTimeline.has(nowIndex)) setTimelineState(previous, "upcoming");
      nowByHand.set(hand, current);
      const item = timeline[current];
      if (item && !matchedTimeline.has(current) && current >= settledUpTo) setTimelineState(item, demo && item.kind === "note" ? "active" : "next");
      // Listening: the sand answers every note as if it were played perfectly.
      if (demo && item?.kind === "note") {
        const onset = onsets[item.onsetIndex];
        scene.setCoherence(1);
        scene.strike("perfect", null, null, onset?.quarters ?? 1);
      }
      moved = true;
    }
    if (moved) {
      nextPointer = Math.max(...nowByHand.values());
      // While the music rests (in every hand), the sand settles flat.
      scene.setRest([...nowByHand.values()].every((i) => timeline[i]?.kind === "rest"));
    }

    const bar = Math.min(level.bars.length - 1, Math.floor(beatNow / beatsPerBar));
    if (bar !== shownBar) {
      shownBar = bar;
      staff.setBarHighlight(bar);
      staff.revealEvent(staff.firstEventOfBar(bar));
      barCounter.textContent = `bar ${bar + 1} / ${level.bars.length}`;
    }
  }

  /** Silence check: nothing played for a couple of bars after a note was due. */
  function checkSilence(t: number): void {
    let due: number | null = null;
    for (let i = nextPointer; i < timeline.length; i++) {
      const item = timeline[i];
      if (item?.kind === "note") {
        const onset = onsets[item.onsetIndex];
        if (onset) due = liveJudge.predictTime(onset.beat);
        if (onset && due !== null && t > due + LOST_SILENT_BARS * beatsPerBar * secPerQuarter) {
          lostReason = matchedCount === 0 ? "Nothing was played after the count-in." : `The playing stopped in bar ${barOf(onset.beat)}.`;
          finish("lost");
        }
        return;
      }
    }
  }

  function tick(): void {
    if (ended) return;
    const t = engine.now();

    updateBeatDots();
    updateHold();
    if (clockDriven) updateClock();
    if (!clockDriven || sequential) checkSilence(t);
    if (ended) return;

    // Next-note scoring: the piece ends on the player's own clock, which waits when they pause.
    if (sequential ? t >= liveJudge.predictTime(lastBeat) + endMarginQuarters * liveJudge.secPerQuarter() : t >= endTime) {
      finish();
      return;
    }
    // Every note is tapped: wait for a held last note to be let go (or to run well past its
    // end), then a breath so the final strike can ring out, before showing the results.
    if (matchedCount >= onsets.length) {
      const nowPerf = performance.now();
      const holding = latestHolding();
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
    for (const id of soundingByZone.values()) engine.noteOff(id);
    soundingByZone.clear();
    endHold(null);
    cancelAnimationFrame(rafId);
    engine.stopAll();
    detachInput();
    if (flashTimeout) clearTimeout(flashTimeout);
  }

  function finish(outcome: "done" | "lost" | "stopped" = "done"): void {
    if (ended) return;
    teardown();
    for (const dot of dots) dot.classList.remove("lit", "beat");
    staff.setBarHighlight(null);
    if (demo) {
      finishListening(outcome);
      return;
    }

    const result = judgeRun(onsets, rests, startTime, level.bpm, hits, releases, { grid, matches: liveMatches, sequential });
    lastResult = result;
    logDebugTable(result);

    // The final repaint is still: no motion for every note at once.
    staff.setAnimate(false);
    staff.clearMarks();
    // The player reviews the whole staff after a run — let them scroll it freely, rather than
    // only the current line as during play.
    staff.setScrollable(true);
    for (const judgement of result.judgements) {
      const combined = combineGrades(judgement.grade, judgement.releaseGrade);
      for (const eventIndex of tieChainIndices(tieFlags, judgement.onset.eventIndex)) staff.setState(eventIndex, combined);
    }
    // A clean rest is shown in plain ink, not a grade colour: silence was simply right.
    for (const restJudgement of result.restJudgements) {
      staff.setState(restJudgement.eventIndex, restJudgement.grade === "miss" ? "miss" : "done");
    }

    // The last in-run grade flash (e.g. "PERFECT") must not linger once results are shown.
    gradeFlash.classList.remove("show");

    // The results panel replaces the tap area (which is no longer needed) rather than
    // overlaying the whole screen, so the staff with its final grade marks stays fully visible.
    tapArea.hidden = true;
    screen.classList.add("finished");
    immersive = false;
    staffShare = 0.28;
    fitStaffArea();
    placePlate();

    const panelCallbacks = {
      onRetry: (bpm?: number) => leave(() => callbacks.onRetry(bpm)),
      onNext: () => leave(callbacks.onNext),
      onHome: () => leave(callbacks.onHome),
      onListen: () => leave(callbacks.onListen),
    };
    const retryTempo = { bpm: level.bpm, nextLabel: options.nextLabel };
    resultsOverlay.innerHTML = "";
    if (outcome === "done") {
      callbacks.onComplete?.(result.accuracy);
      const quality = result.judgements.some((j) => j.hitTime !== null) ? result.accuracy / 100 : 0;
      scene.reveal(quality);
      engine.setAmbience(0.8, 3);
      if (quality > 0) engine.chime(quality);
      resultsOverlay.appendChild(buildResultsPanel(result, level.bpm, mode, panelCallbacks, retryTempo));
    } else {
      // No reveal: the sand just settles back into the void.
      scene.setCoherence(0.3);
      scene.setRest(true);
      scene.setAmbient(0.12);
      engine.setAmbience(0.5, 2);
      const title = outcome === "lost" ? "Lost the beat" : "Stopped";
      const detail = outcome === "lost" ? (lostReason ?? "") : "You stopped the exercise.";
      resultsOverlay.appendChild(buildEndedEarlyPanel(title, detail, panelCallbacks, retryTempo));
    }
    resultsOverlay.hidden = false;
  }

  /** After listening: the staff settles, and the player is invited to take their turn. */
  function finishListening(outcome: "done" | "lost" | "stopped"): void {
    staff.setAnimate(false);
    gradeFlash.classList.remove("show");
    tapArea.hidden = true;
    screen.classList.add("finished");
    immersive = false;
    staffShare = 0.28;
    fitStaffArea();
    placePlate();
    if (outcome === "done") scene.reveal(0.95);
    engine.setAmbience(0.6, 2);
    resultsOverlay.innerHTML = "";
    resultsOverlay.appendChild(
      buildListenedPanel({
        onPlay: () => leave(() => callbacks.onRetry()),
        onListen: () => leave(callbacks.onListen),
        onHome: () => leave(callbacks.onHome),
      }),
    );
    resultsOverlay.hidden = false;
  }

  /** Leaving the screen for good: the plate stops following this layout. */
  function leave(then: () => void): void {
    window.removeEventListener("resize", fitStaffArea);
    teardown();
    plateObserver.disconnect();
    window.removeEventListener("keydown", handleKey);
    then();
  }

  homeButton.addEventListener("click", () => leave(callbacks.onHome));

  // Esc stops mid-run, and goes home from the results. R restarts at any time. Enter on the
  // results moves on to the next level.
  function handleKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      if (!ended) finish("stopped");
      else leave(callbacks.onHome);
    } else if (key === "r") {
      event.preventDefault();
      // On the results, Retry uses the tempo chosen there.
      const chosen = Number(resultsOverlay.querySelector<HTMLElement>("[data-retry-bpm]")?.dataset.retryBpm);
      leave(() => callbacks.onRetry(Number.isFinite(chosen) && chosen > 0 ? chosen : undefined));
    } else if (key === "h") {
      event.preventDefault();
      leave(callbacks.onListen);
    } else if (key === "enter" && ended) {
      event.preventDefault();
      if (demo) leave(() => callbacks.onRetry());
      else leave(callbacks.onNext);
    } else if (ended && !demo && (key === "-" || key === "+" || key === "=")) {
      event.preventDefault();
      resultsOverlay.querySelector<HTMLButtonElement>(key === "-" ? ".retry-tempo .step:first-child" : ".retry-tempo .step:last-child")?.click();
    }
  }
  window.addEventListener("keydown", handleKey);

  rafId = requestAnimationFrame(tick);
}

// The play screen: staff + count-in + tap area, driven by requestAnimationFrame reading the
// audio clock (never setTimeout for anything musical), ending in the results overlay. Notes are
// shown karaoke-style (upcoming/next/active/graded) rather than with a moving playhead — nothing
// on screen advances at the nominal tempo, only when the player actually plays.

import { t } from "../i18n";
import type { AudioEngine } from "../audio/engine";
import { loadOffset } from "../input/calibration";
import { attachInput } from "../input/input";
import { type NoteState, renderStaff } from "../notation/staff";
import { combineGrades, createLiveJudge, judgeRun, releaseWindowMs, SUSTAINED_MIN_QUARTERS } from "../rhythm/judge";
import type { HoldState, Scene } from "../scene/resonance";
import { barQuarters, levelLines } from "../rhythm/durations";
import { levelOnsets, restSpans, tieFlags as levelTieFlags } from "../rhythm/onsets";
import type { Grade, Hand, Hit, Level, Mode, Release, RunResult } from "../types";
import { isPhoneBackdrop } from "./home";
import { onTweak, tweak } from "../ui/tweaks";
import { attackWords, buildEndedEarlyPanel, buildListenedPanel, buildResultsPanel, describeNoteJudgement, describeRestJudgement, releaseWords } from "./results";

export interface PlayCallbacks {
  onHome: () => void;
  /** Play the same exercise again, at `bpm` when given (the player changed the tempo). */
  onRetry: (bpm?: number) => void;
  onNext: (bpm?: number) => void;
  /** Hear the same exercise played correctly. */
  onListen: () => void;
  /** A run reached its end (not stopped or lost), with its accuracy. */
  onComplete?: (accuracy: number) => void;
}

export interface PlayOptions {
  /** Two-hand levels: practise one hand; the other is played for you and isn't judged. */
  solo?: Hand;
  /** Play the exercise back correctly instead of judging the player. */
  demo?: boolean;
  /** Play-along: the game quietly plays the player's own notes too (with the metronome). */
  guide?: boolean;
  /** A lesson step's goal, so the results can say how a slower run compares. */
  goal?: { bpm: number; pass: number };
  /** Label of the results' main "next" action (default "Next level"). */
  nextLabel?: string;
  /** Two hands in free practice: a switch to play both hands or one alone (restarts the exercise). */
  handChoice?: { onPick: (solo: Hand | undefined) => void };
}

/** How loud the guide plays the player's own notes (0-1). */
const GUIDE_VELOCITY = 0.25;

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
  const { solo, demo = false, guide = false } = options;
  container.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "play-screen";
  // While the exercise runs, no touch anywhere on the screen may zoom or scroll the page (a
  // stray double tap next to the tap area used to zoom Safari in mid-exercise). Buttons keep
  // their taps, and once the run is over the results scroll normally.
  const blockGesture = (event: TouchEvent): void => {
    if (ended || !event.cancelable) return;
    if (event.target instanceof Element && event.target.closest("button, a, input, select")) return;
    event.preventDefault();
  };
  screen.addEventListener("touchstart", blockGesture, { passive: false });
  screen.addEventListener("touchend", blockGesture, { passive: false });

  const topbar = document.createElement("div");
  topbar.className = "play-topbar";
  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "home-button";
  homeButton.setAttribute("aria-label", t("play.home"));
  homeButton.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const titleEl = document.createElement("div");
  titleEl.className = "play-title";
  titleEl.innerHTML = `<span class="play-title-name"></span><span class="play-title-meta"></span>`;
  (titleEl.firstChild as HTMLElement).textContent = level.title;
  const twoHands = levelLines(level).length > 1;
  // Hands the player plays: both on a two-hand level, unless practising one of them.
  const hands: Hand[] = solo !== undefined && twoHands ? [solo] : twoHands ? [0, 1] : [0];
  (titleEl.lastChild as HTMLElement).textContent = t("play.meta", { bpm: level.bpm, what: t(demo ? "play.metaListening" : mode === "practice" ? (guide ? "play.metaAlong" : "play.metaPractice") : "play.metaCountIn") });
  topbar.append(homeButton, titleEl);
  // While playing: restart and stop, as icons so they fit on a phone. The back arrow takes over
  // once the run is over (the results' own actions cover the rest).
  const runControls = document.createElement("div");
  runControls.className = "run-controls";
  const iconButton = (label: string, key: string, svg: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-keyshortcuts", key);
    button.title = `${label} (${key})`;
    button.innerHTML = `${svg}<kbd class="kbd">${key}</kbd>`;
    button.addEventListener("click", onClick);
    return button;
  };
  const restartButton = iconButton(
    t(demo ? "play.startOver" : "play.restart"),
    "R",
    `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.05-4.95M5 4v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    () => leave(() => (demo ? callbacks.onListen() : callbacks.onRetry())),
  );
  const stopButton = iconButton(
    t("play.stop"),
    "Esc",
    `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>`,
    () => finish("stopped"),
  );
  runControls.append(restartButton, stopButton);
  topbar.appendChild(runControls);
  screen.appendChild(topbar);

  /** Free practice, independent hands: on the results, play again with both hands or one. */
  let handSwitch: HTMLElement | null = null;
  if (options.handChoice && twoHands && !demo) {
    const onPick = options.handChoice.onPick;
    handSwitch = document.createElement("div");
    handSwitch.className = "hand-switch bento-cell";
    handSwitch.setAttribute("role", "group");
    handSwitch.setAttribute("aria-label", t("play.againWith"));
    const handLabel = document.createElement("span");
    handLabel.className = "option-label";
    handLabel.textContent = t("play.againWith");
    handSwitch.appendChild(handLabel);
    const choices: [Hand | undefined, string][] = [
      [undefined, t("play.bothHands")],
      [1, t("play.rightHand")],
      [0, t("play.leftHand")],
    ];
    for (const [hand, label] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      const current = hand === solo;
      button.setAttribute("aria-pressed", String(current));
      if (!current) button.addEventListener("click", () => leave(() => onPick(hand)));
      handSwitch.appendChild(button);
    }
  }

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
  // The key box is for keyboards only; touch screens hide it (.kbd).
  const zoneLabel = (words: string, key: string) => `${words} <kbd class="kbd">${key}</kbd>`;
  zoneLeftLabel.innerHTML = demo ? "" : twoHands ? (solo === 1 ? "" : zoneLabel(t("play.zoneLeft"), "F")) : zoneLabel(t("play.zoneTap"), "F");
  zoneLeft.appendChild(zoneLeftLabel);
  const zoneRight = document.createElement("div");
  zoneRight.className = "tap-zone tap-zone-right";
  const zoneRightLabel = document.createElement("span");
  zoneRightLabel.className = "tap-zone-label";
  zoneRightLabel.innerHTML = demo ? "" : twoHands ? (solo === 0 ? "" : zoneLabel(t("play.zoneRight"), "J")) : zoneLabel(t("play.zoneTap"), "J");
  zoneRight.appendChild(zoneRightLabel);
  tapArea.append(zoneLeft, zoneRight);
  stage.appendChild(tapArea);

  const gradeFlash = document.createElement("div");
  gradeFlash.className = "grade-flash";
  plateSlot.appendChild(gradeFlash);

  // The results take the whole screen under the top bar: the sand's final figure on top, the
  // numbers and notes below it, and the actions pinned to the bottom edge.
  const resultsOverlay = document.createElement("div");
  resultsOverlay.className = "results-overlay";
  resultsOverlay.hidden = true;
  const resultsFigure = document.createElement("div");
  resultsFigure.className = "results-figure";
  const resultsBody = document.createElement("div");
  resultsBody.className = "results-body";
  resultsOverlay.append(resultsFigure, resultsBody);
  screen.appendChild(resultsOverlay);

  // "See where it went": the whole piece, every note in its grade colour, with a way back.
  const reviewBar = document.createElement("div");
  reviewBar.className = "review-bar";
  reviewBar.hidden = true;
  const reviewHint = document.createElement("span");
  reviewHint.className = "review-hint";
  const canHover = typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
  reviewHint.textContent = t(canHover ? "play.reviewHover" : "play.reviewTouch");
  const reviewBack = document.createElement("button");
  reviewBack.type = "button";
  reviewBack.className = "results-button review-back";
  reviewBack.textContent = t("play.backToResults");
  reviewBar.append(reviewHint, reviewBack);
  screen.appendChild(reviewBar);

  container.appendChild(screen);

  /** While playing, the sand runs edge to edge; when the run ends it sits at the top of the results. */
  let immersive = true;
  function placePlate(snap = false): void {
    if (!immersive) {
      if (isPhoneBackdrop()) {
        // Phones: the sand lies quietly behind the whole results page, still while it scrolls,
        // and slides away for the review so the notes stand alone.
        const reviewing = screen.classList.contains("reviewing");
        scene.setDim(reviewing ? 1 : tweak("sandResults"));
        scene.setPlate(window.innerWidth / 2, window.innerHeight * (reviewing ? 1.9 : 0.42), window.innerWidth * 0.72);
        return;
      }
      const rect = resultsFigure.getBoundingClientRect();
      // Reviewing the piece hides the results: the sand stays where it was, dimmed.
      if (rect.width === 0) return;
      if (!screen.classList.contains("reviewing")) scene.setDim(0);
      // The finished figure is framed from above, like a picture.
      scene.setSteep(true);
      // Side by side (wide screens) it sits in its own column; stacked (tablets) it is larger and
      // runs a little way behind the top of the results block.
      const sideBySide = window.innerWidth >= 900 && window.innerWidth >= window.innerHeight;
      const radius = sideBySide ? Math.max(40, Math.min(rect.width * 0.38, rect.height * 0.5)) : Math.max(40, Math.min(rect.width * 0.46, rect.height * 0.9));
      scene.setPlate(rect.left + rect.width / 2, rect.top + rect.height * (sideBySide ? 0.5 : 0.7), radius, snap);
      return;
    }
    const rect = plateSlot.getBoundingClientRect();
    const framed = Math.max(40, Math.min(rect.width * 0.42, rect.height * 1.05));
    scene.setPlate(rect.left + rect.width / 2, rect.top + rect.height * 0.52, Math.max(window.innerWidth * 0.62, framed * 1.6), snap);
  }
  const plateObserver = new ResizeObserver(() => placePlate());
  plateObserver.observe(plateSlot);
  plateObserver.observe(resultsFigure);
  placePlate();
  const offTweak = onTweak(() => {
    if (!immersive) placePlate();
  });

  const baseFigure = figureSeed(level.id);
  // The sand keeps whatever figure it last settled into; the piece's own figure takes over
  // as the player plays, and moves on to the next one each time a bar is played cleanly.
  scene.reset();
  scene.setFigure(baseFigure);
  scene.setAmbient(0);
  scene.setDim(0);

  const staff = renderStaff(staffContainer, level, { theme: "light" });
  staff.setAnimate(true);
  // The notes area shows whole lines only, as many as fit in about 40% of the screen (at least
  // one), so a line is never sliced through — two-hand lines, with two staves each, are tall.
  // A short piece gets exactly its own height.
  /** Share of the screen height the notes may take. */
  const staffShare = 0.4;
  /** While playing, the next line is always in view too, if two lines fit in 60% of the screen. */
  const minLines = 2;
  function fitStaffArea(): void {
    // After the run the staff is either hidden or shown whole (review), sized by CSS.
    if (screen.classList.contains("finished")) return;
    const layout = staff.layout();
    // The window shows `lines` whole lines. staff.layout measures the real ink of every line
    // (tuplet numbers, stems, ties), so the top line is fully visible with a small margin and
    // the bottom is cut just above the next line's highest element.
    const fit = (share: number) => Math.floor((window.innerHeight * share) / layout.systemHeight);
    const lines = Math.max(1, fit(staffShare), Math.min(minLines, fit(0.6)));
    const height = Math.min(layout.contentBottom - layout.scrollTopOf(0), layout.windowHeight(lines));
    staffArea.style.height = `${height}px`;
    staffArea.style.maxHeight = "none";
    staffArea.style.flexShrink = "0";
    // Room below the music, so even the last line can scroll to the top of the window (without
    // it the scroll stops short and the view sits between two lines).
    staffContainer.style.paddingBottom = `${height}px`;
    staffContainer.style.boxSizing = "border-box";
    const current = timeline[Math.min(nextPointer, timeline.length - 1)];
    if (current) staff.revealEvent(primaryEventIndex(current));
  }
  // The staff rebuilds itself on a width change (its observer runs after layout), so refit once
  // more a frame later in case the line spacing changed with it.
  const onWindowResize = (): void => {
    fitStaffArea();
    requestAnimationFrame(() => requestAnimationFrame(fitStaffArea));
  };
  window.addEventListener("resize", onWindowResize);
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

  /** Bars (0-based) with a miss, an "ok" or an extra tap in them: they don't change the figure. */
  const dirtyBars = new Set<number>();
  function markBarDirty(beat: number): void {
    dirtyBars.add(Math.max(0, Math.floor(beat / beatsPerBar)));
  }

  function setTimelineState(item: TimelineItem, state: NoteState): void {
    if (state === "miss" || state === "ok") markBarDirty(item.beat);
    if (item.kind === "note") {
      for (const eventIndex of item.eventIndices) staff.setState(eventIndex, state);
    } else {
      staff.setState(item.eventIndex, state);
    }
  }

  const secPerQuarter = 60 / level.bpm;
  /** Bar length in quarter notes (6/8 is 3), the unit every beat position here is counted in. */
  const beatsPerBar = barQuarters(level.meter);
  // The metronome clicks the written beat unit: quarters in 4/4 and 3/4, eighths in 6/8 (with
  // beats 1 and 4 accented, so the bar is felt in two).
  const secPerClick = secPerQuarter * (4 / level.meter.beatUnit);
  const clicksPerBar = level.meter.beats;
  const clickGroup = level.meter.beatUnit === 8 && clicksPerBar % 3 === 0 ? 3 : 1;
  const startTime = engine.now() + beatsPerBar * secPerQuarter + LEAD_IN_SEC;
  const firstClickTime = engine.scheduleCountIn(startTime, clicksPerBar, secPerClick, clickGroup);

  if (mode === "practice" || demo) {
    engine.startMetronome(startTime, secPerClick, clicksPerBar, level.bars.length, clickGroup);
  }
  // Notes the game plays itself, on the felt piano: every note when listening, otherwise the
  // other hand's line when practising one hand. stopAll cancels them with the metronome.
  for (const o of allOnsets) {
    const line = (o.line ?? 0) as Hand;
    const playedByGame = demo || !hands.includes(line);
    // A guide plays the player's own notes too, but only just audibly.
    if (!playedByGame && !(guide && mode === "practice")) continue;
    engine.scheduleNote(ZONE_PITCH[line], demo ? 0.75 : playedByGame ? 0.45 : GUIDE_VELOCITY, startTime + o.beat * secPerQuarter, o.quarters * secPerQuarter * 0.92);
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
  // Count-in is scored by order: each tap is the next note, so a pause waits for you.
  const sequential = mode === "countIn" && !demo;
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
  let tooltipEvent: number | null = null;
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
      showGradeFlash("miss", inOwnRest ? t("flash.rest") : otherHandDue(hit) ? t("flash.otherHand") : t("flash.extra"));
      if (current) staff.pulse(primaryEventIndex(current), "miss");
      markBarDirty(liveJudge.beatAt(hit.time));
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
    const onset = onsets[judged.onsetIndex];
    if (onset && (judged.grade === "ok" || judged.grade === "miss")) markBarDirty(onset.beat);
    scene.strike(judged.grade, lastPress.x, lastPress.y, onset?.quarters ?? 1);
    // The feedback sits where the eyes are: on the note just played.
    if (onset) staff.pulse(onset.eventIndex, judged.grade);

    if (onset) {
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
    showGradeFlash(judged.grade, judged.resynced ? t("flash.backIn") : attackWords(judged.grade, judged.errorMs ?? 0));
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
        const clickAt = firstClickTime + i * secPerClick;
        dots[i]?.classList.toggle("lit", t >= clickAt && t < clickAt + secPerClick * 0.35);
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
    const click = Math.floor((t - startTime) / secPerClick);
    const phase = (t - startTime) / secPerClick - click;
    for (let i = 0; i < dots.length; i++) {
      const on = pulsing && click % clicksPerBar === i;
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
    const where = current ? t("lost.where", { bar: barOf(current.beat) }) : "";
    if (missedInARow >= (clockDriven ? LOST_MISSED_NOTES_CLOCKED : LOST_MISSED_NOTES)) lostReason = t("lost.missed", { n: missedInARow, where });
    else if (strayInARow >= LOST_STRAY_TAPS) lostReason = t("lost.stray", { n: strayInARow, where });
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
  /** How many bars have been closed out (every note in them settled), and how many were clean. */
  let closedBars = 0;
  let figureStep = 0;

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
      lostReason = t("lost.stopped", { bar: barOf(beatNow) });
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
        scene.strike("perfect", null, null, onset?.quarters ?? 1);
      }
      moved = true;
    }
    if (moved) {
      nextPointer = Math.max(...nowByHand.values());
      // While the music rests (in every hand), the sand settles flat.
      scene.setRest([...nowByHand.values()].every((i) => timeline[i]?.kind === "rest"));
    }

    // A bar whose notes are all settled and none went wrong moves the sand on to the next figure.
    while (closedBars < level.bars.length) {
      const bar = closedBars;
      const endBeat = (bar + 1) * beatsPerBar;
      if (beatNow < endBeat) break;
      let itemsInBar = 0;
      while (itemsInBar < timeline.length && (timeline[itemsInBar]?.beat ?? Infinity) < endBeat) itemsInBar++;
      if (settledUpTo < itemsInBar) break;
      closedBars++;
      if (!dirtyBars.has(bar)) {
        figureStep++;
        scene.setFigure(baseFigure + figureStep);
      }
    }

    // Only ever forward: the audio clock can jitter back a few ms (and count-in's projected
    // pulse is re-fitted after taps), which at a bar line used to flick the staff back a line.
    const bar = Math.min(level.bars.length - 1, Math.floor(beatNow / beatsPerBar));
    if (bar > shownBar) {
      shownBar = bar;
      staff.setBarHighlight(bar);
      staff.revealEvent(staff.firstEventOfBar(bar));
      barCounter.textContent = t("play.bar", { bar: bar + 1, n: level.bars.length });
    }
  }

  /** Silence check: nothing played for a couple of bars after a note was due. */
  function checkSilence(now: number): void {
    let due: number | null = null;
    for (let i = nextPointer; i < timeline.length; i++) {
      const item = timeline[i];
      if (item?.kind === "note") {
        const onset = onsets[item.onsetIndex];
        if (onset) due = liveJudge.predictTime(onset.beat);
        if (onset && due !== null && now > due + LOST_SILENT_BARS * beatsPerBar * secPerQuarter) {
          lostReason = matchedCount === 0 ? t("lost.nothing") : t("lost.stopped", { bar: barOf(onset.beat) });
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
    // Hovering along the same note keeps its tooltip where it is.
    if (tooltipEl && eventIndex === tooltipEvent) return;
    tooltipEvent = eventIndex;
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
  // With a mouse, the review explains a note on hover: no click needed.
  staffContainer.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") handleStaffTap(e.clientX, e.clientY);
  });
  staffContainer.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") hideTooltip();
  });

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

    const result = judgeRun(onsets, rests, startTime, level.bpm, hits, releases, { grid, matches: liveMatches, sequential, beatsPerBar });
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

    showResultsLayer();

    const panelCallbacks = {
      onRetry: (bpm?: number) => leave(() => callbacks.onRetry(bpm)),
      onNext: (bpm?: number) => leave(() => callbacks.onNext(bpm)),
      onHome: () => leave(callbacks.onHome),
      onListen: () => leave(callbacks.onListen),
      onReview: () => setReviewing(true),
    };
    // A lesson step passed at its goal tempo: moving on is the main action. Otherwise another go.
    const passed = outcome === "done" && options.goal !== undefined && result.accuracy >= options.goal.pass && level.bpm >= options.goal.bpm;
    const retryTempo = { bpm: level.bpm, nextLabel: options.nextLabel, goal: options.goal, primary: passed ? ("next" as const) : ("retry" as const) };
    if (outcome === "done") {
      callbacks.onComplete?.(result.accuracy);
      const quality = result.judgements.some((j) => j.hitTime !== null) ? result.accuracy / 100 : 0;
      scene.reveal(quality);
      engine.setAmbience(0.8, 3);
      if (quality > 0) engine.chime(quality);
      resultsBody.appendChild(buildResultsPanel(result, level.bpm, mode, panelCallbacks, retryTempo));
      placeHandSwitch();
    } else {
      // No reveal: the sand just settles back into the void.
      scene.setAmbient(0.12);
      if (outcome === "lost") scene.fling();
      else scene.setRest(true);
      engine.setAmbience(0.5, 2);
      const title = outcome === "lost" ? t("ended.lost") : t("ended.stopped");
      const detail = outcome === "lost" ? (lostReason ?? "") : t("ended.youStopped");
      resultsBody.appendChild(buildEndedEarlyPanel(title, detail, panelCallbacks, retryTempo));
      placeHandSwitch();
    }
  }

  /** The hand choice is the last cell above the results' actions. */
  function placeHandSwitch(): void {
    const scroll = resultsBody.querySelector(".bento-scroll");
    if (handSwitch && scroll) scroll.appendChild(handSwitch);
  }

  /** The play area gives way to the full-screen results, with the sand on top. */
  function showResultsLayer(): void {
    tapArea.hidden = true;
    screen.classList.add("finished");
    immersive = false;
    resultsBody.innerHTML = "";
    resultsOverlay.hidden = false;
    resultsOverlay.scrollTop = 0;
    placePlate();
  }

  /** Switches between the results and the whole piece marked with how each note went. */
  function setReviewing(on: boolean): void {
    hideTooltip();
    screen.classList.toggle("reviewing", on);
    resultsOverlay.hidden = on;
    reviewBar.hidden = !on;
    scene.setDim(on ? 0.85 : 0);
    if (on) {
      staffContainer.style.paddingBottom = "24px";
      staffContainer.scrollTop = 0;
    }
    placePlate(!on);
  }
  reviewBack.addEventListener("click", () => setReviewing(false));

  /** After listening: the staff settles, and the player is invited to take their turn. */
  function finishListening(outcome: "done" | "lost" | "stopped"): void {
    staff.setAnimate(false);
    gradeFlash.classList.remove("show");
    showResultsLayer();
    if (outcome === "done") scene.reveal(0.95);
    engine.setAmbience(0.6, 2);
    resultsBody.appendChild(
      buildListenedPanel({
        onPlay: () => leave(() => callbacks.onRetry()),
        onListen: () => leave(callbacks.onListen),
        onHome: () => leave(callbacks.onHome),
      }),
    );
  }

  /** Leaving the screen for good: the plate stops following this layout. */
  function leave(then: () => void): void {
    offTweak();
    scene.setDim(0);
    scene.setSteep(false);
    window.removeEventListener("resize", onWindowResize);
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
      else if (screen.classList.contains("reviewing")) setReviewing(false);
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
      // Enter takes the big action; N moves on.
      resultsOverlay.querySelector<HTMLButtonElement>(".results-main")?.click();
    } else if (key === "n" && ended && !demo) {
      event.preventDefault();
      const chosen = Number(resultsOverlay.querySelector<HTMLElement>("[data-retry-bpm]")?.dataset.retryBpm);
      leave(() => callbacks.onNext(Number.isFinite(chosen) && chosen > 0 && chosen !== level.bpm ? chosen : undefined));
    } else if (ended && !demo && (key === "-" || key === "+" || key === "=")) {
      event.preventDefault();
      resultsOverlay.querySelector<HTMLButtonElement>(key === "-" ? ".retry-tempo .step:first-child" : ".retry-tempo .step:last-child")?.click();
    }
  }
  window.addEventListener("keydown", handleKey);

  rafId = requestAnimationFrame(tick);
}

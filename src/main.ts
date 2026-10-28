// Entry point: wires the home screen, optional first-run calibration, and the play screen
// together. The AudioEngine is created once and reused across levels/retries.

import "./style.css";
import { createAudioEngine } from "./audio/engine";
import { runCalibration } from "./input/calibration";
import { type FreeChoice, leaveHome, renderHome } from "./game/home";
import { firstOpenPiece, handsAreIndependent, LESSONS, loadProgress, PASS_ACCURACY, pieceLevel, recordResult } from "./game/lessons";
import { createScene } from "./scene/resonance";
import { startPlay } from "./game/play";
import { generateLevel } from "./rhythm/generate";
import { generateTwoHandLevel } from "./rhythm/twoHands";
import type { Hand, Level, Mode } from "./types";
import { installInk } from "./ui/ink";
import { installTweaks } from "./ui/tweaks";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const engine = createAudioEngine();

// One WebGL scene for the whole app, fixed behind every screen; screens only tell it what to do.
installTweaks();
installInk();

const canvas = document.createElement("canvas");
canvas.id = "scene";
canvas.setAttribute("aria-hidden", "true");
document.body.prepend(canvas);
const scene = createScene(canvas);
if (!scene.supported) document.body.classList.add("no-webgl");
// Dev-only handle for scripted test runs in the browser.
if (import.meta.env.DEV) (window as unknown as { __resonance: unknown }).__resonance = { engine, scene };

// The ambient drone respects the player's sound preference; screens just ask for a level.
const AMBIENCE_KEY = "resonance.ambience";
function ambienceOn(): boolean {
  try {
    return localStorage.getItem(AMBIENCE_KEY) !== "off";
  } catch {
    return true;
  }
}
const rawSetAmbience = engine.setAmbience.bind(engine);
const rawChime = engine.chime.bind(engine);
let ambienceLevel = 0;
engine.setAmbience = (level: number, rampSec?: number) => {
  ambienceLevel = level;
  rawSetAmbience(ambienceOn() ? level : 0, rampSec);
};
engine.chime = (quality: number) => {
  if (ambienceOn()) rawChime(quality);
};
// The plate tap sound has its own switch: on phone speakers it trails the finger by
// ~0.2 s, which some players find distracting.
const TAP_SOUND_KEY = "resonance.tapSound";
function tapSoundOn(): boolean {
  try {
    return localStorage.getItem(TAP_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}
function setTapSoundOn(on: boolean): void {
  try {
    localStorage.setItem(TAP_SOUND_KEY, on ? "on" : "off");
  } catch {
    // Not persisted; still applies for this visit.
  }
}
const rawNoteOn = engine.noteOn.bind(engine);
engine.noteOn = (freq: number, velocity?: number) => (tapSoundOn() ? rawNoteOn(freq, velocity) : 0);

function setAmbienceOn(on: boolean): void {
  try {
    localStorage.setItem(AMBIENCE_KEY, on ? "on" : "off");
  } catch {
    // Not persisted; still applies for this visit.
  }
  rawSetAmbience(on ? ambienceLevel : 0, 0.8);
}

// Browsers keep audio locked until a gesture: the first touch anywhere wakes the drone.
document.addEventListener(
  "pointerdown",
  () => {
    void engine.unlock().then(() => engine.setAmbience(ambienceLevel || 0.6));
  },
  { once: true, capture: true },
);

// iOS Safari ignores user-scalable=no and doesn't always honour touch-action, so block its
// pinch gestures and treat a second touch within 300 ms as a tap, not a zoom. Tap targets
// still get their pointerdown; only the browser's default zoom is cancelled.
document.addEventListener("gesturestart", (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener(
  "touchend",
  (e) => {
    const now = e.timeStamp;
    // Controls are exempt (CSS touch-action already stops zoom there), so quick repeated
    // taps on a button, like tempo +, all count.
    const onControl = e.target instanceof Element && e.target.closest("button, select, input, [role='option']");
    if (now - lastTouchEnd < 300 && !onControl) e.preventDefault();
    lastTouchEnd = now;
  },
  { passive: false },
);

// Mirrors input/calibration.ts's own storage key: used only to detect "no saved offset yet",
// not to read/write the value itself (that stays calibration.ts's job via loadOffset/saveOffset).
const OFFSET_STORAGE_KEY = "resonance.latencyOffset";

function hasSavedOffset(): boolean {
  try {
    return localStorage.getItem(OFFSET_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** A level to play plus how to get the one after it ("Next level"). */
interface LevelPick {
  level: Level;
  next: () => LevelPick | null;
  /** Two-hand steps: practise this hand alone (the other is played for you). */
  solo?: Hand;
  /** Where this pick sits in a sequence of steps, for the step indicator. */
  steps?: { labels: string[]; current: number };
  /** Label for the results' main "next" action. */
  nextLabel?: string;
  /** The mode this pick is played in, when it decides it (a lesson step does). */
  mode?: Mode;
  /** Free practice, independent hands: the exercise offers playing one hand alone. */
  handChoice?: boolean;
  /** A lesson step: where its result is recorded. */
  lesson?: { index: number; piece: number; step: number };
  /** Play-along: the game quietly plays the player's notes too. */
  guide?: boolean;
  /** Start by hearing the exercise (then "your turn"). */
  listenFirst?: boolean;
  /** A lesson step's goal tempo and passing accuracy. */
  goal?: { bpm: number; pass: number };
}

/**
 * A step of a lesson piece as a playable exercise. Every step of a piece plays the same fixed
 * notes (see lessons.ts); only the help differs. `bpm` is the tempo chosen for the step.
 */
function lessonPick(lessonIndex: number, pieceIndex: number, stepIndex: number, bpm?: number): LevelPick | null {
  const lesson = LESSONS[lessonIndex];
  if (!lesson) return null;
  const step = lesson.steps[stepIndex];
  if (!step) return lessonPick(lessonIndex + 1, firstOpenPiece(loadProgress(), LESSONS[lessonIndex + 1] ?? lesson), 0);
  const level = { ...pieceLevel(lesson, pieceIndex, bpm ?? step.bpm), title: `${lesson.title}, piece ${pieceIndex + 1}: ${step.label.toLowerCase()}` };
  const lastStep = stepIndex === lesson.steps.length - 1;
  return {
    level,
    mode: step.mode,
    solo: step.solo,
    guide: step.guide,
    // Play-along starts with hearing the piece.
    listenFirst: step.guide,
    goal: { bpm: step.bpm, pass: PASS_ACCURACY },
    steps: { labels: lesson.steps.map((s) => s.label), current: stepIndex },
    nextLabel: lastStep ? "Next lesson" : `Next: ${lesson.steps[stepIndex + 1]?.label.toLowerCase()}`,
    lesson: { index: lessonIndex, piece: pieceIndex, step: stepIndex },
    // The next step suggests its own tempo.
    next: () => (lastStep ? lessonPick(lessonIndex + 1, firstOpenPiece(loadProgress(), LESSONS[lessonIndex + 1] ?? lesson), 0) : lessonPick(lessonIndex, pieceIndex, stepIndex + 1)),
  };
}

/** The same pick, and every one after it, played with `solo` (one hand, or both when undefined). */
function keepSolo(pick: LevelPick, solo: Hand | undefined): LevelPick {
  return {
    ...pick,
    solo,
    next: () => {
      const next = pick.next();
      return next ? keepSolo(next, solo) : null;
    },
  };
}

/** Free practice: an exercise built from the chosen ingredients. */
function freePick(choice: FreeChoice): LevelPick {
  const again = () => freePick(choice);
  if (choice.hands === 2) {
    const level = withTempo(generateTwoHandLevel({ stage: choice.stage, cross: choice.cross, ingredients: choice.ingredients, bars: choice.bars }));
    // Independent hands: the hand(s) chosen on home, and another choice on the results.
    const independent = handsAreIndependent(choice.stage, choice.cross);
    const solo: Hand | undefined = !independent || choice.part === "both" ? undefined : choice.part === "right" ? 1 : 0;
    return { level, next: again, solo, handChoice: independent, nextLabel: "New exercise" };
  }
  return { level: withTempo(generateLevel({ tier: 1, ingredients: choice.ingredients, meter: choice.meter, bars: choice.bars })), next: again, nextLabel: "New exercise" };
}

// Practice tempo: null plays each level at its own tempo; a number overrides it.
const TEMPO_KEY = "resonance.tempo";
function loadTempo(): number | null {
  try {
    const n = Number(localStorage.getItem(TEMPO_KEY));
    return Number.isFinite(n) && n >= 40 && n <= 200 ? n : null;
  } catch {
    return null;
  }
}
function saveTempo(bpm: number | null): void {
  try {
    if (bpm === null) localStorage.removeItem(TEMPO_KEY);
    else localStorage.setItem(TEMPO_KEY, String(bpm));
  } catch {
    // Not persisted; still applies for this visit.
  }
}
let tempo = loadTempo();
function withTempo(level: Level): Level {
  return tempo === null ? level : { ...level, bpm: tempo };
}



function showHome(): void {
  renderHome(app as HTMLElement, {
    engine,
    scene,
    tempo: {
      get: () => tempo,
      set: (bpm: number | null) => {
        tempo = bpm;
        saveTempo(bpm);
      },
    },
    sounds: [
      { label: "Ambience", isOn: ambienceOn, set: setAmbienceOn },
      { label: "Tap sound", isOn: tapSoundOn, set: setTapSoundOn },
    ],
    onLesson: (lessonIndex, pieceIndex, stepIndex, bpm) => {
      const pick = lessonPick(lessonIndex, pieceIndex, stepIndex, bpm);
      beginLevel(pick, "practice", pick?.listenFirst);
    },
    onFree: (choice) => beginLevel(freePick(choice), choice.mode),
  });
}

function beginLevel(pick: LevelPick | null, mode: Mode, listen = false): void {
  // engine.unlock() must run synchronously inside the click gesture that reaches this function.
  if (pick) void doBeginLevel(pick, pick.mode ?? mode, listen);
}

async function doBeginLevel(pick: LevelPick, mode: Mode, listen: boolean): Promise<void> {
  leaveHome();
  await engine.unlock();

  if (!hasSavedOffset()) {
    const root = app as HTMLElement;
    root.innerHTML = "";
    const calContainer = document.createElement("div");
    calContainer.className = "calibration-screen";
    root.appendChild(calContainer);
    scene.setDim(0.6);
    // The sand rests low on the screen, clear of the instructions.
    scene.setPlate(window.innerWidth / 2, window.innerHeight * (window.innerWidth < window.innerHeight * 0.9 ? 0.8 : 0.86), Math.min(window.innerWidth * 0.42, 420));
    await runCalibration(engine, calContainer);
  }

  // Dev-only: the level being played, for scripted test runs.
  if (import.meta.env.DEV) (window as unknown as { __resonance: Record<string, unknown> }).__resonance.level = pick.level;
  startPlay(
    app as HTMLElement,
    engine,
    scene,
    pick.level,
    mode,
    {
      onHome: showHome,
      // Retry is the same exercise, at the tempo chosen on the results when there is one.
      onRetry: (bpm) => beginLevel(bpm ? { ...pick, level: { ...pick.level, bpm } } : pick, mode),
      onNext: (bpm) => {
        const next = pick.next();
        // A tempo chosen on the results carries into the next exercise. Without one, free
        // practice keeps the tempo it's being practised at (a lesson step suggests its own).
        if (next && (bpm || !next.lesson)) next.level = { ...next.level, bpm: bpm ?? pick.level.bpm };
        beginLevel(next, mode, next?.listenFirst);
      },
      onListen: () => beginLevel(pick, mode, true),
      onComplete: (accuracy) => {
        if (pick.lesson) {
          const lesson = LESSONS[pick.lesson.index];
          if (lesson) recordResult(lesson, pick.lesson.piece, pick.lesson.step, accuracy, pick.level.bpm);
        }
      },
    },
    {
      solo: pick.solo,
      demo: listen,
      guide: pick.guide,
      goal: pick.goal,
      steps: pick.steps,
      nextLabel: pick.nextLabel,
      // Switching hands restarts the same exercise with that hand alone (or both).
      // The hand chosen there carries on into the next exercise too.
      handChoice: pick.handChoice
        ? {
            onPick: (solo) => beginLevel(keepSolo(pick, solo), mode),
          }
        : undefined,
    },
  );
}

showHome();

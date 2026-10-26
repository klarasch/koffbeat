// Entry point: wires the home screen, optional first-run calibration, and the play screen
// together. The AudioEngine is created once and reused across levels/retries.

import "./style.css";
import { createAudioEngine } from "./audio/engine";
import { runCalibration } from "./input/calibration";
import { leaveHome, renderHome } from "./game/home";
import { createScene } from "./scene/resonance";
import { startPlay } from "./game/play";
import { generateLevel } from "./rhythm/generate";
import { generateTwoHandLevel } from "./rhythm/twoHands";
import type { Level, Mode } from "./types";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const engine = createAudioEngine();

// One WebGL scene for the whole app, fixed behind every screen; screens only tell it what to do.
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
    if (now - lastTouchEnd < 300) e.preventDefault();
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

function randomPick(tier: number, bars: 4 | 8 | 16): LevelPick {
  return { level: withTempo(generateLevel({ tier, bars })), next: () => randomPick(tier, bars) };
}

function twoHandPick(stage: number, tier: number, bars: 4 | 8 | 16): LevelPick {
  return { level: withTempo(generateTwoHandLevel({ stage, tier, bars })), next: () => twoHandPick(stage, tier, bars) };
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
    onRandom: (tier, bars, mode) => beginLevel(randomPick(tier, bars), mode),
    onTwoHands: (stage, tier, bars, mode) => beginLevel(twoHandPick(stage, tier, bars), mode),
  });
}

function beginLevel(pick: LevelPick | null, mode: Mode): void {
  // engine.unlock() must run synchronously inside the click gesture that reaches this function.
  if (pick) void doBeginLevel(pick, mode);
}

async function doBeginLevel(pick: LevelPick, mode: Mode): Promise<void> {
  leaveHome();
  await engine.unlock();

  if (!hasSavedOffset()) {
    const root = app as HTMLElement;
    root.innerHTML = "";
    const calContainer = document.createElement("div");
    calContainer.className = "calibration-screen";
    root.appendChild(calContainer);
    scene.setDim(0.6);
    await runCalibration(engine, calContainer);
  }

  // Dev-only: the level being played, for scripted test runs.
  if (import.meta.env.DEV) (window as unknown as { __resonance: Record<string, unknown> }).__resonance.level = pick.level;
  startPlay(app as HTMLElement, engine, scene, pick.level, mode, {
    onHome: showHome,
    onRetry: () => beginLevel(pick, mode),
    onNext: () => beginLevel(pick.next(), mode),
  });
}

showHome();

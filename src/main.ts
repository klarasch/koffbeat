// Entry point: wires the home screen, optional first-run calibration, and the play screen
// together. The AudioEngine is created once and reused across levels/retries.

import "./style.css";
import { createAudioEngine } from "./audio/engine";
import { runCalibration } from "./input/calibration";
import { renderHome } from "./game/home";
import { startPlay } from "./game/play";
import { generateLevel } from "./rhythm/generate";
import { LEVELS } from "./rhythm/levels";
import type { Level, Mode } from "./types";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const engine = createAudioEngine();

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

function fixedPick(index: number): LevelPick | null {
  const level = LEVELS[index];
  return level ? { level, next: () => fixedPick((index + 1) % LEVELS.length) } : null;
}

function randomPick(tier: number, bars: 4 | 8 | 16): LevelPick {
  return { level: generateLevel({ tier, bars }), next: () => randomPick(tier, bars) };
}

function showHome(): void {
  renderHome(app as HTMLElement, {
    levels: LEVELS,
    engine,
    onPlay: (index, mode) => beginLevel(fixedPick(index), mode),
    onRandom: (tier, bars, mode) => beginLevel(randomPick(tier, bars), mode),
  });
}

function beginLevel(pick: LevelPick | null, mode: Mode): void {
  // engine.unlock() must run synchronously inside the click gesture that reaches this function.
  if (pick) void doBeginLevel(pick, mode);
}

async function doBeginLevel(pick: LevelPick, mode: Mode): Promise<void> {
  await engine.unlock();

  if (!hasSavedOffset()) {
    const root = app as HTMLElement;
    root.innerHTML = "";
    const calContainer = document.createElement("div");
    calContainer.className = "calibration-screen";
    root.appendChild(calContainer);
    await runCalibration(engine, calContainer);
  }

  startPlay(app as HTMLElement, engine, pick.level, mode, {
    onHome: showHome,
    onRetry: () => beginLevel(pick, mode),
    onNext: () => beginLevel(pick.next(), mode),
  });
}

showHome();

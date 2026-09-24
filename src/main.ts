// Entry point: wires the home screen, optional first-run calibration, and the play screen
// together. The AudioEngine is created once and reused across levels/retries.

import "./style.css";
import { createAudioEngine } from "./audio/engine";
import { runCalibration } from "./input/calibration";
import { renderHome } from "./game/home";
import { startPlay } from "./game/play";
import { LEVELS } from "./rhythm/levels";
import type { Mode } from "./types";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const engine = createAudioEngine();

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

function showHome(): void {
  renderHome(app as HTMLElement, { levels: LEVELS, engine, onPlay: beginLevel });
}

function beginLevel(levelIndex: number, mode: Mode): void {
  // engine.unlock() must run synchronously inside the click gesture that reaches this function.
  void doBeginLevel(levelIndex, mode);
}

async function doBeginLevel(levelIndex: number, mode: Mode): Promise<void> {
  await engine.unlock();

  if (!hasSavedOffset()) {
    const root = app as HTMLElement;
    root.innerHTML = "";
    const calContainer = document.createElement("div");
    calContainer.className = "calibration-screen";
    root.appendChild(calContainer);
    await runCalibration(engine, calContainer);
  }

  const level = LEVELS[levelIndex];
  if (!level) return;

  startPlay(app as HTMLElement, engine, level, mode, {
    onHome: showHome,
    onRetry: () => beginLevel(levelIndex, mode),
    onNext: () => beginLevel((levelIndex + 1) % LEVELS.length, mode),
  });
}

showHome();

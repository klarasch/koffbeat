// Home screen: title, level list, practice/countIn mode switch, and the calibration link.

import type { AudioEngine } from "../audio/engine";
import type { Scene } from "../scene/resonance";
import { runCalibration } from "../input/calibration";
import { TIER_NAMES } from "../rhythm/generate";
import type { Level, Mode } from "../types";

export interface HomeOptions {
  levels: Level[];
  engine: AudioEngine;
  onPlay: (levelIndex: number, mode: Mode) => void;
  onRandom: (tier: number, bars: 4 | 8 | 16, mode: Mode) => void;
  scene: Scene;
  sounds: { label: string; isOn: () => boolean; set: (on: boolean) => void }[];
}

/** Cleanup for the home screen's scene choreography (figure cycling, plate tracking). */
let homeCleanup: (() => void) | null = null;

/** Stops the home screen's background choreography; call before showing another screen. */
export function leaveHome(): void {
  homeCleanup?.();
  homeCleanup = null;
}

const FIGURE_CYCLE_MS = 9000;

/** The plate floats behind the hero, gently ringing and drifting through figures. */
function startHomeScene(scene: Scene, slot: HTMLElement): void {
  leaveHome();
  let figure = Math.floor(Math.random() * 12);
  scene.reset();
  scene.setFigure(figure);
  scene.setCoherence(1);
  scene.setAmbient(0.32);
  scene.setDim(0.15);

  const place = () => {
    const rect = slot.getBoundingClientRect();
    const radius = Math.min(rect.width * 0.46, rect.height * 1.25, 460);
    scene.setPlate(rect.left + rect.width / 2, rect.top + rect.height / 2, radius);
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(slot);
  window.addEventListener("scroll", place, { passive: true });
  const timer = setInterval(() => {
    figure += 1;
    scene.setFigure(figure);
  }, FIGURE_CYCLE_MS);

  homeCleanup = () => {
    observer.disconnect();
    window.removeEventListener("scroll", place);
    clearInterval(timer);
    scene.setAmbient(0);
  };
}

const HINT_SEEN_KEY = "resonance.seenSilentModeHint";

function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function hasSeenHint(): boolean {
  try {
    return localStorage.getItem(HINT_SEEN_KEY) !== null;
  } catch {
    return true; // Storage unavailable: don't nag every time.
  }
}

function markHintSeen(): void {
  try {
    localStorage.setItem(HINT_SEEN_KEY, "1");
  } catch {
    // Storage unavailable — nothing to persist.
  }
}

export function renderHome(container: HTMLElement, opts: HomeOptions): void {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "home";

  // ---- Top: title and sound switches ----
  const top = document.createElement("header");
  top.className = "home-top";
  const titleBlock = document.createElement("div");
  const title = document.createElement("h1");
  title.className = "home-title";
  title.textContent = "Resonance";
  const tagline = document.createElement("p");
  tagline.className = "home-tagline";
  tagline.textContent = "Read the rhythm. Play in time and the sand lifts.";
  titleBlock.append(title, tagline);

  const toggles = document.createElement("div");
  toggles.className = "sound-toggles";
  for (const sound of opts.sounds) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sound-toggle";
    const paint = () => {
      const on = sound.isOn();
      button.textContent = `${sound.label} ${on ? "on" : "off"}`;
      button.classList.toggle("off", !on);
      button.setAttribute("aria-pressed", String(on));
    };
    paint();
    button.addEventListener("click", () => {
      sound.set(!sound.isOn());
      paint();
    });
    toggles.appendChild(button);
  }
  top.append(titleBlock, toggles);
  root.appendChild(top);

  // ---- Middle: the sand bed ----
  const plateSlot = document.createElement("div");
  plateSlot.className = "home-plate-slot";
  root.appendChild(plateSlot);

  // ---- Bottom: what to play, and Play ----
  const dock = document.createElement("div");
  dock.className = "home-dock";

  if (isTouchDevice() && !hasSeenHint()) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Turn off silent mode to hear the clicks.";
    dock.appendChild(hint);
    markHintSeen();
  }

  let mode: Mode = "practice";
  const modeSwitch = document.createElement("div");
  modeSwitch.className = "mode-switch";
  const practiceButton = createModeOption("Practice", true);
  const countInButton = createModeOption("Count-in", false);
  modeSwitch.append(practiceButton, countInButton);
  const modeHint = document.createElement("p");
  modeHint.className = "mode-hint";
  modeHint.textContent = "Clicks continue throughout.";
  practiceButton.addEventListener("click", () => {
    mode = "practice";
    practiceButton.classList.add("active");
    countInButton.classList.remove("active");
    modeHint.textContent = "Clicks continue throughout.";
  });
  countInButton.addEventListener("click", () => {
    mode = "countIn";
    countInButton.classList.add("active");
    practiceButton.classList.remove("active");
    modeHint.textContent = "One bar of clicks, then keep the pulse yourself.";
  });

  // Level picker: the fixed levels plus "Random", as one row of plain tiles.
  const prefs = loadRandomPrefs();
  let picked: number | "random" = loadPicked(opts.levels.length);
  const picker = document.createElement("div");
  picker.className = "level-picker";
  picker.setAttribute("role", "listbox");
  const tiles: HTMLButtonElement[] = [];
  const addTile = (key: number | "random", num: string, name: string, meta: string) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "level-tile";
    tile.setAttribute("role", "option");
    tile.innerHTML = `<span class="level-tile-num"></span><span class="level-tile-name"></span><span class="level-tile-meta"></span>`;
    (tile.children[0] as HTMLElement).textContent = num;
    (tile.children[1] as HTMLElement).textContent = name;
    (tile.children[2] as HTMLElement).textContent = meta;
    tile.addEventListener("click", () => {
      picked = key;
      savePicked(key);
      paintPicker();
    });
    tile.dataset.key = String(key);
    tiles.push(tile);
    picker.appendChild(tile);
  };
  opts.levels.forEach((level, i) => addTile(i, String(i + 1).padStart(2, "0"), level.title, `${level.bpm} bpm`));
  addTile("random", "··", "Random exercise", "new each time");

  const randomRow = document.createElement("div");
  randomRow.className = "random-row";
  const tierSelect = document.createElement("select");
  tierSelect.className = "tier-select";
  tierSelect.setAttribute("aria-label", "Difficulty");
  TIER_NAMES.forEach((name, i) => {
    const option = document.createElement("option");
    option.value = String(i + 1);
    option.textContent = `${i + 1} · ${name}`;
    tierSelect.appendChild(option);
  });
  tierSelect.value = String(prefs.tier);
  const barsSwitch = document.createElement("div");
  barsSwitch.className = "mode-switch bars-switch";
  let bars = prefs.bars;
  const barButtons = BAR_OPTIONS.map((b) => {
    const button = createModeOption(`${b}`, b === bars);
    button.setAttribute("aria-label", `${b} bars`);
    button.addEventListener("click", () => {
      bars = b;
      barButtons.forEach((other, i) => other.classList.toggle("active", BAR_OPTIONS[i] === b));
    });
    return button;
  });
  barsSwitch.append(...barButtons);
  randomRow.append(tierSelect, barsSwitch);

  const play = document.createElement("button");
  play.type = "button";
  play.className = "play-button";
  play.innerHTML = `<span class="play-button-label">Play</span><span class="play-button-what"></span>`;
  const playWhat = play.lastChild as HTMLElement;

  function paintPicker(): void {
    for (const tile of tiles) tile.classList.toggle("active", tile.dataset.key === String(picked));
    tile0Scroll();
    randomRow.hidden = picked !== "random";
    playWhat.textContent = picked === "random" ? "Random exercise" : (opts.levels[picked]?.title ?? "");
  }
  function tile0Scroll(): void {
    const active = tiles.find((t) => t.classList.contains("active"));
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  play.addEventListener("click", () => {
    if (picked === "random") {
      const tier = Number(tierSelect.value);
      saveRandomPrefs({ tier, bars });
      opts.onRandom(tier, bars, mode);
    } else {
      opts.onPlay(picked, mode);
    }
  });

  const calibrateLink = document.createElement("button");
  calibrateLink.type = "button";
  calibrateLink.className = "link-button";
  calibrateLink.textContent = "Calibrate latency";
  calibrateLink.addEventListener("click", () => {
    void (async () => {
      leaveHome();
      opts.scene.setDim(0.6);
      await opts.engine.unlock();
      container.innerHTML = "";
      const calContainer = document.createElement("div");
      calContainer.className = "calibration-screen";
      container.appendChild(calContainer);
      await runCalibration(opts.engine, calContainer);
      renderHome(container, opts);
    })();
  });

  const modeRow = document.createElement("div");
  modeRow.className = "mode-row";
  modeRow.append(modeSwitch, modeHint);
  dock.append(modeRow, picker, randomRow, play, calibrateLink);
  root.appendChild(dock);

  container.appendChild(root);
  paintPicker();
  startHomeScene(opts.scene, plateSlot);
  opts.engine.setAmbience(0.6, 2);
}

function createModeOption(label: string, active: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "mode-option active" : "mode-option";
  button.textContent = label;
  return button;
}

const PICKED_KEY = "resonance.picked";

function loadPicked(levelCount: number): number | "random" {
  try {
    const raw = localStorage.getItem(PICKED_KEY);
    if (raw === "random") return "random";
    const n = Number(raw);
    if (raw !== null && Number.isInteger(n) && n >= 0 && n < levelCount) return n;
  } catch {
    // Storage unavailable.
  }
  return 0;
}

function savePicked(key: number | "random"): void {
  try {
    localStorage.setItem(PICKED_KEY, String(key));
  } catch {
    // Not persisted; harmless.
  }
}

const RANDOM_PREFS_KEY = "resonance.randomPrefs";
const BAR_OPTIONS = [4, 8, 16] as const;

function loadRandomPrefs(): { tier: number; bars: 4 | 8 | 16 } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RANDOM_PREFS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && "tier" in parsed && "bars" in parsed) {
      const tier = Number(parsed.tier);
      const bars = BAR_OPTIONS.find((b) => b === Number(parsed.bars));
      if (tier >= 1 && tier <= TIER_NAMES.length && bars) return { tier, bars };
    }
  } catch {
    // Storage unavailable or corrupt — fall back to defaults.
  }
  return { tier: 1, bars: 4 };
}

function saveRandomPrefs(prefs: { tier: number; bars: 4 | 8 | 16 }): void {
  try {
    localStorage.setItem(RANDOM_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; harmless.
  }
}


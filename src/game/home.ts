// Home screen: title, level list, practice/countIn mode switch, and the calibration link.

import type { AudioEngine } from "../audio/engine";
import { runCalibration } from "../input/calibration";
import { TIER_NAMES } from "../rhythm/generate";
import type { Level, Mode } from "../types";

export interface HomeOptions {
  levels: Level[];
  engine: AudioEngine;
  onPlay: (levelIndex: number, mode: Mode) => void;
  onRandom: (tier: number, bars: 4 | 8 | 16, mode: Mode) => void;
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

  const title = document.createElement("h1");
  title.className = "home-title";
  title.textContent = "Resonance";
  root.appendChild(title);

  if (isTouchDevice() && !hasSeenHint()) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Turn off silent mode to hear the clicks";
    root.appendChild(hint);
    markHintSeen();
  }

  const modeSection = document.createElement("div");
  const modeLabel = document.createElement("p");
  modeLabel.className = "section-label";
  modeLabel.textContent = "Mode";
  modeSection.appendChild(modeLabel);

  let mode: Mode = "practice";
  const modeSwitch = document.createElement("div");
  modeSwitch.className = "mode-switch";

  const practiceButton = createModeOption("Practice", true);
  const countInButton = createModeOption("Count-in", false);
  modeSwitch.append(practiceButton, countInButton);
  modeSection.appendChild(modeSwitch);

  const modeHint = document.createElement("p");
  modeHint.className = "mode-hint";
  modeHint.textContent = "Clicks continue throughout.";
  modeSection.appendChild(modeHint);

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
    modeHint.textContent = "One bar of clicks, then silence — keep the pulse yourself.";
  });

  root.appendChild(modeSection);

  const levelsLabel = document.createElement("p");
  levelsLabel.className = "section-label";
  levelsLabel.textContent = "Levels";
  root.appendChild(levelsLabel);

  const list = document.createElement("ul");
  list.className = "level-list";
  opts.levels.forEach((level, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "level-item";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = level.title;
    const bpmSpan = document.createElement("span");
    bpmSpan.className = "level-item-bpm";
    bpmSpan.textContent = `${level.bpm} bpm`;
    button.append(titleSpan, bpmSpan);

    button.addEventListener("click", () => opts.onPlay(index, mode));
    li.appendChild(button);
    list.appendChild(li);
  });
  root.appendChild(list);

  root.appendChild(buildRandomSection(() => mode, opts));

  const footer = document.createElement("div");
  footer.className = "home-footer";
  const calibrateLink = document.createElement("button");
  calibrateLink.type = "button";
  calibrateLink.className = "link-button";
  calibrateLink.textContent = "Calibrate latency";
  calibrateLink.addEventListener("click", () => {
    void (async () => {
      await opts.engine.unlock();
      container.innerHTML = "";
      const calContainer = document.createElement("div");
      calContainer.className = "calibration-screen";
      container.appendChild(calContainer);
      await runCalibration(opts.engine, calContainer);
      renderHome(container, opts);
    })();
  });
  footer.appendChild(calibrateLink);
  root.appendChild(footer);

  container.appendChild(root);
}

function createModeOption(label: string, active: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "mode-option active" : "mode-option";
  button.textContent = label;
  return button;
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

/** "Random exercise": pick a tier (what's being practised) and a length, get a fresh sight-reading exercise. */
function buildRandomSection(getMode: () => Mode, opts: HomeOptions): HTMLElement {
  const prefs = loadRandomPrefs();
  const section = document.createElement("div");
  section.className = "random-section";

  const label = document.createElement("p");
  label.className = "section-label";
  label.textContent = "Random exercise";
  section.appendChild(label);

  const tierSelect = document.createElement("select");
  tierSelect.className = "tier-select";
  TIER_NAMES.forEach((name, i) => {
    const option = document.createElement("option");
    option.value = String(i + 1);
    option.textContent = `${i + 1} · ${name}`;
    tierSelect.appendChild(option);
  });
  tierSelect.value = String(prefs.tier);
  section.appendChild(tierSelect);

  const barsSwitch = document.createElement("div");
  barsSwitch.className = "mode-switch";
  let bars = prefs.bars;
  const barButtons = BAR_OPTIONS.map((b) => {
    const button = createModeOption(`${b} bars`, b === bars);
    button.addEventListener("click", () => {
      bars = b;
      barButtons.forEach((other, i) => other.classList.toggle("active", BAR_OPTIONS[i] === b));
    });
    return button;
  });
  barsSwitch.append(...barButtons);
  section.appendChild(barsSwitch);

  const start = document.createElement("button");
  start.type = "button";
  start.className = "primary-button";
  start.textContent = "New exercise";
  start.addEventListener("click", () => {
    const tier = Number(tierSelect.value);
    saveRandomPrefs({ tier, bars });
    opts.onRandom(tier, bars, getMode());
  });
  section.appendChild(start);

  return section;
}

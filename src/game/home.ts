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
  /** Practice tempo override (null = each level's own tempo). */
  tempo: { get: () => number | null; set: (bpm: number | null) => void };
}

/** Cleanup for the home screen's scene choreography (figure cycling, plate tracking). */
let homeCleanup: (() => void) | null = null;

/** Stops the home screen's background choreography; call before showing another screen. */
export function leaveHome(): void {
  homeCleanup?.();
  homeCleanup = null;
}

const FIGURE_CYCLE_MS = 15000;

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
    button.className = "text-toggle";
    const paint = () => {
      const on = sound.isOn();
      button.innerHTML = `<span class="text-toggle-label"></span><span class="text-toggle-state"></span>`;
      (button.firstChild as HTMLElement).textContent = sound.label;
      (button.lastChild as HTMLElement).textContent = on ? "on" : "off";
      button.classList.toggle("on", on);
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

  // ---- Middle: the sand ----
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

  // Settings line: mode and tempo, as words.
  let mode: Mode = "practice";
  const settings = document.createElement("div");
  settings.className = "settings-line";

  const modeGroup = optionGroup("Mode", [
    { key: "practice", label: "Practice", title: "Clicks continue throughout" },
    { key: "countIn", label: "Count-in", title: "One bar of clicks, then keep the pulse yourself" },
  ], "practice", (key) => {
    mode = key as Mode;
  });

  const tempoGroup = document.createElement("div");
  tempoGroup.className = "option-group tempo-group";
  const tempoLabel = document.createElement("span");
  tempoLabel.className = "option-label";
  tempoLabel.textContent = "Tempo";
  const slower = textButton("−", "Slower");
  const tempoValue = document.createElement("button");
  tempoValue.type = "button";
  tempoValue.className = "tempo-value";
  const faster = textButton("+", "Faster");
  tempoGroup.append(tempoLabel, slower, tempoValue, faster);
  settings.append(modeGroup, tempoGroup);

  // Level picker: the fixed levels plus "Random", as a line of words.
  const prefs = loadRandomPrefs();
  let picked: number | "random" = loadPicked(opts.levels.length);
  const picker = document.createElement("div");
  picker.className = "level-picker";
  picker.setAttribute("role", "listbox");
  picker.setAttribute("aria-label", "Level");
  const items: HTMLButtonElement[] = [];
  const addItem = (key: number | "random", num: string, name: string) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "picker-item";
    item.setAttribute("role", "option");
    item.innerHTML = `<span class="picker-num"></span><span class="picker-name"></span>`;
    (item.children[0] as HTMLElement).textContent = num;
    (item.children[1] as HTMLElement).textContent = name;
    item.dataset.key = String(key);
    item.addEventListener("click", () => {
      picked = key;
      savePicked(key);
      paint();
    });
    items.push(item);
    picker.appendChild(item);
  };
  opts.levels.forEach((level, i) => addItem(i, String(i + 1).padStart(2, "0"), level.title));
  addItem("random", "∞", "Random");

  // Random exercise options, shown only when Random is picked.
  const randomLine = document.createElement("div");
  randomLine.className = "settings-line random-line";
  const tierGroup = document.createElement("label");
  tierGroup.className = "option-group";
  const tierLabel = document.createElement("span");
  tierLabel.className = "option-label";
  tierLabel.textContent = "Difficulty";
  const tierSelect = document.createElement("select");
  tierSelect.className = "text-select";
  TIER_NAMES.forEach((name, i) => {
    const option = document.createElement("option");
    option.value = String(i + 1);
    option.textContent = `${i + 1} · ${name}`;
    tierSelect.appendChild(option);
  });
  tierSelect.value = String(prefs.tier);
  tierGroup.append(tierLabel, tierSelect);
  let bars = prefs.bars;
  const barsGroup = optionGroup(
    "Length",
    BAR_OPTIONS.map((b) => ({ key: String(b), label: `${b} bars`, title: `${b} bars` })),
    String(bars),
    (key) => {
      bars = Number(key) as 4 | 8 | 16;
    },
  );
  randomLine.append(tierGroup, barsGroup);

  const play = document.createElement("button");
  play.type = "button";
  play.className = "play-cta";
  play.innerHTML = `<span class="play-cta-word">Play</span><span class="play-cta-arrow" aria-hidden="true">→</span><span class="play-cta-what"></span>`;
  const playWhat = play.lastChild as HTMLElement;

  function levelBpm(): number {
    return picked === "random" ? 80 : (opts.levels[picked]?.bpm ?? 80);
  }

  function paint(): void {
    for (const item of items) {
      const active = item.dataset.key === String(picked);
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    }
    randomLine.hidden = picked !== "random";
    playWhat.textContent = picked === "random" ? "Random exercise" : (opts.levels[picked]?.title ?? "");
    const override = opts.tempo.get();
    tempoValue.textContent = `${override ?? levelBpm()} bpm`;
    tempoValue.classList.toggle("custom", override !== null);
    tempoValue.title = override === null ? "The level's own tempo" : "Custom tempo, click to reset";
    items.find((i) => i.classList.contains("active"))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const stepTempo = (delta: number) => {
    const current = opts.tempo.get() ?? levelBpm();
    const next = Math.max(40, Math.min(160, Math.round((current + delta) / 5) * 5));
    opts.tempo.set(next === levelBpm() ? null : next);
    paint();
  };
  slower.addEventListener("click", () => stepTempo(-5));
  faster.addEventListener("click", () => stepTempo(5));
  tempoValue.addEventListener("click", () => {
    opts.tempo.set(null);
    paint();
  });

  const start = () => {
    if (picked === "random") {
      const tier = Number(tierSelect.value);
      saveRandomPrefs({ tier, bars });
      opts.onRandom(tier, bars, mode);
    } else {
      opts.onPlay(picked, mode);
    }
  };
  play.addEventListener("click", start);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      start();
    }
  };
  window.addEventListener("keydown", onKey);

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

  const footer = document.createElement("div");
  footer.className = "home-footer";
  // Play sits at the end of the reading path, bottom right; the quiet link takes the left.
  footer.append(calibrateLink, play);
  dock.append(settings, picker, randomLine, footer);
  root.appendChild(dock);

  container.appendChild(root);
  paint();
  startHomeScene(opts.scene, plateSlot);
  const sceneCleanup = homeCleanup;
  homeCleanup = () => {
    sceneCleanup?.();
    window.removeEventListener("keydown", onKey);
  };
  opts.engine.setAmbience(0.6, 2);
}

/** A labelled group of words where exactly one is selected. */
function optionGroup(label: string, options: { key: string; label: string; title: string }[], initial: string, onPick: (key: string) => void): HTMLElement {
  const group = document.createElement("div");
  group.className = "option-group";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const labelEl = document.createElement("span");
  labelEl.className = "option-label";
  labelEl.textContent = label;
  group.appendChild(labelEl);
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "opt";
    button.textContent = option.label;
    button.title = option.title;
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => {
      for (const b of buttons) {
        const on = b === button;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
      onPick(option.key);
    });
    const on = option.key === initial;
    button.classList.toggle("active", on);
    button.setAttribute("aria-checked", String(on));
    group.appendChild(button);
    return button;
  });
  return group;
}

function textButton(text: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "opt tempo-step";
  button.textContent = text;
  button.setAttribute("aria-label", label);
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


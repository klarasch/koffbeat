// Home screen: what to practise (difficulty, hands, length), how (mode, tempo), and Play.

import type { AudioEngine } from "../audio/engine";
import type { Scene } from "../scene/resonance";
import { runCalibration } from "../input/calibration";
import { TIER_NAMES } from "../rhythm/generate";
import { MAX_TWO_HAND_TIER, TWO_HAND_STAGES } from "../rhythm/twoHands";
import type { Mode } from "../types";

export interface HomeOptions {
  engine: AudioEngine;
  /** A generated one-hand reading exercise at `tier` (see TIER_NAMES). */
  onRandom: (tier: number, bars: 4 | 8 | 16, mode: Mode) => void;
  /** A generated two-hand exercise at `stage` (see TWO_HAND_STAGES), with `tier`'s rhythms. */
  onTwoHands: (stage: number, tier: number, bars: 4 | 8 | 16, mode: Mode) => void;
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
  const prefs = loadHomePrefs();

  const root = document.createElement("div");
  root.className = "home";

  // ---- Top: wordmark and sound switches ----
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

  const plateSlot = document.createElement("div");
  plateSlot.className = "home-plate-slot";
  root.appendChild(plateSlot);

  // ---- The panel: what to practise, then how, then Play ----
  const dock = document.createElement("div");
  dock.className = "home-dock";
  if (isTouchDevice() && !hasSeenHint()) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Turn off silent mode to hear the clicks.";
    dock.appendChild(hint);
    markHintSeen();
  }
  const panel = document.createElement("section");
  panel.className = "home-panel";
  panel.setAttribute("aria-label", "Choose an exercise");

  let { tier, hands, stage, bars, mode } = prefs;

  // Difficulty: the twelve reading tiers, the heart of the curriculum.
  const tierSection = section("Difficulty");
  const ladder = document.createElement("div");
  ladder.className = "tier-ladder";
  ladder.setAttribute("role", "listbox");
  ladder.setAttribute("aria-label", "Difficulty");
  const tierItems = TIER_NAMES.map((name, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tier-item";
    item.setAttribute("role", "option");
    item.innerHTML = `<span class="tier-num"></span><span class="tier-name"></span>`;
    (item.children[0] as HTMLElement).textContent = String(i + 1).padStart(2, "0");
    (item.children[1] as HTMLElement).textContent = name;
    item.addEventListener("click", () => {
      tier = i + 1;
      paint();
    });
    ladder.appendChild(item);
    return item;
  });
  tierSection.appendChild(ladder);

  // Hands, stage (two hands only) and length.
  const shapeSection = document.createElement("div");
  shapeSection.className = "panel-row";
  const handsGroup = optionGroup("Hands", [
    { key: "1", label: "One hand", title: "One line of rhythm" },
    { key: "2", label: "Two hands", title: "Two lines: left hand on F, right hand on J" },
  ], String(hands), (key) => {
    hands = key === "2" ? 2 : 1;
    paint();
  });
  const stageGroup = optionGroup(
    "Stage",
    TWO_HAND_STAGES.map((name, i) => ({ key: String(i + 1), label: name, title: name })),
    String(stage),
    (key) => {
      stage = Number(key);
      paint();
    },
  );
  stageGroup.classList.add("stage-group");
  const lengthGroup = optionGroup(
    "Length",
    BAR_OPTIONS.map((b) => ({ key: String(b), label: `${b} bars`, title: `${b} bars` })),
    String(bars),
    (key) => {
      bars = Number(key) as 4 | 8 | 16;
      paint();
    },
  );
  shapeSection.append(handsGroup, lengthGroup, stageGroup);

  // How: mode and tempo.
  const howSection = document.createElement("div");
  howSection.className = "panel-row";
  const modeGroup = optionGroup("Mode", [
    { key: "practice", label: "Practice", title: "The metronome keeps going; play on the click" },
    { key: "countIn", label: "Count-in", title: "One bar of clicks, then keep the pulse yourself" },
  ], mode, (key) => {
    mode = key as Mode;
    paint();
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
  howSection.append(modeGroup, tempoGroup);

  const note = document.createElement("p");
  note.className = "panel-note";

  panel.append(tierSection, shapeSection, howSection, note);

  const play = document.createElement("button");
  play.type = "button";
  play.className = "play-cta";
  play.innerHTML = `<span class="play-cta-word">Play</span><span class="play-cta-arrow" aria-hidden="true">→</span><span class="play-cta-what"></span>`;
  const playWhat = play.lastChild as HTMLElement;

  const defaultBpm = () => (hands === 2 ? 72 : 80);
  const effectiveTier = () => (hands === 2 ? Math.min(tier, MAX_TWO_HAND_TIER) : tier);

  function paint(): void {
    tierItems.forEach((item, i) => {
      const active = i + 1 === tier;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      // 3/4 & 6/8 is one-hand only for now.
      item.classList.toggle("unavailable", hands === 2 && i + 1 > MAX_TWO_HAND_TIER);
    });
    stageGroup.hidden = hands !== 2;
    note.textContent = hands === 2 && tier > MAX_TWO_HAND_TIER ? "Two hands are in 4/4 for now: this plays tier 11, triplets." : mode === "practice" ? "The metronome keeps going: play on the click." : "One bar of clicks, then keep the pulse yourself.";
    const override = opts.tempo.get();
    tempoValue.textContent = `${override ?? defaultBpm()} bpm`;
    tempoValue.classList.toggle("custom", override !== null);
    tempoValue.title = override === null ? "The exercise's own tempo" : "Custom tempo, click to reset";
    const what = `${TIER_NAMES[effectiveTier() - 1] ?? ""} · ${bars} bars`;
    playWhat.textContent = hands === 2 ? `Two hands, ${TWO_HAND_STAGES[stage - 1]?.toLowerCase()} · ${what}` : what;
    saveHomePrefs({ tier, hands, stage, bars, mode });
    tierItems[tier - 1]?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  const stepTempo = (delta: number) => {
    const current = opts.tempo.get() ?? defaultBpm();
    const next = Math.max(40, Math.min(160, Math.round((current + delta) / 5) * 5));
    opts.tempo.set(next === defaultBpm() ? null : next);
    paint();
  };
  slower.addEventListener("click", () => stepTempo(-5));
  faster.addEventListener("click", () => stepTempo(5));
  tempoValue.addEventListener("click", () => {
    opts.tempo.set(null);
    paint();
  });

  const start = () => {
    if (hands === 2) opts.onTwoHands(stage, effectiveTier(), bars, mode);
    else opts.onRandom(tier, bars, mode);
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
  footer.append(calibrateLink, play);
  dock.append(panel, footer);
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

/** A labelled block inside the panel. */
function section(label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-section";
  const labelEl = document.createElement("span");
  labelEl.className = "option-label";
  labelEl.textContent = label;
  el.appendChild(labelEl);
  return el;
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

const BAR_OPTIONS = [4, 8, 16] as const;
const HOME_PREFS_KEY = "resonance.homePrefs";

interface HomePrefs {
  tier: number;
  hands: 1 | 2;
  stage: number;
  bars: 4 | 8 | 16;
  mode: Mode;
}

function loadHomePrefs(): HomePrefs {
  const fallback: HomePrefs = { tier: 4, hands: 1, stage: 1, bars: 8, mode: "practice" };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HOME_PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const r = raw as Partial<HomePrefs>;
    const tier = Number(r.tier);
    const stage = Number(r.stage);
    const bars = BAR_OPTIONS.find((b) => b === Number(r.bars));
    return {
      tier: tier >= 1 && tier <= TIER_NAMES.length ? tier : fallback.tier,
      hands: r.hands === 2 ? 2 : 1,
      stage: stage >= 1 && stage <= TWO_HAND_STAGES.length ? stage : fallback.stage,
      bars: bars ?? fallback.bars,
      mode: r.mode === "countIn" ? "countIn" : "practice",
    };
  } catch {
    return fallback;
  }
}

function saveHomePrefs(prefs: HomePrefs): void {
  try {
    localStorage.setItem(HOME_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; harmless.
  }
}

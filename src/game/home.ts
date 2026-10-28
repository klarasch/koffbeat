// Home screen: what to practise (difficulty, hands, length), how (mode, tempo), and Play.

import type { AudioEngine } from "../audio/engine";
import type { Scene } from "../scene/resonance";
import { runCalibration } from "../input/calibration";
import { chips, field, segmented, select, stepper } from "./controls";
import { describeIngredients, INGREDIENTS, type Ingredient, type MeterChoice } from "../rhythm/generate";
import { TWO_HAND_STAGES } from "../rhythm/twoHands";
import { firstOpenLesson, firstOpenStep, LESSONS, loadProgress, PASS_ACCURACY, stepDone } from "./lessons";
import type { Mode } from "../types";

export interface HomeOptions {
  engine: AudioEngine;
  /** Play a step of a lesson (see lessons.ts). */
  onLesson: (lessonIndex: number, stepIndex: number) => void;
  /** Free practice: an exercise built from the chosen ingredients. */
  onFree: (choice: FreeChoice) => void;
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
  scene.setAmbient(0.32);
  scene.setDim(0.15);

  const place = () => {
    const rect = slot.getBoundingClientRect();
    const radius = Math.min(rect.width * 0.46, rect.height * 0.95, 460);
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

  let { track, lessonIndex, ingredients, meter, hands, stage, bars, mode } = prefs;
  const progress = loadProgress();
  if (lessonIndex < 0) lessonIndex = firstOpenLesson(progress);
  let stepIndex = firstOpenStep(progress, LESSONS[lessonIndex]!);

  // ---- Track: the lesson path, or free practice ----
  const trackControl = segmented(
    [
      { value: "lessons", label: "Lessons" },
      { value: "free", label: "Free practice" },
    ],
    track,
    (value) => {
      track = value === "free" ? "free" : "lessons";
      paint();
    },
  );
  trackControl.el.classList.add("track-switch");

  // ---- Lessons ----
  const lessonSelect = select(
    LESSONS.map((lesson, i) => ({ value: String(i), label: `${i + 1}. ${lesson.title}` })),
    String(lessonIndex),
    (value) => {
      lessonIndex = Number(value);
      stepIndex = firstOpenStep(loadProgress(), LESSONS[lessonIndex]!);
      rebuildSteps();
      paint();
    },
  );
  const stepSlot = document.createElement("div");
  const stepField = field("Step", stepSlot);
  function rebuildSteps(): void {
    const lesson = LESSONS[lessonIndex]!;
    const p = loadProgress();
    const control = segmented(
      lesson.steps.map((step, i) => ({ value: String(i), label: stepDone(p, lesson, i) ? `${step.label} ✓` : step.label })),
      String(stepIndex),
      (value) => {
        stepIndex = Number(value);
        paint();
      },
    );
    stepSlot.replaceChildren(control.el);
  }
  rebuildSteps();
  const lessonFields = document.createElement("div");
  lessonFields.className = "home-fields";
  const lessonField = field("Lesson", lessonSelect.el);
  lessonField.classList.add("difficulty-field");
  lessonFields.append(lessonField, stepField);

  // ---- Free practice ----
  const ingredientChips = chips(
    INGREDIENTS.map((i) => ({ value: i.key, label: i.label })),
    ingredients,
    (values) => {
      ingredients = values as Ingredient[];
      paint();
    },
    ["quarters"],
  );
  const meterControl = segmented(
    (["4/4", "3/4", "6/8"] as const).map((m) => ({ value: m, label: m })),
    meter,
    (value) => {
      meter = value as MeterChoice;
      paint();
    },
  );
  const handsControl = segmented(
    [
      { value: "1", label: "One hand" },
      { value: "2", label: "Two hands" },
    ],
    String(hands),
    (value) => {
      hands = value === "2" ? 2 : 1;
      paint();
    },
  );
  const relateSelect = select(
    TWO_HAND_STAGES.map((name, i) => ({ value: String(i + 1), label: name })),
    String(stage),
    (value) => {
      stage = Number(value);
      paint();
    },
  );
  const lengthControl = segmented(
    BAR_OPTIONS.map((b) => ({ value: String(b), label: `${b} bars` })),
    String(bars),
    (value) => {
      bars = Number(value) as 4 | 8 | 16;
      paint();
    },
  );
  const modeControl = segmented(
    [
      { value: "practice", label: "Practice" },
      { value: "countIn", label: "Count-in" },
    ],
    mode,
    (value) => {
      mode = value as Mode;
      paint();
    },
  );
  const tempoControl = stepper(
    (delta) => stepTempo(delta * 5),
    () => {
      opts.tempo.set(null);
      paint();
    },
    { less: "Slower", more: "Faster", reset: "Back to the default tempo" },
  );
  const ingredientsField = field("Rhythms to include", ingredientChips.el);
  ingredientsField.classList.add("wide-field");
  const meterField = field("Meter", meterControl.el);
  const relateField = field("How the hands relate", relateSelect.el);
  const freeFields = document.createElement("div");
  freeFields.className = "home-fields";
  freeFields.append(ingredientsField, field("Hands", handsControl.el), relateField, meterField, field("Length", lengthControl.el), field("Mode", modeControl.el), field("Tempo", tempoControl.el));

  const note = document.createElement("p");
  note.className = "panel-note";
  panel.append(trackControl.el, lessonFields, freeFields, note);

  const play = document.createElement("button");
  play.type = "button";
  play.className = "play-cta";
  play.innerHTML = `<span class="play-cta-word">Play</span><span class="play-cta-arrow" aria-hidden="true">→</span><span class="play-cta-what"></span>`;
  const playWhat = play.lastChild as HTMLElement;

  const defaultBpm = () => 65;

  function paint(): void {
    const lessons = track === "lessons";
    lessonFields.hidden = !lessons;
    freeFields.hidden = lessons;
    relateField.hidden = hands !== 2;
    // Two-hand exercises are written in 4/4.
    meterField.hidden = hands === 2;
    if (lessons) {
      const lesson = LESSONS[lessonIndex]!;
      const step = lesson.steps[stepIndex]!;
      const p = loadProgress();
      const done = lesson.steps.filter((_, i) => stepDone(p, lesson, i)).length;
      note.textContent = `${done} of ${lesson.steps.length} steps done. A step counts as done at ${PASS_ACCURACY} or more.`;
      playWhat.textContent = `${lesson.title}, ${step.label.toLowerCase()}`;
    } else {
      note.textContent = mode === "practice" ? "The metronome keeps going: play on the click." : "One bar of clicks, then keep the pulse yourself.";
      const override = opts.tempo.get();
      tempoControl.setText(`${override ?? defaultBpm()} bpm`, override !== null);
      const what = `${describeIngredients(new Set<Ingredient>(["quarters", ...ingredients]))}, ${bars} bars`;
      playWhat.textContent = hands === 2 ? `Two hands, ${what.toLowerCase()}` : what;
    }
    saveHomePrefs({ track, lessonIndex, ingredients, meter, hands, stage, bars, mode });
  }

  const stepTempo = (delta: number) => {
    const current = opts.tempo.get() ?? defaultBpm();
    const next = Math.max(40, Math.min(160, Math.round((current + delta) / 5) * 5));
    opts.tempo.set(next === defaultBpm() ? null : next);
    paint();
  };

  const start = () => {
    if (track === "lessons") opts.onLesson(lessonIndex, stepIndex);
    else opts.onFree({ ingredients: ["quarters", ...ingredients.filter((i) => i !== "quarters")], meter: hands === 2 ? "4/4" : meter, hands, stage, bars, mode });
  };
  play.addEventListener("click", start);
  const onKey = (event: KeyboardEvent) => {
    // Enter plays, unless focus is on one of the controls (Enter belongs to that control then).
    const inControls = event.target instanceof Element && event.target.closest(".home-panel");
    if (event.key === "Enter" && !inControls) {
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
      // The sand rests low on the screen, clear of the instructions.
      opts.scene.setPlate(window.innerWidth / 2, window.innerHeight * 0.86, Math.min(window.innerWidth * 0.42, 420));
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
  footer.append(play);
  // Calibration is a setting, not part of choosing what to play: it sits with the sound switches.
  calibrateLink.className = "text-toggle calibrate-link";
  toggles.appendChild(calibrateLink);
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




const BAR_OPTIONS = [4, 8, 16] as const;
const HOME_PREFS_KEY = "resonance.homePrefs2";

/** What free practice builds. */
export interface FreeChoice {
  ingredients: Ingredient[];
  meter: MeterChoice;
  hands: 1 | 2;
  stage: number;
  bars: 4 | 8 | 16;
  mode: Mode;
}

interface HomePrefs extends FreeChoice {
  track: "lessons" | "free";
  /** -1: start at the first lesson not yet done. */
  lessonIndex: number;
}

function loadHomePrefs(): HomePrefs {
  const fallback: HomePrefs = { track: "lessons", lessonIndex: -1, ingredients: ["quarters", "halves", "rests", "eighths"], meter: "4/4", hands: 1, stage: 1, bars: 8, mode: "practice" };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HOME_PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const r = raw as Partial<HomePrefs>;
    const known = new Set(INGREDIENTS.map((i) => i.key));
    const lessonIndex = Number(r.lessonIndex);
    const stage = Number(r.stage);
    return {
      track: r.track === "free" ? "free" : "lessons",
      lessonIndex: Number.isInteger(lessonIndex) && lessonIndex >= 0 && lessonIndex < LESSONS.length ? lessonIndex : -1,
      ingredients: Array.isArray(r.ingredients) ? r.ingredients.filter((i): i is Ingredient => known.has(i as Ingredient)) : fallback.ingredients,
      meter: r.meter === "3/4" || r.meter === "6/8" ? r.meter : "4/4",
      hands: r.hands === 2 ? 2 : 1,
      stage: stage >= 1 && stage <= TWO_HAND_STAGES.length ? stage : 1,
      bars: BAR_OPTIONS.find((b) => b === Number(r.bars)) ?? 8,
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

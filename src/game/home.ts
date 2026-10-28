// Home screen: what to practise (difficulty, hands, length), how (mode, tempo), and Play.

import type { AudioEngine } from "../audio/engine";
import type { Scene } from "../scene/resonance";
import { runCalibration } from "../input/calibration";
import { onTweak, tweak } from "../ui/tweaks";
import { chips, field, segmented, select, stepper } from "./controls";
import { describeIngredients, INGREDIENTS, type Ingredient, type MeterChoice } from "../rhythm/generate";
import { HAND_RELATIONS } from "../rhythm/twoHands";
import { firstOpenLesson, firstOpenPiece, firstOpenStep, LESSONS, loadProgress, PASS_ACCURACY, pieceDone, PIECES, stepDone } from "./lessons";
import type { Mode } from "../types";

export interface HomeOptions {
  engine: AudioEngine;
  /** Play a step of a piece of a lesson (see lessons.ts), at `bpm` (the step's suggestion unless changed). */
  onLesson: (lessonIndex: number, pieceIndex: number, stepIndex: number, bpm: number) => void;
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
/** Greys a field out (and takes it out of reach) while it doesn't apply, keeping its place. */
function setOff(fieldEl: HTMLElement, off: boolean, reason: string): void {
  fieldEl.classList.toggle("field-off", off);
  fieldEl.inert = off;
  if (off) fieldEl.title = reason;
  else fieldEl.removeAttribute("title");
}

/** A narrow, upright screen: the sand becomes a quiet backdrop instead of a framed picture. */
export function isPhoneBackdrop(): boolean {
  return window.innerWidth <= 640 && window.innerWidth < window.innerHeight * 0.9;
}

function startHomeScene(scene: Scene, slot: HTMLElement): void {
  leaveHome();
  let figure = Math.floor(Math.random() * 12);
  scene.reset();
  scene.setFigure(figure);
  scene.setAmbient(0.32);
  scene.setDim(0.15);

  const place = () => {
    // Phones: the sand lies quietly behind the whole screen and stays put while the choices scroll.
    if (isPhoneBackdrop()) {
      scene.setSteep(false);
      scene.setDim(tweak("sandHome"));
      scene.setPlate(window.innerWidth / 2, window.innerHeight * 0.42, window.innerWidth * 0.72);
      return;
    }
    // Larger screens: the sand fills the space above the choices, seen from above (as on a
    // tablet held upright), and flows on behind them, where the glass blurs it.
    scene.setSteep(true);
    scene.setDim(0.15);
    // Mostly above the choices, its lower edge glowing through the glass. (A short window has
    // less room above, so there it sits lower and more of it shows through.)
    const rect = slot.getBoundingClientRect();
    const radius = Math.max(180, Math.min(window.innerWidth * 0.3, window.innerHeight * 0.42, 600));
    scene.setPlate(rect.left + rect.width / 2, Math.max(rect.top + rect.height * 0.5, rect.bottom - radius * 0.3), radius);
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(slot);
  window.addEventListener("scroll", place, { passive: true });
  window.addEventListener("resize", place);
  const offTweak = onTweak(place);
  const timer = setInterval(() => {
    figure += 1;
    scene.setFigure(figure);
  }, FIGURE_CYCLE_MS);

  homeCleanup = () => {
    observer.disconnect();
    window.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    scene.setSteep(false);
    offTweak();
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
  tagline.textContent = "Read the rhythm. Play in time and the sand draws its figures.";
  titleBlock.append(title, tagline);
  // Settings live on their own page: one clear button here, the rows inside it.
  const settingsRows = document.createElement("div");
  settingsRows.className = "settings-rows";
  for (const sound of opts.sounds) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-row text-toggle";
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
    settingsRows.appendChild(button);
  }
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "settings-button";
  settingsButton.textContent = "Settings";
  settingsButton.setAttribute("aria-haspopup", "dialog");
  top.append(titleBlock, settingsButton);
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
  panel.className = "home-panel bento";
  panel.setAttribute("aria-label", "Choose an exercise");

  let { track, lessonIndex, ingredients, cross, meter, hands, stage, bars, mode, part } = prefs;
  const progress = loadProgress();
  if (lessonIndex < 0) lessonIndex = firstOpenLesson(progress);
  let pieceIndex = firstOpenPiece(progress, LESSONS[lessonIndex]!);
  let stepIndex = firstOpenStep(progress, LESSONS[lessonIndex]!, pieceIndex);
  /** The lesson tempo the player chose; null = the step's suggestion. */
  let lessonBpm: number | null = null;

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
      pieceIndex = firstOpenPiece(loadProgress(), LESSONS[lessonIndex]!);
      stepIndex = firstOpenStep(loadProgress(), LESSONS[lessonIndex]!, pieceIndex);
      lessonBpm = null;
      rebuildPieces();
      rebuildSteps();
      paint();
    },
  );
  const pieceSlot = document.createElement("div");
  const pieceField = field("Piece", pieceSlot);
  function rebuildPieces(): void {
    const lesson = LESSONS[lessonIndex]!;
    const p = loadProgress();
    const control = segmented(
      Array.from({ length: PIECES }, (_, i) => ({ value: String(i), label: pieceDone(p, lesson, i) ? `${i + 1} ✓` : String(i + 1) })),
      String(pieceIndex),
      (value) => {
        pieceIndex = Number(value);
        stepIndex = firstOpenStep(loadProgress(), LESSONS[lessonIndex]!, pieceIndex);
        lessonBpm = null;
        rebuildSteps();
        paint();
      },
    );
    pieceSlot.replaceChildren(control.el);
  }
  const stepSlot = document.createElement("div");
  const stepField = field("Step", stepSlot);
  function rebuildSteps(): void {
    const lesson = LESSONS[lessonIndex]!;
    const p = loadProgress();
    const control = segmented(
      lesson.steps.map((step, i) => ({ value: String(i), label: stepDone(p, lesson, pieceIndex, i) ? `${step.label} ✓` : step.label })),
      String(stepIndex),
      (value) => {
        stepIndex = Number(value);
        lessonBpm = null;
        paint();
      },
    );
    stepSlot.replaceChildren(control.el);
  }
  rebuildPieces();
  rebuildSteps();
  const suggestedBpm = () => LESSONS[lessonIndex]!.steps[stepIndex]!.bpm;
  const lessonTempoControl = stepper(
    (delta) => {
      lessonBpm = Math.max(40, Math.min(160, (lessonBpm ?? suggestedBpm()) + delta * 5));
      if (lessonBpm === suggestedBpm()) lessonBpm = null;
      paint();
    },
    () => {
      lessonBpm = null;
      paint();
    },
    { less: "Slower", more: "Faster", reset: "Back to the suggested tempo" },
  );
  const lessonFields = document.createElement("div");
  lessonFields.className = "home-fields";
  const lessonField = field("Lesson", lessonSelect.el);
  lessonFields.append(lessonField, pieceField, stepField, field("Tempo", lessonTempoControl.el));

  // ---- Free practice ----
  const ingredientChips = chips(
    [...INGREDIENTS.map((i) => ({ value: i.key as string, label: i.label })), { value: CROSS_CHIP, label: "3 against 2" }],
    cross ? [...ingredients, CROSS_CHIP] : ingredients,
    (values) => {
      ingredients = values.filter((v) => v !== CROSS_CHIP) as Ingredient[];
      cross = values.includes(CROSS_CHIP);
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
  const relateControl = segmented(
    HAND_RELATIONS.map((name, i) => ({ value: String(i + 1), label: name })),
    String(stage),
    (value) => {
      stage = Number(value);
      paint();
    },
  );
  // Two hands: play both, or practise one alone (the other is played for you).
  const partControl = segmented(
    [
      { value: "both", label: "Both" },
      { value: "right", label: "Right" },
      { value: "left", label: "Left" },
    ],
    part,
    (value) => {
      part = value as HandPart;
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
  const relateField = field("How the hands relate", relateControl.el);
  relateField.classList.add("wide-field");
  const partField = field("Play", partControl.el);
  const freeFields = document.createElement("div");
  freeFields.className = "home-fields";
  const handsField = field("Hands", handsControl.el);
  const lengthField = field("Length", lengthControl.el);
  // Classes for the home grid (style.css): Hands and Play share a row, Length widens when
  // there is no meter to choose.
  handsField.classList.add("hands-field");
  partField.classList.add("part-field");
  relateField.classList.add("relate-field");
  meterField.classList.add("meter-field");
  lengthField.classList.add("length-field");
  freeFields.append(handsField, partField, relateField, ingredientsField, meterField, lengthField, field("Mode", modeControl.el), field("Tempo", tempoControl.el));

  const note = document.createElement("p");
  note.className = "panel-note";
  // One ruled block (a "bento", see style.css): the track switch, the choices, and the note.
  const trackCell = document.createElement("div");
  trackCell.className = "bento-cell";
  trackCell.appendChild(trackControl.el);
  panel.append(trackCell, lessonFields, freeFields, note);

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
    // Fields that don't apply stay in place, greyed out, so the layout never jumps.
    setOff(relateField, hands !== 2, "Needs two hands");
    setOff(partField, hands !== 2, "Needs two hands");
    // Two-hand exercises are written in 4/4.
    setOff(meterField, hands === 2, "Two-hand pieces are in 4/4");
    ingredientChips.setDisabled(CROSS_CHIP, hands === 2 ? null : "Needs two hands");
    if (lessons) {
      const lesson = LESSONS[lessonIndex]!;
      const step = lesson.steps[stepIndex]!;
      const p = loadProgress();
      const done = lesson.steps.filter((_, i) => stepDone(p, lesson, pieceIndex, i)).length;
      lessonTempoControl.setText(`${lessonBpm ?? step.bpm} bpm`, lessonBpm !== null);
      note.textContent = `${done} of ${lesson.steps.length} steps done on this piece. A step counts as done at ${PASS_ACCURACY} or more, at ${step.bpm} bpm or faster.`;
      playWhat.textContent = `${lesson.title}, piece ${pieceIndex + 1}, ${step.label.toLowerCase()}`;
    } else {
      note.textContent = mode === "practice" ? "The metronome keeps going: play on the click." : "One bar of clicks, then keep the pulse yourself.";
      const override = opts.tempo.get();
      tempoControl.setText(`${override ?? defaultBpm()} bpm`, override !== null);
      const what = `${describeIngredients(new Set<Ingredient>(["quarters", ...ingredients]))}, ${bars} bars`;
      playWhat.textContent = hands === 2 ? `Two hands, ${what.toLowerCase()}${cross ? ", 3 against 2" : ""}` : what;
    }
    saveHomePrefs({ track, lessonIndex, ingredients, cross, meter, hands, stage, bars, mode, part });
  }

  const stepTempo = (delta: number) => {
    const current = opts.tempo.get() ?? defaultBpm();
    const next = Math.max(40, Math.min(160, Math.round((current + delta) / 5) * 5));
    opts.tempo.set(next === defaultBpm() ? null : next);
    paint();
  };

  const start = () => {
    if (track === "lessons") opts.onLesson(lessonIndex, pieceIndex, stepIndex, lessonBpm ?? suggestedBpm());
    else opts.onFree({ ingredients: ["quarters", ...ingredients.filter((i) => i !== "quarters")], cross: hands === 2 && cross, meter: hands === 2 ? "4/4" : meter, hands, stage, bars, mode, part });
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
      opts.scene.setPlate(window.innerWidth / 2, window.innerHeight * (window.innerWidth < window.innerHeight * 0.9 ? 0.8 : 0.86), Math.min(window.innerWidth * 0.42, 420));
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
  // Calibration is a setting, not part of choosing what to play: it sits in the Settings page.
  calibrateLink.className = "settings-row text-toggle calibrate-link";
  calibrateLink.innerHTML = `<span class="text-toggle-label">Calibrate latency</span><span class="settings-row-arrow" aria-hidden="true">&rsaquo;</span>`;
  settingsRows.appendChild(calibrateLink);

  const settingsPage = document.createElement("div");
  settingsPage.className = "settings-page";
  settingsPage.hidden = true;
  settingsPage.setAttribute("role", "dialog");
  settingsPage.setAttribute("aria-label", "Settings");
  const settingsBar = document.createElement("div");
  settingsBar.className = "settings-bar";
  const settingsBack = document.createElement("button");
  settingsBack.type = "button";
  settingsBack.className = "home-button settings-back";
  settingsBack.setAttribute("aria-label", "Back");
  settingsBack.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const settingsTitle = document.createElement("h2");
  settingsTitle.className = "settings-title";
  settingsTitle.textContent = "Settings";
  settingsBar.append(settingsBack, settingsTitle);
  settingsPage.append(settingsBar, settingsRows);
  root.appendChild(settingsPage);
  const closeSettings = () => {
    settingsPage.hidden = true;
    settingsButton.focus();
  };
  settingsButton.addEventListener("click", () => {
    settingsPage.hidden = false;
    settingsBack.focus();
  });
  settingsBack.addEventListener("click", closeSettings);
  const onSettingsKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !settingsPage.hidden) {
      event.preventDefault();
      closeSettings();
    }
  };
  window.addEventListener("keydown", onSettingsKey);
  dock.append(panel, footer);
  root.appendChild(dock);

  container.appendChild(root);
  paint();
  startHomeScene(opts.scene, plateSlot);
  const sceneCleanup = homeCleanup;
  homeCleanup = () => {
    sceneCleanup?.();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keydown", onSettingsKey);
  };
  opts.engine.setAmbience(0.6, 2);
}




const BAR_OPTIONS = [4, 8, 16] as const;
const HOME_PREFS_KEY = "resonance.homePrefs2";

/** What free practice builds. */
export interface FreeChoice {
  ingredients: Ingredient[];
  meter: MeterChoice;
  /** Two hands: put 3 against 2 bars into the piece. */
  cross: boolean;
  hands: 1 | 2;
  /** How the hands relate: 1 call and response, 2 unison, 3 independent. */
  stage: number;
  bars: 4 | 8 | 16;
  mode: Mode;
  /** Independent two hands: both, or one hand alone. */
  part: HandPart;
}

export type HandPart = "both" | "right" | "left";

/** The "3 against 2" chip among the rhythm chips (not an ingredient). */
const CROSS_CHIP = "cross";

interface HomePrefs extends FreeChoice {
  track: "lessons" | "free";
  /** -1: start at the first lesson not yet done. */
  lessonIndex: number;
}

function loadHomePrefs(): HomePrefs {
  const fallback: HomePrefs = { track: "lessons", lessonIndex: -1, ingredients: ["quarters", "halves", "rests", "eighths"], cross: false, meter: "4/4", hands: 1, stage: 1, bars: 8, mode: "practice", part: "both" };
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
      // The old stage 4 (3 against 2) is now "independent" with the cross-rhythm chip on.
      stage: Number.isInteger(stage) && stage >= 1 && stage <= HAND_RELATIONS.length + 1 ? Math.min(stage, HAND_RELATIONS.length) : 1,
      cross: typeof r.cross === "boolean" ? r.cross : stage === HAND_RELATIONS.length + 1,
      bars: BAR_OPTIONS.find((b) => b === Number(r.bars)) ?? 8,
      mode: r.mode === "countIn" ? "countIn" : "practice",
      part: r.part === "right" || r.part === "left" ? r.part : "both",
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

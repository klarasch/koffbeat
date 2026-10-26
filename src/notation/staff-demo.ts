// Standalone dev page for eyeballing the staff renderer. Not part of the game bundle.
import { renderStaff, type StaffView } from "./staff";
import { eventQuarters } from "../rhythm/durations";
import { generateLevel } from "../rhythm/generate";
import type { Grade, Level, NoteValue, RhythmEvent } from "../types";

function ev(value: NoteValue, opts?: { dots?: 0 | 1; rest?: boolean; tie?: boolean; tuplet?: 3 }): RhythmEvent {
  return { value, dots: opts?.dots ?? 0, rest: opts?.rest ?? false, tie: opts?.tie, tuplet: opts?.tuplet };
}
const t8 = () => ev("8", { tuplet: 3 });

const levels: Level[] = [
  {
    id: "quarters-halves",
    title: "Quarters + halves",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [
      [ev("q"), ev("q"), ev("h")],
      [ev("h"), ev("q"), ev("q")],
    ],
  },
  {
    id: "eighth-pairs",
    title: "Eighth pairs",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [[ev("8"), ev("8"), ev("8"), ev("8"), ev("8"), ev("8"), ev("8"), ev("8")]],
  },
  {
    id: "quarter-rests",
    title: "Quarter rests",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [[ev("q"), ev("q", { rest: true }), ev("q"), ev("q", { rest: true })]],
  },
  {
    id: "dotted-quarter-eighth",
    title: "Dotted quarter + eighth",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [[ev("q", { dots: 1 }), ev("8"), ev("q"), ev("q")]],
  },
  {
    id: "tie-across-barline",
    title: "Tie across a barline",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [
      [ev("q"), ev("q"), ev("q"), ev("q", { tie: true })],
      [ev("q"), ev("q"), ev("q"), ev("q")],
    ],
  },
  {
    id: "sixteenths",
    title: "Sixteenths",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 88,
    bars: [
      [
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
        ev("16"),
      ],
    ],
  },
  {
    id: "whole-rest",
    title: "Whole rest bar",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 96,
    bars: [[ev("w", { rest: true })]],
  },
  {
    id: "long-wrap",
    title: "Long level (wraps to multiple systems)",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 100,
    bars: [
      [ev("q"), ev("q"), ev("8"), ev("8"), ev("q")],
      [ev("8"), ev("8"), ev("8"), ev("8"), ev("q"), ev("q")],
      [ev("q", { dots: 1 }), ev("8"), ev("q"), ev("q")],
      [ev("h"), ev("q", { rest: true }), ev("q")],
      [ev("16"), ev("16"), ev("16"), ev("16"), ev("q"), ev("q"), ev("q")],
      [ev("q"), ev("q"), ev("q"), ev("q", { tie: true })],
      [ev("q"), ev("q"), ev("h")],
    ],
  },
  {
    id: "syncopation",
    title: "Syncopation: 8-q-8, eighth tied over the beat",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 88,
    bars: [
      [ev("8"), ev("q"), ev("8"), ev("8"), ev("8", { tie: true }), ev("8"), ev("8")],
      [ev("8"), ev("8", { tie: true }), ev("q"), ev("q"), ev("q")],
    ],
  },
  {
    id: "dotted-eighth-sixteenth",
    title: "Dotted eighth + sixteenth",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 88,
    bars: [[ev("8", { dots: 1 }), ev("16"), ev("16"), ev("8", { dots: 1 }), ev("q"), ev("q")]],
  },
  {
    id: "offbeat-rests",
    title: "Off-beat rests",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 88,
    bars: [[ev("8"), ev("8", { rest: true }), ev("16", { rest: true }), ev("16"), ev("8"), ev("16"), ev("16", { rest: true }), ev("16"), ev("16"), ev("q")]],
  },
  {
    id: "triplets",
    title: "Eighth-note triplets",
    meter: { beats: 4, beatUnit: 4 },
    bpm: 80,
    bars: [
      [t8(), t8(), t8(), ev("q"), ev("q", { tuplet: 3 }), ev("8", { tuplet: 3 }), ev("q")],
      [ev("q"), t8(), t8(), t8(), t8(), t8(), t8(), ev("q")],
    ],
  },
  {
    id: "three-four",
    title: "3/4",
    meter: { beats: 3, beatUnit: 4 },
    bpm: 96,
    bars: [
      [ev("q"), ev("8"), ev("8"), ev("q")],
      [ev("q"), ev("h")],
      [ev("h", { dots: 1 })],
    ],
  },
  {
    id: "six-eight",
    title: "6/8 (beamed by dotted quarter)",
    meter: { beats: 6, beatUnit: 8 },
    bpm: 96,
    bars: [
      [ev("8"), ev("8"), ev("8"), ev("8"), ev("8"), ev("8")],
      [ev("q", { dots: 1 }), ev("8"), ev("8"), ev("8")],
      [ev("q"), ev("8"), ev("8"), ev("q")],
      [ev("8", { rest: true }), ev("8"), ev("8"), ev("q", { dots: 1, rest: true })],
      [ev("h", { dots: 1 })],
    ],
  },
  ...[8, 9, 10, 11, 12].map((tier) => generateLevel({ tier, bars: 4, seed: 7 })),
];

function totalQuarters(level: Level): number {
  let total = 0;
  for (const bar of level.bars) for (const e of bar) total += eventQuarters(e);
  return total;
}

function eventCount(level: Level): number {
  return level.bars.reduce((n, bar) => n + bar.length, 0);
}

const root = document.getElementById("levels");
if (!root) throw new Error("missing #levels root");

const grades: Grade[] = ["perfect", "good", "ok", "miss"];
const running: { view: StaffView; total: number; bpm: number }[] = [];

for (const level of levels) {
  const section = document.createElement("div");
  section.className = "level";

  const heading = document.createElement("h2");
  heading.textContent = `${level.title} (${level.meter.beats}/${level.meter.beatUnit}, ${level.bpm} bpm)`;
  section.appendChild(heading);

  const staffContainer = document.createElement("div");
  staffContainer.className = "staff";
  section.appendChild(staffContainer);

  root.appendChild(section);

  const view = renderStaff(staffContainer, level, { theme: "dark" });
  running.push({ view, total: totalQuarters(level), bpm: level.bpm });

  const n = eventCount(level);
  window.setInterval(
    () => {
      if (Math.random() < 0.15) {
        view.clearMarks();
        return;
      }
      const idx = Math.floor(Math.random() * n);
      const grade = grades[Math.floor(Math.random() * grades.length)] ?? "ok";
      view.mark(idx, grade);
    },
    500 + Math.random() * 400,
  );
}

const start = performance.now();
function tick(now: number): void {
  const elapsedMs = now - start;
  for (const { view, total, bpm } of running) {
    const quartersPerMs = bpm / 60000;
    const beat = total > 0 ? (elapsedMs * quartersPerMs) % total : 0;
    view.setCursor(beat);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

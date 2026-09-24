// Renders a single-line percussion rhythm staff with VexFlow 5 and exposes a small
// runtime API for cursor sweeps and per-note grading marks. See AGENTS/spec for the contract.

import { BarlineType, Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveNote, StaveTie, Stem, Voice } from "vexflow";
import type { Grade, Level, NoteValue, RhythmEvent } from "../types";

export interface StaffView {
  /** x in container CSS px of the notehead centre, and which system (line) it is on. */
  onsetX(eventIndex: number): { x: number; line: number };
  /** Position a thin vertical playhead at `beat` (quarters from the start of bar 1), or hide it when null. */
  setCursor(beat: number | null): void;
  /** Colour the notehead/stem of a single event to reflect a grade. */
  mark(eventIndex: number, grade: Grade): void;
  /** Remove all grading colours, restoring the default ink. */
  clearMarks(): void;
  destroy(): void;
}

export interface RenderStaffOptions {
  theme?: "dark" | "light";
}

const INK: Record<"dark" | "light", string> = {
  dark: "#e8e4da",
  light: "#1a1a1a",
};

const GRADE_COLORS: Record<Grade, string> = {
  perfect: "#7fe0c4",
  good: "#a8d672",
  ok: "#e6c35c",
  miss: "#e0707a",
};

// Layout constants, in CSS px.
const MIN_BAR_WIDTH = 150;
const CLEF_TIME_WIDTH = 70;
const TOP_MARGIN = 45;
const SYSTEM_GAP = 90;
const BOTTOM_MARGIN = 20;
const CURSOR_TOP_OFFSET = 40;
const CURSOR_HEIGHT = 60;
const FALLBACK_WIDTH = 360;

// The percussion notehead sits on the single stave line regardless of "pitch"; "b/4" is just
// a conventional key that VexFlow accepts for any clef.
const PERCUSSION_KEY = "b/4";

/** quarters per written value (before dots). A separate parallel module owns the public version of this. */
function baseQuarters(value: NoteValue): number {
  switch (value) {
    case "w":
      return 4;
    case "h":
      return 2;
    case "q":
      return 1;
    case "8":
      return 0.5;
    case "16":
      return 0.25;
  }
}

function eventQuarters(ev: RhythmEvent): number {
  const base = baseQuarters(ev.value);
  return ev.dots ? base * 1.5 : base;
}

interface EventMeta {
  note: StaveNote;
  x: number;
  line: number;
}

interface Anchor {
  beat: number;
  x: number;
}

interface BarMeta {
  startBeat: number;
  endBeat: number;
  top: number;
  height: number;
  anchors: Anchor[];
}

/** Evenly distribute `total` bars across `systems` systems (as equal as possible, front-loaded). */
function distributeBars(total: number, systems: number): number[] {
  const counts: number[] = [];
  let remaining = total;
  for (let s = 0; s < systems; s++) {
    const remainingSystems = systems - s;
    const count = Math.ceil(remaining / remainingSystems);
    counts.push(count);
    remaining -= count;
  }
  return counts;
}

function paintSvgTree(root: SVGElement, color: string | null): void {
  const apply = (el: SVGElement) => {
    if (color) {
      el.style.fill = color;
      el.style.stroke = color;
    } else {
      el.style.fill = "";
      el.style.stroke = "";
    }
  };
  apply(root);
  root.querySelectorAll<SVGElement>("path, rect, line, ellipse, circle, text").forEach(apply);
}

export function renderStaff(container: HTMLElement, level: Level, opts?: RenderStaffOptions): StaffView {
  const theme = opts?.theme ?? "dark";
  const ink = INK[theme];

  let destroyed = false;
  let resizeObserver: ResizeObserver | null = null;
  let cursorEl: HTMLDivElement | null = null;
  let eventMeta: EventMeta[] = [];
  let bars: BarMeta[] = [];

  function findBar(beat: number): BarMeta | undefined {
    if (bars.length === 0) return undefined;
    for (const bar of bars) {
      if (beat >= bar.startBeat && beat <= bar.endBeat) return bar;
    }
    return beat < (bars[0]?.startBeat ?? 0) ? bars[0] : bars[bars.length - 1];
  }

  function interpolateX(bar: BarMeta, beat: number): number {
    const anchors = bar.anchors;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (!a || !b) continue;
      if (beat >= a.beat && beat <= b.beat) {
        const span = b.beat - a.beat;
        const t = span <= 0 ? 0 : (beat - a.beat) / span;
        return a.x + (b.x - a.x) * t;
      }
    }
    const last = anchors[anchors.length - 1];
    return last ? last.x : 0;
  }

  function build(): void {
    if (destroyed) return;
    container.innerHTML = "";
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const measuredWidth = container.clientWidth || container.getBoundingClientRect().width || FALLBACK_WIDTH;
    const width = Math.max(measuredWidth, MIN_BAR_WIDTH + CLEF_TIME_WIDTH);
    const totalBars = level.bars.length;

    const barsPerLine = Math.max(1, Math.floor((width - CLEF_TIME_WIDTH) / MIN_BAR_WIDTH));
    const systemsCount = Math.max(1, Math.ceil(totalBars / barsPerLine));
    const systemBarCounts = distributeBars(totalBars, systemsCount);

    const totalHeight = TOP_MARGIN + systemsCount * SYSTEM_GAP + BOTTOM_MARGIN;

    const renderer = new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
    renderer.resize(width, totalHeight);
    const ctx = renderer.getContext();
    ctx.setFillStyle(ink);
    ctx.setStrokeStyle(ink);

    const newEventMeta: EventMeta[] = [];
    const newBars: BarMeta[] = [];
    const noteByEvent: StaveNote[] = [];

    let globalBeat = 0;
    let globalBarIndex = 0;

    for (let s = 0; s < systemBarCounts.length; s++) {
      const barsInSystem = systemBarCounts[s] ?? 0;
      const isFirstSystem = s === 0;
      const perBarWidth = Math.max(MIN_BAR_WIDTH, Math.floor((width - (isFirstSystem ? CLEF_TIME_WIDTH : 0)) / Math.max(1, barsInSystem)));
      const staveY = TOP_MARGIN + s * SYSTEM_GAP;
      let xCursor = 0;

      for (let b = 0; b < barsInSystem; b++) {
        const isFirstBarOfSystem = b === 0;
        const isLastBarOfSystem = b === barsInSystem - 1;
        const isFirstBarOverall = globalBarIndex === 0;
        const isLastBarOverall = globalBarIndex === totalBars - 1;

        let staveWidth = perBarWidth + (isFirstBarOfSystem && isFirstSystem ? CLEF_TIME_WIDTH : 0);
        if (isLastBarOfSystem) staveWidth = Math.max(MIN_BAR_WIDTH, width - xCursor);

        const stave = new Stave(xCursor, staveY, staveWidth, { numLines: 1 });
        if (isFirstBarOverall) {
          stave.addClef("percussion");
          stave.addTimeSignature(`${level.meter.beats}/${level.meter.beatUnit}`);
        }
        stave.setBegBarType(isFirstBarOfSystem ? BarlineType.NONE : BarlineType.SINGLE);
        stave.setEndBarType(isLastBarOverall ? BarlineType.END : BarlineType.SINGLE);
        stave.setContext(ctx).draw();
        xCursor += staveWidth;

        const barEvents = level.bars[globalBarIndex] ?? [];
        const barStartBeat = globalBeat;
        const notes: StaveNote[] = [];

        for (const ev of barEvents) {
          const note = new StaveNote({
            keys: [PERCUSSION_KEY],
            duration: ev.value,
            dots: ev.dots,
            type: ev.rest ? "r" : undefined,
            clef: "percussion",
            stemDirection: Stem.UP,
          });
          note.setKeyLine(0, 0);
          if (ev.dots) Dot.buildAndAttach([note]);
          notes.push(note);
        }

        const voice = new Voice({ numBeats: level.meter.beats, beatValue: level.meter.beatUnit }).setMode(Voice.Mode.STRICT);
        voice.addTickables(notes);
        new Formatter().joinVoices([voice]).formatToStave([voice], stave);

        const beams = Beam.generateBeams(notes, {
          groups: [new Fraction(1, level.meter.beatUnit)],
          beamRests: false,
          stemDirection: Stem.UP,
        });

        voice.draw(ctx, stave);
        beams.forEach((beam) => beam.setContext(ctx).draw());

        const barAnchors: Anchor[] = [{ beat: barStartBeat, x: stave.getNoteStartX() }];
        let beatAcc = barStartBeat;
        barEvents.forEach((ev, i) => {
          const note = notes[i];
          if (!note) return;
          const x = (note.getNoteHeadBeginX() + note.getNoteHeadEndX()) / 2;
          const globalIndex = noteByEvent.length;
          noteByEvent[globalIndex] = note;
          newEventMeta[globalIndex] = { note, x, line: s };
          barAnchors.push({ beat: beatAcc, x });
          beatAcc += eventQuarters(ev);
        });
        barAnchors.push({ beat: beatAcc, x: stave.getNoteEndX() });

        newBars.push({
          startBeat: barStartBeat,
          endBeat: beatAcc,
          top: staveY - CURSOR_TOP_OFFSET,
          height: CURSOR_HEIGHT,
          anchors: barAnchors,
        });

        globalBeat = beatAcc;
        globalBarIndex++;
      }
    }

    // Ties, including across barlines: walk the flattened events again to know which pairs tie.
    let flatIndex = 0;
    for (const bar of level.bars) {
      for (const ev of bar) {
        if (ev.tie) {
          const firstNote = noteByEvent[flatIndex];
          const lastNote = noteByEvent[flatIndex + 1];
          if (firstNote && lastNote) {
            const tie = new StaveTie({ firstNote, lastNote });
            tie.setContext(ctx).draw();
          }
        }
        flatIndex++;
      }
    }

    eventMeta = newEventMeta;
    bars = newBars;

    const cursor = document.createElement("div");
    cursor.style.position = "absolute";
    cursor.style.top = "0";
    cursor.style.left = "0";
    cursor.style.width = "2px";
    cursor.style.pointerEvents = "none";
    cursor.style.display = "none";
    cursor.style.background = theme === "dark" ? "#ffffff" : "#111111";
    cursor.style.boxShadow = theme === "dark" ? "0 0 4px rgba(255,255,255,0.6)" : "0 0 4px rgba(0,0,0,0.4)";
    container.appendChild(cursor);
    cursorEl = cursor;
  }

  build();

  resizeObserver = new ResizeObserver(() => build());
  resizeObserver.observe(container);

  return {
    onsetX(eventIndex: number): { x: number; line: number } {
      const meta = eventMeta[eventIndex];
      if (!meta) throw new RangeError(`onsetX: no event at index ${eventIndex}`);
      return { x: meta.x, line: meta.line };
    },
    setCursor(beat: number | null): void {
      if (!cursorEl) return;
      if (beat === null) {
        cursorEl.style.display = "none";
        return;
      }
      const bar = findBar(beat);
      if (!bar) {
        cursorEl.style.display = "none";
        return;
      }
      const x = interpolateX(bar, beat);
      cursorEl.style.left = `${x}px`;
      cursorEl.style.top = `${bar.top}px`;
      cursorEl.style.height = `${bar.height}px`;
      cursorEl.style.display = "block";
    },
    mark(eventIndex: number, grade: Grade): void {
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const el = meta.note.getSVGElement();
      if (el) paintSvgTree(el, GRADE_COLORS[grade]);
    },
    clearMarks(): void {
      for (const meta of eventMeta) {
        const el = meta.note.getSVGElement();
        if (el) paintSvgTree(el, null);
      }
    },
    destroy(): void {
      destroyed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      container.innerHTML = "";
    },
  };
}

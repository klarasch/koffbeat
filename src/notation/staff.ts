// Renders a single-line percussion rhythm staff with VexFlow 5 and exposes a small
// runtime API for cursor sweeps and per-note grading marks. See AGENTS/spec for the contract.

import { BarlineType, Beam, Dot, Formatter, Fraction, type RenderContext, Renderer, Stave, StaveNote, StaveTie, Stem, Voice } from "vexflow";
import type { Grade, Level, NoteValue, RhythmEvent } from "../types";

/**
 * Karaoke-style note state: "upcoming" is the default ink (nothing has happened yet), "next" is
 * the note/rest the player should play next (a gentle highlight that only moves when the player
 * advances, never with the clock), "active" is while a finger/key is down on it, and a Grade is
 * its final graded colour.
 */
export type NoteState = "upcoming" | "next" | "active" | Grade;

export interface StaffView {
  /** x in container CSS px of the notehead centre, and which system (line) it is on. */
  onsetX(eventIndex: number): { x: number; line: number };
  /** The event index nearest `(clientX, clientY)` in page coordinates, or null if too far from any note. */
  eventAt(clientX: number, clientY: number): number | null;
  /** Position a thin vertical playhead at `beat` (quarters from the start of bar 1), or hide it when null. Unused by the karaoke-style play screen; kept for future use. */
  setCursor(beat: number | null): void;
  /** Colour the notehead/stem of a single event to reflect a grade. */
  mark(eventIndex: number, grade: Grade): void;
  /** Sets a single event's karaoke-style display state (upcoming/next/active/graded). */
  setState(eventIndex: number, state: NoteState): void;
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

/** "active" (finger down) uses the same accent colour as a "perfect" grade, with a stronger glow. */
const ACTIVE_COLOR = "#7fe0c4";
const NEXT_GLOW_COLOR = "rgba(232, 228, 218, 0.55)";
/** Radius, in unscaled container px, within which a tap counts as hitting a given event (see eventAt). */
const HIT_TEST_RADIUS = 26;

// Layout constants, in CSS px.
// MIN_BAR_WIDTH is tuned so a 360-430px phone viewport (minus CLEF_TIME_WIDTH for the first
// bar) fits exactly 2 bars per system, while a desktop-width container fits a whole 4-bar
// level on one system.
const MIN_BAR_WIDTH = 130;
const CLEF_TIME_WIDTH = 70;
const TOP_MARGIN = 40;
// A 1-line percussion stave needs far less vertical room between systems than a 5-line stave.
const SYSTEM_GAP = 64;
const BOTTOM_MARGIN = 24;
/** Index of the one visible line on the 5-line stave. */
const STAFF_LINE = 2;
/** The staff line sits 40px below the stave's y (2 spaces of headroom + 2 hidden lines). */
const CURSOR_TOP_OFFSET = -10;
const CURSOR_HEIGHT = 50;
const FALLBACK_WIDTH = 360;
/** Barlines extend this many staff-spaces above/below the single line, percussion-notation style. */
const BARLINE_SPACE_MULTIPLIER = 1;
/** Gap between the thin and thick strokes of a final barline. */
const FINAL_BARLINE_GAP = 4;

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

/**
 * Draws a barline by hand instead of relying on VexFlow's Stave begin/end bar rendering: on a
 * 1-line stave VexFlow collapses barline height to ~0 (it spans "top line to bottom line",
 * which are the same line). We draw a stroke centred on the line and extending one staff-space
 * above and below, matching standard percussion notation; a "final" barline adds a second,
 * thicker stroke just before it.
 */
function drawBarline(ctx: RenderContext, x: number, lineY: number, staffSpace: number, kind: "single" | "final"): void {
  const extend = staffSpace * BARLINE_SPACE_MULTIPLIER;
  const top = lineY - extend;
  const bottom = lineY + extend;

  const stroke = (strokeX: number, width: number) => {
    ctx.save();
    ctx.setLineWidth(width);
    ctx.beginPath();
    ctx.moveTo(strokeX, top);
    ctx.lineTo(strokeX, bottom);
    ctx.stroke();
    ctx.restore();
  };

  if (kind === "final") stroke(x - FINAL_BARLINE_GAP, 3);
  stroke(x, 1);
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
  let nextMarkerEl: HTMLDivElement | null = null;
  let nextMarkerIndex: number | null = null;
  let eventMeta: EventMeta[] = [];
  let bars: BarMeta[] = [];
  // Set to <1 when the natural layout is taller than the available space (see build()): the
  // SVG is scaled down via its viewBox rather than overflowing, and cursor coordinates (kept
  // in unscaled/natural px) must be scaled the same way to stay aligned with it.
  let renderScale = 1;

  // A beat exactly on a shared boundary (the last bar's endBeat equals the next bar's
  // startBeat) belongs to the *next* bar — its first onset — except at the very end of the
  // piece, where the final bar's own endBeat must still resolve to itself.
  function findBar(beat: number): BarMeta | undefined {
    if (bars.length === 0) return undefined;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar) continue;
      const isLast = i === bars.length - 1;
      const inBar = isLast ? beat >= bar.startBeat && beat <= bar.endBeat : beat >= bar.startBeat && beat < bar.endBeat;
      if (inBar) return bar;
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
    nextMarkerEl = null;
    nextMarkerIndex = null;
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

        // A 5-line stave with only the middle line visible: clef, time signature and "b/4" notes
        // all centre on the middle line, which is how VexFlow expects single-line percussion.
        const stave = new Stave(xCursor, staveY, staveWidth, { spaceAboveStaffLn: 2 });
        stave.setConfigForLines([{ visible: false }, { visible: false }, { visible: true }, { visible: false }, { visible: false }]);
        if (isFirstBarOverall) {
          stave.addClef("percussion");
          stave.addTimeSignature(`${level.meter.beats}/${level.meter.beatUnit}`);
        }
        // VexFlow's own begin/end barlines collapse to ~0 height on a 1-line stave, so both are
        // suppressed here and every bar's trailing edge gets a hand-drawn barline instead (see
        // drawBarline below) — a single line between bars, a final double line at the very end.
        stave.setBegBarType(BarlineType.NONE);
        stave.setEndBarType(BarlineType.NONE);
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

        // A barline at this bar's trailing edge (never a leading one — see the NONE begin type
        // above): single between bars, final/double at the very end of the piece.
        drawBarline(ctx, xCursor, stave.getYForLine(STAFF_LINE), stave.getSpacingBetweenLines(), isLastBarOverall ? "final" : "single");

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

    // VexFlow hard-codes stroke/fill="black" on some groups (stems, flags), overriding the
    // context's ink colour — invisible on the dark background.
    for (const el of container.querySelectorAll("svg [stroke='black'], svg [fill='black']")) {
      if (el.getAttribute("stroke") === "black") el.setAttribute("stroke", ink);
      if (el.getAttribute("fill") === "black") el.setAttribute("fill", ink);
    }

    eventMeta = newEventMeta;
    bars = newBars;

    // The staff region must never overlap the tap area below it. staffArea (this container's
    // flex parent) is shrink-eligible (min-height: 0) and reports its real, content-independent
    // box height; when the natural layout is taller than that, scale the whole SVG down via its
    // viewBox instead of letting it overflow into the tap zones.
    const availableHeight = Math.max(0, (container.parentElement?.clientHeight ?? 0) - 8);
    renderScale = availableHeight > 0 && totalHeight > availableHeight ? Math.max(0.4, availableHeight / totalHeight) : 1;

    const svgEl = container.querySelector("svg");
    if (svgEl) {
      svgEl.setAttribute("viewBox", `0 0 ${width} ${totalHeight}`);
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
      if (renderScale < 1) {
        svgEl.setAttribute("width", `${Math.round(width * renderScale)}`);
        svgEl.setAttribute("height", `${Math.round(totalHeight * renderScale)}`);
        svgEl.style.display = "block";
        svgEl.style.margin = "0 auto";
      }
    }

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

  function ensureNextMarker(): HTMLDivElement {
    if (nextMarkerEl) return nextMarkerEl;
    const marker = document.createElement("div");
    marker.style.position = "absolute";
    marker.style.width = "6px";
    marker.style.height = "6px";
    marker.style.borderRadius = "50%";
    marker.style.background = ink;
    marker.style.pointerEvents = "none";
    marker.style.transform = "translate(-50%, 0)";
    container.appendChild(marker);
    nextMarkerEl = marker;
    return marker;
  }

  function positionNextMarker(eventIndex: number): void {
    const meta = eventMeta[eventIndex];
    if (!meta) return;
    const marker = ensureNextMarker();
    const staveY = TOP_MARGIN + meta.line * SYSTEM_GAP;
    marker.style.left = `${meta.x * renderScale}px`;
    marker.style.top = `${(staveY + 22) * renderScale}px`;
    marker.style.display = "block";
    nextMarkerIndex = eventIndex;
  }

  function hideNextMarkerIfOwnedBy(eventIndex: number): void {
    if (nextMarkerIndex === eventIndex && nextMarkerEl) {
      nextMarkerEl.style.display = "none";
      nextMarkerIndex = null;
    }
  }

  return {
    onsetX(eventIndex: number): { x: number; line: number } {
      const meta = eventMeta[eventIndex];
      if (!meta) throw new RangeError(`onsetX: no event at index ${eventIndex}`);
      return { x: meta.x, line: meta.line };
    },
    eventAt(clientX: number, clientY: number): number | null {
      const rect = container.getBoundingClientRect();
      const localX = (clientX - rect.left) / renderScale;
      const localY = (clientY - rect.top) / renderScale;
      let bestIndex: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      eventMeta.forEach((meta, i) => {
        const staveY = TOP_MARGIN + meta.line * SYSTEM_GAP;
        const dist = Math.hypot(meta.x - localX, staveY - localY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      });
      return bestDist <= HIT_TEST_RADIUS ? bestIndex : null;
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
      const x = interpolateX(bar, beat) * renderScale;
      cursorEl.style.left = `${x}px`;
      cursorEl.style.top = `${bar.top * renderScale}px`;
      cursorEl.style.height = `${bar.height * renderScale}px`;
      cursorEl.style.display = "block";
    },
    mark(eventIndex: number, grade: Grade): void {
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const el = meta.note.getSVGElement();
      if (el) paintSvgTree(el, GRADE_COLORS[grade]);
    },
    setState(eventIndex: number, state: NoteState): void {
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const el = meta.note.getSVGElement();
      if (!el) return;

      if (state !== "next") hideNextMarkerIfOwnedBy(eventIndex);

      switch (state) {
        case "upcoming":
          paintSvgTree(el, null);
          el.style.filter = "";
          break;
        case "next":
          paintSvgTree(el, ink);
          el.style.filter = `drop-shadow(0 0 4px ${NEXT_GLOW_COLOR})`;
          positionNextMarker(eventIndex);
          break;
        case "active":
          paintSvgTree(el, ACTIVE_COLOR);
          el.style.filter = `drop-shadow(0 0 6px ${ACTIVE_COLOR})`;
          break;
        default:
          paintSvgTree(el, GRADE_COLORS[state]);
          el.style.filter = "";
          break;
      }
    },
    clearMarks(): void {
      for (const meta of eventMeta) {
        const el = meta.note.getSVGElement();
        if (el) {
          paintSvgTree(el, null);
          el.style.filter = "";
        }
      }
      if (nextMarkerEl) nextMarkerEl.style.display = "none";
      nextMarkerIndex = null;
    },
    destroy(): void {
      destroyed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      container.innerHTML = "";
    },
  };
}

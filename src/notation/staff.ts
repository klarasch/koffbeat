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
export type NoteState = "upcoming" | "next" | "active" | "done" | Grade;

export interface StaffView {
  /** x in container CSS px of the notehead centre, and which system (line) it is on. */
  onsetX(eventIndex: number): { x: number; line: number };
  /** The event index nearest `(clientX, clientY)` in page coordinates, or null if too far from any note. Accounts for scroll offset. */
  eventAt(clientX: number, clientY: number): number | null;
  /** Position a thin vertical playhead at `beat` (quarters from the start of bar 1), or hide it when null. Unused by the karaoke-style play screen; kept for future use. */
  setCursor(beat: number | null): void;
  /** Colour the notehead/stem of a single event to reflect a grade. */
  mark(eventIndex: number, grade: Grade): void;
  /** Sets a single event's karaoke-style display state (upcoming/next/active/graded). */
  setState(eventIndex: number, state: NoteState): void;
  /**
   * Smoothly scrolls the staff viewport so the system containing `eventIndex` becomes the top
   * visible line (showing that line and everything below it, to read ahead). Call this wherever
   * the karaoke "next"/"active" position advances. A no-op when the event is already on a
   * visible-enough line, since the browser's smooth scroll is itself cheap to re-target.
   */
  revealEvent(eventIndex: number): void;
  /**
   * Toggles whether the viewport can be scrolled by touch/wheel. During play the position is
   * driven only by `revealEvent` (never by the player dragging); on the results screen the
   * player should be free to scroll and review every system.
   */
  setScrollable(scrollable: boolean): void;
  /**
   * Draws (or, with null, removes) the hold bar under a sustained note: a thin track spanning the
   * note's written length on the staff, filled to `progress` (0..1). `quarters` is the sounding
   * length of the whole tied chain starting at `eventIndex`.
   */
  setHold(eventIndex: number, quarters: number, progress: number | null, state?: "filling" | "ready" | "over"): void;
  /** Remove all grading colours, restoring the default ink. */
  clearMarks(): void;
  destroy(): void;
}

export interface RenderStaffOptions {
  theme?: "dark" | "light";
}

const INK: Record<"dark" | "light", string> = {
  dark: "#e8e4da",
  light: "#2a1e34",
};

/** Played notes take the sand colour of how they landed (shared with the scene's palette). */
export const GRADE_COLORS: Record<Grade, string> = {
  perfect: "#e2621b",
  good: "#f09a3e",
  ok: "#7a4bb0",
  miss: "#d23b3b",
};
/** Notes not reached yet are drawn in a softer ink, so the next one stands out. */
const UPCOMING_ALPHA = 0.5;

/** "active" (finger down) uses the same accent colour as a "perfect" grade, with a stronger glow. */
/** Shadow each floating note casts on the floor below it, by state (opacity). */
const SHADOW_OPACITY: Record<NoteState, number> = { upcoming: 0.35, next: 0.9, active: 1, done: 0.55, perfect: 0.55, good: 0.55, ok: 0.55, miss: 0.55 };
/** How far below the staff line the note shadows fall, in px. */
const SHADOW_DROP = 30;
/** Radius, in container px, within which a tap counts as hitting a given event (see eventAt). */
const HIT_TEST_RADIUS = 26;

// Layout constants, in CSS px.
/** Extra trailing space reserved after each bar's minimum note width, for the barline and breathing room. */
const BAR_PADDING = 22;
const CLEF_TIME_WIDTH = 70;
const TOP_MARGIN = 40;
// A 1-line percussion stave needs far less vertical room between systems than a 5-line stave.
const SYSTEM_GAP = 76;
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
/** Scroll a little above a revealed system's top, so it doesn't sit flush against the viewport edge. */
const REVEAL_LEAD = 10;

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
  beat: number;
}

interface Anchor {
  beat: number;
  x: number;
}

interface BarMeta {
  line: number;
  startBeat: number;
  endBeat: number;
  top: number;
  height: number;
  anchors: Anchor[];
}

/** Builds a fresh, unformatted note per event (dots attached), ready to be voiced and formatted. */
function buildBarNotes(barEvents: RhythmEvent[]): StaveNote[] {
  return barEvents.map((ev) => {
    const note = new StaveNote({
      keys: [PERCUSSION_KEY],
      duration: ev.value,
      dots: ev.dots,
      type: ev.rest ? "r" : undefined,
      clef: "percussion",
      stemDirection: Stem.UP,
    });
    if (ev.dots) Dot.buildAndAttach([note]);
    return note;
  });
}

/**
 * Beams must be generated *before* the notes are formatted: `Beam.generateBeams` suppresses each
 * beamed note's individual flag, which is what the formatter (and preCalculateMinTotalWidth)
 * uses to decide how much room the note needs — skip this and every note in a beamed run is
 * measured (and spaced) as if it still carried its own flag, wildly overestimating bar width.
 */
function beamNotes(notes: StaveNote[], level: Level): Beam[] {
  return Beam.generateBeams(notes, {
    groups: [new Fraction(1, level.meter.beatUnit)],
    beamRests: false,
    stemDirection: Stem.UP,
  });
}

function voiceFor(notes: StaveNote[], level: Level): Voice {
  const voice = new Voice({ numBeats: level.meter.beats, beatValue: level.meter.beatUnit }).setMode(Voice.Mode.STRICT);
  voice.addTickables(notes);
  return voice;
}

/**
 * The minimum width VexFlow needs to typeset a bar's notes without crowding — a bar of
 * sixteenths reports a much larger minimum than a bar of whole notes, which is what lets
 * {@link packSystems} give each bar only the room its own content needs.
 */
function measureBarContentWidth(barEvents: RhythmEvent[], level: Level): number {
  const notes = buildBarNotes(barEvents);
  beamNotes(notes, level);
  const voice = voiceFor(notes, level);
  const formatter = new Formatter();
  formatter.joinVoices([voice]);
  return formatter.preCalculateMinTotalWidth([voice]);
}

interface System {
  /** Indices into `level.bars`. */
  barIndices: number[];
  /** The width (in px) this system's bars are justified to fill. */
  targetWidth: number;
}

/**
 * Greedily packs bars into systems by their content-aware minimum widths (never splitting a bar
 * across systems), then decides each system's justification target: the container width for a
 * normal system, or — for the rare bar whose own minimum width exceeds the container on a phone
 * — that bar's own width, so it gets its own unstretched, unshrunk system instead of overflowing
 * or crowding a neighbour.
 */
/** Printed sight-reading sheets rarely exceed 4 bars a line; wider lines are harder to track. */
const MAX_BARS_PER_SYSTEM = 4;

function packSystems(barMinWidths: number[], availableWidth: number): System[] {
  const systems: System[] = [];
  let current: number[] = [];
  let currentSum = 0;

  for (let i = 0; i < barMinWidths.length; i++) {
    const w = barMinWidths[i] ?? 0;
    if (current.length > 0 && (currentSum + w > availableWidth || current.length >= MAX_BARS_PER_SYSTEM)) {
      systems.push({ barIndices: current, targetWidth: Math.max(availableWidth, currentSum) });
      current = [];
      currentSum = 0;
    }
    current.push(i);
    currentSum += w;
  }
  if (current.length > 0) systems.push({ barIndices: current, targetWidth: Math.max(availableWidth, currentSum) });
  return systems;
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
  let holdEl: HTMLDivElement | null = null;
  /** Floor shadow ellipse per note event (rests cast none). */
  let shadows: (SVGEllipseElement | undefined)[] = [];
  /** Every non-default note state, re-applied after a rebuild (resize) so marks survive it. */
  const states = new Map<number, NoteState>();
  let builtWidth = -1;
  let holdFillEl: HTMLDivElement | null = null;
  let eventMeta: EventMeta[] = [];
  let bars: BarMeta[] = [];
  let scrollable = false;

  function applyScrollStyle(): void {
    container.style.overflowY = scrollable ? "auto" : "hidden";
    container.style.overflowX = "auto";
    container.style.touchAction = scrollable ? "pan-y" : "none";
    container.style.setProperty("-webkit-overflow-scrolling", scrollable ? "touch" : "auto");
  }

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
    holdEl = null;
    holdFillEl = null;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    applyScrollStyle();

    const measuredWidth = container.clientWidth || container.getBoundingClientRect().width || FALLBACK_WIDTH;
    builtWidth = container.clientWidth;
    const availableWidth = Math.max(measuredWidth, CLEF_TIME_WIDTH + 60);
    const totalBars = level.bars.length;

    // Content-aware widths: each bar gets exactly the room its own notes need (plus padding, and
    // the clef/time signature for the very first bar), never an equal share of the line — so a
    // bar of sixteenths can't crowd into overlapping noteheads while a whole-note bar starves
    // its neighbours of the space they need.
    const barMinWidths = level.bars.map((barEvents, i) => measureBarContentWidth(barEvents, level) + BAR_PADDING + (i === 0 ? CLEF_TIME_WIDTH : 0));
    const systems = packSystems(barMinWidths, availableWidth);
    const width = Math.max(availableWidth, ...systems.map((s) => s.targetWidth));
    const totalHeight = TOP_MARGIN + systems.length * SYSTEM_GAP + BOTTOM_MARGIN;

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

    for (let s = 0; s < systems.length; s++) {
      const system = systems[s];
      if (!system) continue;
      const barIndices = system.barIndices;
      const sum = barIndices.reduce((acc, i) => acc + (barMinWidths[i] ?? 0), 0);
      const stretch = sum > 0 ? system.targetWidth / sum : 1;
      const staveY = TOP_MARGIN + s * SYSTEM_GAP;
      let xCursor = 0;

      for (let bi = 0; bi < barIndices.length; bi++) {
        const isLastBarOfSystem = bi === barIndices.length - 1;
        const isFirstBarOverall = globalBarIndex === 0;
        const isLastBarOverall = globalBarIndex === totalBars - 1;

        const rawWidth = (barMinWidths[globalBarIndex] ?? 0) * stretch;
        const staveWidth = isLastBarOfSystem ? Math.max(1, Math.round(system.targetWidth - xCursor)) : Math.max(1, Math.round(rawWidth));

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
        const notes = buildBarNotes(barEvents);
        const beams = beamNotes(notes, level);
        const voice = voiceFor(notes, level);
        new Formatter().joinVoices([voice]).formatToStave([voice], stave);

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
          newEventMeta[globalIndex] = { note, x, line: s, beat: beatAcc };
          barAnchors.push({ beat: beatAcc, x });
          beatAcc += eventQuarters(ev);
        });
        barAnchors.push({ beat: beatAcc, x: stave.getNoteEndX() });

        newBars.push({
          line: s,
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
    // A tie whose two notes land on different systems is drawn as two half-ties, engraved-music
    // style — StaveTie renders a partial tie out to its own stave's edge when the other side is
    // omitted, so passing a null firstNote/lastNote does exactly the right thing here.
    let flatIndex = 0;
    for (const bar of level.bars) {
      for (const ev of bar) {
        if (ev.tie) {
          const firstNote = noteByEvent[flatIndex];
          const lastNote = noteByEvent[flatIndex + 1];
          const firstMeta = newEventMeta[flatIndex];
          const lastMeta = newEventMeta[flatIndex + 1];
          if (firstNote && lastNote && firstMeta && lastMeta) {
            if (firstMeta.line === lastMeta.line) {
              new StaveTie({ firstNote, lastNote }).setContext(ctx).draw();
            } else {
              new StaveTie({ firstNote, lastNote: null }).setContext(ctx).draw();
              new StaveTie({ firstNote: null, lastNote }).setContext(ctx).draw();
            }
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

    const svgEl = container.querySelector("svg");
    shadows = [];
    if (svgEl) {
      svgEl.style.display = "block";
      svgEl.style.overflow = "visible";
      // The notes float above the floor: each casts a soft shadow below the staff line.
      const ns = "http://www.w3.org/2000/svg";
      const defs = document.createElementNS(ns, "defs");
      defs.innerHTML = `<radialGradient id="note-shadow"><stop offset="0" stop-color="${ink}" stop-opacity="0.22"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/></radialGradient>`;
      const layer = document.createElementNS(ns, "g");
      layer.setAttribute("class", "note-shadows");
      let flat = 0;
      for (const bar of level.bars) {
        for (const ev of bar) {
          const meta = eventMeta[flat];
          if (meta && !ev.rest) {
            const e = document.createElementNS(ns, "ellipse");
            e.setAttribute("cx", String(meta.x));
            e.setAttribute("cy", String(TOP_MARGIN + meta.line * SYSTEM_GAP + 40 + SHADOW_DROP));
            e.setAttribute("rx", "11");
            e.setAttribute("ry", "2.6");
            e.setAttribute("fill", "url(#note-shadow)");
            e.setAttribute("stroke", "none");
            e.style.opacity = String(SHADOW_OPACITY.upcoming);
            layer.appendChild(e);
            shadows[flat] = e;
          }
          flat++;
        }
      }
      svgEl.insertBefore(layer, svgEl.firstChild);
      svgEl.insertBefore(defs, svgEl.firstChild);
      // Every note starts in the soft "upcoming" ink.
      for (const meta of eventMeta) {
        const el = meta?.note.getSVGElement();
        if (el) el.style.opacity = String(UPCOMING_ALPHA);
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

  // Layout depends only on width: a height change (the results panel opening) needs no rebuild.
  resizeObserver = new ResizeObserver(() => {
    if (container.clientWidth === builtWidth) return;
    const scrollTop = container.scrollTop;
    build();
    for (const [eventIndex, state] of states) view.setState(eventIndex, state);
    container.scrollTop = scrollTop;
  });
  resizeObserver.observe(container);

  function ensureNextMarker(): HTMLDivElement {
    if (nextMarkerEl) return nextMarkerEl;
    const marker = document.createElement("div");
    marker.style.position = "absolute";
    // A short glowing dash under the notehead: never beside it, where a dot would read as a
    // dotted note.
    marker.style.width = "14px";
    marker.style.height = "2px";
    marker.style.borderRadius = "1px";
    marker.style.background = ink;
    marker.style.opacity = "0.9";
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
    marker.style.left = `${meta.x}px`;
    marker.style.top = `${staveY + 53}px`;
    marker.style.display = "block";
    nextMarkerIndex = eventIndex;
  }

  function hideNextMarkerIfOwnedBy(eventIndex: number): void {
    if (nextMarkerIndex === eventIndex && nextMarkerEl) {
      nextMarkerEl.style.display = "none";
      nextMarkerIndex = null;
    }
  }

  function ensureHoldBar(): { track: HTMLDivElement; fill: HTMLDivElement } {
    if (holdEl && holdFillEl) return { track: holdEl, fill: holdFillEl };
    const track = document.createElement("div");
    track.className = "staff-hold";
    const fill = document.createElement("div");
    fill.className = "staff-hold-fill";
    track.appendChild(fill);
    container.appendChild(track);
    holdEl = track;
    holdFillEl = fill;
    return { track, fill };
  }

  /** x where a note starting at `meta` and lasting `quarters` ends, clamped to the note's own line. */
  function holdEndX(meta: EventMeta, quarters: number): number {
    const endBeat = meta.beat + quarters;
    const lineBars = bars.filter((b) => b.line === meta.line);
    const lastOnLine = lineBars[lineBars.length - 1];
    if (!lastOnLine) return meta.x + 40;
    if (endBeat >= lastOnLine.endBeat) return lastOnLine.anchors[lastOnLine.anchors.length - 1]?.x ?? meta.x + 40;
    const bar = lineBars.find((b) => endBeat >= b.startBeat && endBeat < b.endBeat) ?? lastOnLine;
    return interpolateX(bar, endBeat) - 8;
  }

  const view: StaffView = {
    setHold(eventIndex: number, quarters: number, progress: number | null, state: "filling" | "ready" | "over" = "filling"): void {
      if (progress === null) {
        if (holdEl) holdEl.style.display = "none";
        return;
      }
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const { track, fill } = ensureHoldBar();
      const left = meta.x - 6;
      const right = Math.max(left + 16, holdEndX(meta, quarters));
      track.style.display = "block";
      track.style.left = `${left}px`;
      track.style.width = `${right - left}px`;
      track.style.top = `${TOP_MARGIN + meta.line * SYSTEM_GAP + 52}px`;
      track.dataset.state = state;
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    },
    onsetX(eventIndex: number): { x: number; line: number } {
      const meta = eventMeta[eventIndex];
      if (!meta) throw new RangeError(`onsetX: no event at index ${eventIndex}`);
      return { x: meta.x, line: meta.line };
    },
    eventAt(clientX: number, clientY: number): number | null {
      // container is itself the scrolling element (see applyScrollStyle): its bounding rect is
      // the fixed on-screen viewport, so a screen point has to be shifted by the current scroll
      // offset to land back in the same (unscrolled) content coordinate space that eventMeta and
      // onsetX use.
      const rect = container.getBoundingClientRect();
      const localX = clientX - rect.left + container.scrollLeft;
      const localY = clientY - rect.top + container.scrollTop;
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
    setState(eventIndex: number, state: NoteState): void {
      if (state === "upcoming") states.delete(eventIndex);
      else states.set(eventIndex, state);
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const el = meta.note.getSVGElement();
      if (!el) return;

      if (state !== "next") hideNextMarkerIfOwnedBy(eventIndex);
      const shadow = shadows[eventIndex];
      if (shadow) shadow.style.opacity = String(SHADOW_OPACITY[state]);

      switch (state) {
        case "upcoming":
          paintSvgTree(el, null);
          el.style.opacity = String(UPCOMING_ALPHA);
          break;
        case "next":
          paintSvgTree(el, ink);
          el.style.opacity = "1";
          positionNextMarker(eventIndex);
          break;
        case "active":
        case "done":
          paintSvgTree(el, ink);
          el.style.opacity = "1";
          break;
        default:
          paintSvgTree(el, GRADE_COLORS[state]);
          el.style.opacity = "1";
          break;
      }
    },
    revealEvent(eventIndex: number): void {
      const meta = eventMeta[eventIndex];
      if (!meta) return;
      const target = Math.max(0, TOP_MARGIN + meta.line * SYSTEM_GAP - REVEAL_LEAD);
      if (typeof container.scrollTo === "function") {
        try {
          container.scrollTo({ top: target, behavior: "smooth" });
          return;
        } catch {
          // fall through to a plain assignment below
        }
      }
      container.scrollTop = target;
    },
    setScrollable(value: boolean): void {
      scrollable = value;
      applyScrollStyle();
    },
    clearMarks(): void {
      states.clear();
      for (const meta of eventMeta) {
        const el = meta.note.getSVGElement();
        if (el) {
          paintSvgTree(el, null);
          el.style.opacity = String(UPCOMING_ALPHA);
        }
        const shadow = shadows[eventMeta.indexOf(meta)];
        if (shadow) shadow.style.opacity = String(SHADOW_OPACITY.upcoming);
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
  return view;
}

// Renders a single-line percussion rhythm staff with VexFlow 5 (or, for a two-hand level, two
// single-line staves joined by a brace: right hand on top, left hand below) and exposes a small
// runtime API for cursor sweeps and per-note grading marks. See AGENTS/spec for the contract.

import { BarlineType, Beam, Dot, Formatter, Fraction, type RenderContext, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Stem, Tuplet, Voice } from "vexflow";
import { eventQuarters, levelLines } from "../rhythm/durations";
import type { Grade, Level, RhythmEvent } from "../types";

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
  /** Softly highlights one bar (0-based), or none with null: where the music is right now. */
  setBarHighlight(barIndex: number | null): void;
  /** The index of the first event in a bar (0-based), for scrolling it into view. */
  firstEventOfBar(barIndex: number): number;
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

/** Played notes take a sand colour by how they landed: purple clean, light purple good, orange close, red miss (shared with the scene's palette). */
export const GRADE_COLORS: Record<Grade, string> = {
  perfect: "#6b3fa0",
  good: "#a466c8",
  ok: "#f09a3e",
  miss: "#d23b3b",
};
/** Notes not reached yet are drawn in a softer ink, so the next one stands out. */
const UPCOMING_ALPHA = 0.5;

/** "active" (finger down) uses the same accent colour as a "perfect" grade, with a stronger glow. */
/** Shadow each floating note casts on the floor below it, by state (opacity). */
const SHADOW_OPACITY: Record<NoteState, number> = { upcoming: 0.35, next: 0.9, active: 1, done: 0.55, perfect: 0.55, good: 0.55, ok: 0.55, miss: 0.55 };
/** Notes can cast a soft shadow below them; off while the scene is a groundless void. */
const NOTE_SHADOWS = false;
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
/** Two-hand levels: the distance from the right hand's staff down to the left hand's. */
const LINE_GAP = 66;
/** Room for the brace in front of a two-hand system. */
const BRACE_WIDTH = 14;
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

interface EventMeta {
  note: StaveNote;
  x: number;
  /** The system (row of bars) it's on. */
  line: number;
  /** The rhythm line (hand) it belongs to: always 0 on a one-line level. */
  hand: number;
  /** y of its own stave (the stave's top, 40px above the visible line). */
  staveY: number;
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
  /** Beat → x anchors per hand (the same for both hands where their beats coincide). */
  anchorsByHand: Anchor[][];
  anchors: Anchor[];
}

/** Builds a fresh, unformatted note per event (dots attached), ready to be voiced and formatted. */
function buildBarNotes(barEvents: RhythmEvent[]): StaveNote[] {
  const notes = barEvents.map((ev) => {
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
  return notes;
}

/**
 * Triplet groups (three of the same value in the time of two), created before the notes are
 * voiced, since a tuplet changes its notes' ticks. Drawn after the voice, as a "3" over the
 * group (bracketed unless the group is beamed).
 */
function buildTuplets(barEvents: RhythmEvent[], notes: StaveNote[]): Tuplet[] {
  const tuplets: Tuplet[] = [];
  let group: StaveNote[] = [];
  barEvents.forEach((ev, i) => {
    const note = notes[i];
    if (ev.tuplet !== 3 || !note) {
      group = [];
      return;
    }
    group.push(note);
    if (group.length === 3) {
      tuplets.push(new Tuplet(group, { numNotes: 3, notesOccupied: 2, ratioed: false }));
      group = [];
    }
  });
  return tuplets;
}

/** One bar of one line, ready to format: notes (with tuplets and beams applied) and its voice. */
interface BarVoice {
  notes: StaveNote[];
  beams: Beam[];
  tuplets: Tuplet[];
  voice: Voice;
}

function buildBarVoice(barEvents: RhythmEvent[], level: Level): BarVoice {
  const notes = buildBarNotes(barEvents);
  const tuplets = buildTuplets(barEvents, notes);
  const beams = beamNotes(notes, level);
  const voice = voiceFor(notes, level);
  return { notes, beams, tuplets, voice };
}

/** Formats every hand's voice for a bar together, so notes on the same beat line up. */
function joinedFormatter(voices: Voice[]): Formatter {
  const formatter = new Formatter();
  for (const voice of voices) formatter.joinVoices([voice]);
  return formatter;
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
function measureBarContentWidth(barByHand: RhythmEvent[][], level: Level): number {
  const voices = barByHand.map((events) => buildBarVoice(events, level).voice);
  return joinedFormatter(voices).preCalculateMinTotalWidth(voices);
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
function drawBarline(ctx: RenderContext, x: number, lineY: number, staffSpace: number, kind: "single" | "final", bottomLineY = lineY): void {
  const extend = staffSpace * BARLINE_SPACE_MULTIPLIER;
  const top = lineY - extend;
  const bottom = bottomLineY + extend;

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
  /** Each hand's bars: one line, or [left, right] on a two-hand level. */
  const handLines = levelLines(level);
  const handCount = handLines.length;
  const barCount = handLines[0]?.length ?? 0;
  /** Event indices run through the left hand's line first, then the right hand's. */
  const handOffset: number[] = [];
  {
    let offset = 0;
    for (const bars of handLines) {
      handOffset.push(offset);
      offset += bars.reduce((n, bar) => n + bar.length, 0);
    }
  }
  /** Rows within a system, top to bottom: the right hand above the left, as on a piano staff. */
  const rowOfHand = (hand: number) => (handCount === 2 ? 1 - hand : 0);
  const systemGap = SYSTEM_GAP + (handCount - 1) * LINE_GAP;
  /** Every event in index order, with its hand. */
  const flatEvents: { ev: RhythmEvent; hand: number }[] = handLines.flatMap((bars, hand) => bars.flat().map((ev) => ({ ev, hand })));

  let destroyed = false;
  let resizeObserver: ResizeObserver | null = null;
  let cursorEl: HTMLDivElement | null = null;
  /** One "next" marker and one hold bar per hand, so both hands can be shown at once. */
  const nextMarkers = new Map<number, { el: HTMLDivElement; eventIndex: number | null }>();
  const holdBars = new Map<number, { track: HTMLDivElement; fill: HTMLDivElement }>();
  let barBandEl: HTMLDivElement | null = null;
  let highlightedBar: number | null = null;
  /** Floor shadow ellipse per note event (rests cast none). */
  let shadows: (SVGEllipseElement | undefined)[] = [];
  /** Every non-default note state, re-applied after a rebuild (resize) so marks survive it. */
  const states = new Map<number, NoteState>();
  let builtWidth = -1;
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
    nextMarkers.clear();
    holdBars.clear();
    barBandEl = null;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    applyScrollStyle();

    const measuredWidth = container.clientWidth || container.getBoundingClientRect().width || FALLBACK_WIDTH;
    builtWidth = container.clientWidth;
    const availableWidth = Math.max(measuredWidth, CLEF_TIME_WIDTH + 60);
    const totalBars = barCount;
    const barByHand = (barIndex: number) => handLines.map((bars) => bars[barIndex] ?? []);
    const leadWidth = CLEF_TIME_WIDTH + (handCount > 1 ? BRACE_WIDTH : 0);

    // Content-aware widths: each bar gets exactly the room its own notes need (plus padding, and
    // the clef/time signature for the very first bar), never an equal share of the line — so a
    // bar of sixteenths can't crowd into overlapping noteheads while a whole-note bar starves
    // its neighbours of the space they need. Two hands share each bar's width.
    const barMinWidths = Array.from({ length: totalBars }, (_, i) => measureBarContentWidth(barByHand(i), level) + BAR_PADDING + (i === 0 ? leadWidth : 0));
    const systems = packSystems(barMinWidths, availableWidth);
    const width = Math.max(availableWidth, ...systems.map((s) => s.targetWidth));
    const totalHeight = TOP_MARGIN + systems.length * systemGap + BOTTOM_MARGIN;

    const renderer = new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
    renderer.resize(width, totalHeight);
    const ctx = renderer.getContext();
    ctx.setFillStyle(ink);
    ctx.setStrokeStyle(ink);

    const newEventMeta: EventMeta[] = [];
    const newBars: BarMeta[] = [];
    const noteByEvent: StaveNote[] = [];
    /** Next event index to assign, per hand. */
    const nextIndex = [...handOffset];

    let globalBeat = 0;
    let globalBarIndex = 0;

    for (let s = 0; s < systems.length; s++) {
      const system = systems[s];
      if (!system) continue;
      const barIndices = system.barIndices;
      const sum = barIndices.reduce((acc, i) => acc + (barMinWidths[i] ?? 0), 0);
      const stretch = sum > 0 ? system.targetWidth / sum : 1;
      const systemY = TOP_MARGIN + s * systemGap;
      // Two hands: a brace in front of the system, pushing the first bar in a little.
      let xCursor = handCount > 1 ? BRACE_WIDTH : 0;
      let firstStaves: Stave[] = [];

      for (let bi = 0; bi < barIndices.length; bi++) {
        const isLastBarOfSystem = bi === barIndices.length - 1;
        const isFirstBarOverall = globalBarIndex === 0;
        const isLastBarOverall = globalBarIndex === totalBars - 1;

        const rawWidth = (barMinWidths[globalBarIndex] ?? 0) * stretch - (bi === 0 && handCount > 1 ? BRACE_WIDTH : 0);
        const staveWidth = isLastBarOfSystem ? Math.max(1, Math.round(system.targetWidth - xCursor)) : Math.max(1, Math.round(rawWidth));

        // A 5-line stave with only the middle line visible per hand: clef, time signature and
        // "b/4" notes all centre on the middle line, which is how VexFlow expects single-line
        // percussion.
        const staves = handLines.map((_, hand) => {
          const stave = new Stave(xCursor, systemY + rowOfHand(hand) * LINE_GAP, staveWidth, { spaceAboveStaffLn: 2 });
          stave.setConfigForLines([{ visible: false }, { visible: false }, { visible: true }, { visible: false }, { visible: false }]);
          if (isFirstBarOverall) {
            stave.addClef("percussion");
            stave.addTimeSignature(`${level.meter.beats}/${level.meter.beatUnit}`);
          }
          // VexFlow's own begin/end barlines collapse to ~0 height on a 1-line stave, so both
          // are suppressed here and every bar's trailing edge gets a hand-drawn barline instead
          // (see drawBarline below) — a single line between bars, a final double line at the end.
          stave.setBegBarType(BarlineType.NONE);
          stave.setEndBarType(BarlineType.NONE);
          stave.setContext(ctx).draw();
          return stave;
        });
        if (bi === 0) firstStaves = staves;
        xCursor += staveWidth;

        const barStartBeat = globalBeat;
        const bars = barByHand(globalBarIndex).map((events) => buildBarVoice(events, level));
        // Both hands are formatted as one, so notes on the same beat sit exactly above each other.
        const topStave = staves[0];
        if (!topStave) continue;
        joinedFormatter(bars.map((b) => b.voice)).formatToStave(
          bars.map((b) => b.voice),
          topStave,
        );

        const anchorsByHand: Anchor[][] = [];
        let barEndBeat = barStartBeat;
        bars.forEach((bar, hand) => {
          const stave = staves[hand];
          if (!stave) return;
          bar.voice.draw(ctx, stave);
          bar.beams.forEach((beam) => beam.setContext(ctx).draw());
          bar.tuplets.forEach((tuplet) => tuplet.setContext(ctx).draw());

          const events = handLines[hand]?.[globalBarIndex] ?? [];
          const anchors: Anchor[] = [{ beat: barStartBeat, x: stave.getNoteStartX() }];
          let beatAcc = barStartBeat;
          events.forEach((ev, i) => {
            const note = bar.notes[i];
            if (!note) return;
            const x = (note.getNoteHeadBeginX() + note.getNoteHeadEndX()) / 2;
            const globalIndex = nextIndex[hand] ?? 0;
            nextIndex[hand] = globalIndex + 1;
            noteByEvent[globalIndex] = note;
            newEventMeta[globalIndex] = { note, x, line: s, hand, staveY: stave.getY(), beat: beatAcc };
            anchors.push({ beat: beatAcc, x });
            beatAcc += eventQuarters(ev);
          });
          anchors.push({ beat: beatAcc, x: stave.getNoteEndX() });
          anchorsByHand[hand] = anchors;
          barEndBeat = Math.max(barEndBeat, beatAcc);
        });

        // A barline at this bar's trailing edge (never a leading one — see the NONE begin type
        // above): single between bars, final/double at the very end of the piece. With two
        // hands it runs through both staves, joining them.
        const lineYs = staves.map((st) => st.getYForLine(STAFF_LINE));
        drawBarline(ctx, xCursor, Math.min(...lineYs), topStave.getSpacingBetweenLines(), isLastBarOverall ? "final" : "single", Math.max(...lineYs));

        newBars.push({
          line: s,
          startBeat: barStartBeat,
          endBeat: barEndBeat,
          top: systemY - CURSOR_TOP_OFFSET,
          height: CURSOR_HEIGHT + (handCount - 1) * LINE_GAP,
          anchorsByHand,
          anchors: anchorsByHand[handCount - 1] ?? anchorsByHand[0] ?? [],
        });

        globalBeat = barEndBeat;
        globalBarIndex++;
      }

      // The brace and the opening line joining the two hands' staves.
      if (handCount > 1) {
        const [top, bottom] = [...firstStaves].sort((x, y) => x.getY() - y.getY());
        if (top && bottom) {
          new StaveConnector(top, bottom).setType("brace").setContext(ctx).draw();
          const yTop = top.getYForLine(STAFF_LINE) - top.getSpacingBetweenLines();
          const yBottom = bottom.getYForLine(STAFF_LINE) + bottom.getSpacingBetweenLines();
          ctx.save();
          ctx.setLineWidth(1);
          ctx.beginPath();
          ctx.moveTo(top.getX(), yTop);
          ctx.lineTo(top.getX(), yBottom);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Ties, including across barlines: walk the flattened events again to know which pairs tie.
    // A tie whose two notes land on different systems is drawn as two half-ties, engraved-music
    // style — StaveTie renders a partial tie out to its own stave's edge when the other side is
    // omitted, so passing a null firstNote/lastNote does exactly the right thing here.
    flatEvents.forEach(({ ev }, flatIndex) => {
      if (!ev.tie) return;
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
    });

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
      flatEvents.forEach(({ ev }, flat) => {
        const meta = eventMeta[flat];
        if (meta && !ev.rest && NOTE_SHADOWS) {
          const e = document.createElementNS(ns, "ellipse");
          e.setAttribute("cx", String(meta.x));
          e.setAttribute("cy", String(meta.staveY + 40 + SHADOW_DROP));
          e.setAttribute("rx", "11");
          e.setAttribute("ry", "2.6");
          e.setAttribute("fill", "url(#note-shadow)");
          e.setAttribute("stroke", "none");
          e.style.opacity = String(SHADOW_OPACITY.upcoming);
          layer.appendChild(e);
          shadows[flat] = e;
        }
      });
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
    view.setBarHighlight(highlightedBar);
    container.scrollTop = scrollTop;
  });
  resizeObserver.observe(container);

  function ensureNextMarker(hand: number): { el: HTMLDivElement; eventIndex: number | null } {
    const existing = nextMarkers.get(hand);
    if (existing) return existing;
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
    const entry = { el: marker, eventIndex: null as number | null };
    nextMarkers.set(hand, entry);
    return entry;
  }

  function positionNextMarker(eventIndex: number): void {
    const meta = eventMeta[eventIndex];
    if (!meta) return;
    const marker = ensureNextMarker(meta.hand);
    marker.el.style.left = `${meta.x}px`;
    marker.el.style.top = `${meta.staveY + 53}px`;
    marker.el.style.display = "block";
    marker.eventIndex = eventIndex;
  }

  function hideNextMarkerIfOwnedBy(eventIndex: number): void {
    for (const marker of nextMarkers.values()) {
      if (marker.eventIndex === eventIndex) {
        marker.el.style.display = "none";
        marker.eventIndex = null;
      }
    }
  }

  function ensureHoldBar(hand: number): { track: HTMLDivElement; fill: HTMLDivElement } {
    const existing = holdBars.get(hand);
    if (existing) return existing;
    const track = document.createElement("div");
    track.className = "staff-hold";
    const fill = document.createElement("div");
    fill.className = "staff-hold-fill";
    track.appendChild(fill);
    container.appendChild(track);
    const entry = { track, fill };
    holdBars.set(hand, entry);
    return entry;
  }

  /** x where a note starting at `meta` and lasting `quarters` ends, clamped to the note's own line. */
  function holdEndX(meta: EventMeta, quarters: number): number {
    const endBeat = meta.beat + quarters;
    const lineBars = bars.filter((b) => b.line === meta.line);
    const lastOnLine = lineBars[lineBars.length - 1];
    if (!lastOnLine) return meta.x + 40;
    const handAnchors = (bar: BarMeta) => bar.anchorsByHand[meta.hand] ?? bar.anchors;
    if (endBeat >= lastOnLine.endBeat) {
      const anchors = handAnchors(lastOnLine);
      return anchors[anchors.length - 1]?.x ?? meta.x + 40;
    }
    const bar = lineBars.find((b) => endBeat >= b.startBeat && endBeat < b.endBeat) ?? lastOnLine;
    return interpolateX({ ...bar, anchors: handAnchors(bar) }, endBeat) - 8;
  }

  // First event index of each bar, from the level itself (stable across rebuilds). On a
  // two-hand level, the right hand's (the top staff, where the eye starts reading).
  const barFirstEvent: number[] = [];
  {
    const hand = handCount - 1;
    let flat = handOffset[hand] ?? 0;
    for (const bar of handLines[hand] ?? []) {
      barFirstEvent.push(flat);
      flat += bar.length;
    }
  }

  const view: StaffView = {
    setBarHighlight(barIndex: number | null): void {
      highlightedBar = barIndex;
      const bar = barIndex === null ? undefined : bars[barIndex];
      if (!bar) {
        if (barBandEl) barBandEl.style.display = "none";
        return;
      }
      if (!barBandEl) {
        barBandEl = document.createElement("div");
        barBandEl.className = "staff-bar-band";
        container.insertBefore(barBandEl, container.firstChild);
      }
      const first = bar.anchors[0]?.x ?? 0;
      const last = bar.anchors[bar.anchors.length - 1]?.x ?? first;
      barBandEl.style.display = "block";
      barBandEl.style.left = `${first - 10}px`;
      barBandEl.style.width = `${Math.max(20, last - first + 16)}px`;
      barBandEl.style.top = `${TOP_MARGIN + bar.line * systemGap + 2}px`;
      barBandEl.style.height = `${58 + (handCount - 1) * LINE_GAP}px`;
    },
    firstEventOfBar(barIndex: number): number {
      return barFirstEvent[Math.max(0, Math.min(barFirstEvent.length - 1, barIndex))] ?? 0;
    },
    setHold(eventIndex: number, quarters: number, progress: number | null, state: "filling" | "ready" | "over" = "filling"): void {
      const meta = eventMeta[eventIndex];
      if (progress === null) {
        // Hides the hold bar of the event's own hand (both hands' when the event is unknown).
        for (const [hand, bar] of holdBars) if (!meta || meta.hand === hand) bar.track.style.display = "none";
        return;
      }
      if (!meta) return;
      const { track, fill } = ensureHoldBar(meta.hand);
      const left = meta.x - 6;
      const right = Math.max(left + 16, holdEndX(meta, quarters));
      track.style.display = "block";
      track.style.left = `${left}px`;
      track.style.width = `${right - left}px`;
      track.style.top = `${meta.staveY + 52}px`;
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
        // Measured from between the notehead and the top of its stem.
        const dist = Math.hypot(meta.x - localX, meta.staveY + 25 - localY);
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
      const target = Math.max(0, TOP_MARGIN + meta.line * systemGap - REVEAL_LEAD);
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
      for (const marker of nextMarkers.values()) {
        marker.el.style.display = "none";
        marker.eventIndex = null;
      }
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

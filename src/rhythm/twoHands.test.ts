import { describe, expect, it } from "vitest";
import type { Hand, Hit, Level, Onset, Release, RhythmEvent } from "../types";
import { eventQuarters, validateLevel } from "./durations";
import { note, rest } from "./generate";
import { createLiveJudge, judgeRun } from "./judge";
import { levelOnsets, restSpans } from "./onsets";
import { generateTwoHandLevel, TWO_HAND_STAGES } from "./twoHands";

const BPM = 60; // one quarter per second keeps the arithmetic readable
const START = 10;
const SPQ = 60 / BPM;

const q = () => note("q");
const t3 = (): RhythmEvent => ({ ...note("q"), tuplet: 3 });

function twoHand(left: RhythmEvent[][], right: RhythmEvent[][]): Level {
  return { id: "test-2h", title: "test", meter: { beats: 4, beatUnit: 4 }, bpm: BPM, bars: left, lines: [left, right] };
}

/** Plays every onset of `hand` at exactly its time, in that hand's zone (or `zone`). */
function play(onsets: Onset[], hand: Hand, zone: Hand = hand, offsetSec = 0): Hit[] {
  return onsets.filter((o) => o.line === hand).map((o) => ({ time: START + o.beat * SPQ + offsetSec, zone }));
}

function byTime(hits: Hit[]): Hit[] {
  return [...hits].sort((a, b) => a.time - b.time);
}

/** Each tap let go shortly after (a short key press), as play.ts records from key-up. */
function taps(hits: Hit[]): Release[] {
  return hits.map((h) => ({ time: h.time + 0.12, zone: h.zone }));
}

/** Taps live, in time order, the way play.ts does. */
function playLive(onsets: Onset[], hits: Hit[]) {
  const judge = createLiveJudge(onsets, START, BPM);
  return byTime(hits).map((hit) => ({ hit, judged: judge.judgeHit(hit) }));
}

// Left: steady quarters. Right: quarters with a half note and rests.
const independent = twoHand(
  [
    [q(), q(), q(), q()],
    [q(), q(), q(), q()],
  ],
  [
    [note("h"), q(), q()],
    [q(), rest("q"), note("h")],
  ],
);

// Three against two: quarter triplets in the right hand over quarters in the left.
const polyrhythm = twoHand(
  [
    [q(), q(), q(), q()],
    [q(), q(), q(), q()],
  ],
  [
    [t3(), t3(), t3(), t3(), t3(), t3()],
    [t3(), t3(), t3(), note("h")],
  ],
);

describe("two-hand onsets", () => {
  it("tags each onset with its line, numbers events across both lines, and sorts by beat", () => {
    const onsets = levelOnsets(independent);
    expect(onsets.filter((o) => o.line === 0)).toHaveLength(8);
    expect(onsets.filter((o) => o.line === 1)).toHaveLength(5);
    // The right hand's events come after the left hand's 8.
    expect(Math.min(...onsets.filter((o) => o.line === 1).map((o) => o.eventIndex))).toBe(8);
    for (let i = 1; i < onsets.length; i++) expect(onsets[i]!.beat).toBeGreaterThanOrEqual(onsets[i - 1]!.beat);
    const rests = restSpans(independent);
    expect(rests).toEqual([{ eventIndex: 12, beat: 5, quarters: 1, line: 1 }]);
  });

  it("places quarter triplets at thirds of the half bar", () => {
    const right = levelOnsets(polyrhythm).filter((o) => o.line === 1);
    const beats = right.slice(0, 4).map((o) => o.beat);
    [0, 2 / 3, 4 / 3].forEach((b, i) => expect(beats[i]).toBeCloseTo(b, 5));
    expect(beats[3]).toBe(2);
    expect(eventQuarters(t3())).toBeCloseTo(2 / 3, 9);
  });

  it("leaves one-line levels untagged", () => {
    const one: Level = { ...independent, lines: undefined };
    expect(levelOnsets(one).every((o) => o.line === undefined)).toBe(true);
  });
});

describe("two-hand judging", () => {
  it("grades both hands perfect when each plays its own line on time", () => {
    const onsets = levelOnsets(independent);
    const hits = byTime([...play(onsets, 0), ...play(onsets, 1)]);
    // Short taps, except the half notes, which are held their full length.
    const releases = taps(hits).map((r, i) => {
      const onset = onsets.find((o) => o.line === hits[i]!.zone && Math.abs(START + o.beat * SPQ - hits[i]!.time) < 1e-9);
      return onset && onset.quarters > 1 ? { ...r, time: hits[i]!.time + onset.quarters * SPQ - 0.03 } : r;
    });
    const result = judgeRun(onsets, restSpans(independent), START, BPM, hits, releases);
    expect(result.judgements.every((j) => j.grade === "perfect")).toBe(true);
    expect(result.extraHits).toHaveLength(0);
    expect(result.handAccuracy?.[0]).toBeGreaterThan(98);
    expect(result.handAccuracy?.[1]).toBeGreaterThan(98);
  });

  it("matches a zone only to its own line: the right hand can't play the left hand's notes", () => {
    const onsets = levelOnsets(independent);
    // Both lines played, but every tap in the right zone.
    const hits = byTime([...play(onsets, 0, 1), ...play(onsets, 1)]);
    const result = judgeRun(onsets, restSpans(independent), START, BPM, hits, []);
    const left = result.judgements.filter((j) => j.onset.line === 0);
    const right = result.judgements.filter((j) => j.onset.line === 1);
    expect(left.every((j) => j.hitTime === null)).toBe(true);
    expect(right.every((j) => j.grade !== "miss")).toBe(true);
    expect(result.extraHits.length).toBeGreaterThan(0);
    expect(result.handAccuracy![0]).toBeLessThan(35);
    expect(result.handAccuracy![1]).toBeGreaterThan(result.handAccuracy![0] + 20);
  });

  it("live: simultaneous taps in both zones each take their own line's note", () => {
    const onsets = levelOnsets(independent);
    const judged = playLive(onsets, [...play(onsets, 0), ...play(onsets, 1)]);
    for (const { hit, judged: j } of judged) {
      expect(j.onsetIndex).not.toBeNull();
      expect(onsets[j.onsetIndex!]!.line).toBe(hit.zone);
      expect(j.grade).toBe("perfect");
    }
    const matched = new Set(judged.map((j) => j.judged.onsetIndex));
    expect(matched.size).toBe(onsets.length);
  });

  it("live: a silent hand doesn't hold up the other hand's line", () => {
    const onsets = levelOnsets(independent);
    const judged = playLive(onsets, play(onsets, 1));
    expect(judged.every((j) => j.judged.grade === "perfect" && onsets[j.judged.onsetIndex!]!.line === 1)).toBe(true);
  });

  it("live: a wrong-hand tap where only the other hand has a note is a stray", () => {
    const onsets = levelOnsets(independent);
    const judge = createLiveJudge(onsets, START, BPM);
    // Beat 1: only the left hand plays (the right holds its half note). A right-zone tap there
    // must not jump ahead to the right hand's next note at beat 2.
    judge.judgeHit({ time: START, zone: 0 });
    judge.judgeHit({ time: START, zone: 1 });
    const stray = judge.judgeHit({ time: START + 1 * SPQ, zone: 1 });
    expect(stray.grade === null || stray.grade === "miss").toBe(true);
    const leftAtBeat1 = judge.judgeHit({ time: START + 1 * SPQ, zone: 0 });
    expect(onsets[leftAtBeat1.onsetIndex!]?.beat).toBe(1);
    expect(leftAtBeat1.grade).toBe("perfect");
  });

  it("shares one pulse across both hands: a player slowing down is followed by either hand's taps", () => {
    const onsets = levelOnsets(independent);
    // 6% slower throughout, both hands together.
    const slow = (hits: Hit[]) => hits.map((h) => ({ ...h, time: START + (h.time - START) * 1.06 }));
    const judged = playLive(onsets, slow([...play(onsets, 0), ...play(onsets, 1)]));
    expect(judged.filter((j) => j.judged.grade === "miss" || j.judged.grade === null)).toHaveLength(0);
  });

  it("grades a held note from its own hand's release, not the other hand's next press", () => {
    const onsets = levelOnsets(independent);
    const hits = byTime([...play(onsets, 0), ...play(onsets, 1)]);
    // Right hand holds the opening half note its full length (beats 0–2) while the left keeps tapping.
    const releases: Release[] = [{ time: START + 2 * SPQ - 0.02, zone: 1 }];
    const result = judgeRun(onsets, restSpans(independent), START, BPM, hits, releases);
    const half = result.judgements.find((j) => j.onset.line === 1 && j.onset.beat === 0)!;
    expect(half.releaseTime).toBeCloseTo(START + 2 * SPQ - 0.02, 6);
    expect(half.releaseGrade).toBe("perfect");
  });

  it("judges a rest by its own hand: the other hand playing through it keeps it clean", () => {
    const onsets = levelOnsets(independent);
    const both = byTime([...play(onsets, 0), ...play(onsets, 1)]);
    // The left hand taps at beat 5, right inside the right hand's rest.
    expect(both.some((h) => h.zone === 0 && Math.abs(h.time - (START + 5 * SPQ)) < 1e-9)).toBe(true);
    const clean = judgeRun(onsets, restSpans(independent), START, BPM, both, taps(both));
    expect(clean.restJudgements[0]?.grade).toBe("perfect");
    // A right-hand tap inside the right hand's rest (beat 5.4) spoils it.
    const withStray = byTime([...both, { time: START + 5.4 * SPQ, zone: 1 }]);
    const spoiled = judgeRun(onsets, restSpans(independent), START, BPM, withStray, taps(withStray));
    expect(spoiled.restJudgements[0]?.grade).toBe("miss");
  });
});

describe("three against two", () => {
  const onsets = levelOnsets(polyrhythm);
  const rests = restSpans(polyrhythm);

  it("grades an exact 3:2 perfect in both hands, live and offline", () => {
    const hits = byTime([...play(onsets, 0), ...play(onsets, 1)]);
    const live = playLive(onsets, hits);
    expect(live.every((j) => j.judged.grade === "perfect" && onsets[j.judged.onsetIndex!]!.line === j.hit.zone)).toBe(true);
    const result = judgeRun(onsets, rests, START, BPM, hits, []);
    expect(result.judgements.every((j) => j.grade === "perfect")).toBe(true);
  });

  it("keeps the pulse when the triplet hand lands on a shared beat first", () => {
    // Beat 2 is reached by three triplets in the right hand and two quarters in the left: if
    // the right hand's onset sat a floating-point hair earlier, a right-then-left pair of taps
    // there used to read as an absurd tempo and wreck every later grade.
    const right = onsets.filter((o) => o.line === 1);
    const left = onsets.filter((o) => o.line === 0);
    expect(right.find((o) => Math.abs(o.beat - 4) < 1e-3)?.beat).toBe(4);
    const hits = byTime([...play(onsets, 0, 0, 0.004), ...play(onsets, 1)]);
    const live = playLive(onsets, hits);
    expect(live.every((j) => j.judged.grade === "perfect")).toBe(true);
    expect(left.length + right.length).toBe(live.length);
  });

  it("catches triplets flattened into eighths (the classic 3:2 mistake)", () => {
    // Right hand plays its triplet beats as an even "and" pattern: 0, 0.5, 1.5 instead of 0, 2/3, 4/3.
    const wrongBeats: Record<number, number> = { 0: 0, 1: 0.5, 2: 1.5 };
    const right = onsets.filter((o) => o.line === 1);
    const hits: Hit[] = [...play(onsets, 0)];
    right.forEach((o, i) => {
      const within = i % 3;
      const groupStart = o.beat - within * (2 / 3);
      const beat = i < 9 ? groupStart + (wrongBeats[within] ?? 0) : o.beat;
      hits.push({ time: START + beat * SPQ, zone: 1 });
    });
    const result = judgeRun(onsets, rests, START, BPM, byTime(hits), []);
    const middles = result.judgements.filter((j) => j.onset.line === 1 && Math.round(j.onset.beat * 3) % 6 !== 0 && j.onset.beat < 6);
    expect(middles.length).toBeGreaterThan(0);
    expect(middles.every((j) => j.grade !== "perfect")).toBe(true);
    // The steady left hand is unaffected.
    expect(result.judgements.filter((j) => j.onset.line === 0).every((j) => j.grade === "perfect")).toBe(true);
    expect(result.handAccuracy![1]).toBeLessThan(result.handAccuracy![0]);
  });
});

describe("generateTwoHandLevel", () => {
  it("combines every reading tier into every stage, and every result validates", () => {
    for (let stage = 1; stage <= TWO_HAND_STAGES.length; stage++) {
      for (let tier = 1; tier <= 11; tier++) {
        for (let seed = 1; seed <= 15; seed++) {
          const level = generateTwoHandLevel({ stage, tier, bars: 8, seed });
          expect(validateLevel(level), `stage ${stage} tier ${tier} seed ${seed}`).toEqual([]);
          expect(level.lines?.[0]?.length).toBe(8);
          expect(level.lines?.[1]?.length).toBe(8);
        }
      }
    }
  });

  it("makes valid two-line levels at every stage and length", () => {
    for (let stage = 1; stage <= TWO_HAND_STAGES.length; stage++) {
      for (const bars of [4, 8, 16] as const) {
        for (let seed = 1; seed <= 25; seed++) {
          const level = generateTwoHandLevel({ stage, bars, seed });
          expect(validateLevel(level)).toEqual([]);
          expect(level.lines).toHaveLength(2);
          expect(level.lines![0]).toHaveLength(bars);
          expect(level.lines![1]).toHaveLength(bars);
          expect(level.bars).toBe(level.lines![0]);
          const onsets = levelOnsets(level);
          expect(onsets.some((o) => o.line === 0)).toBe(true);
          expect(onsets.some((o) => o.line === 1)).toBe(true);
        }
      }
    }
  });

  it("stage 1 takes turns, stage 2 plays together, stage 4 has triplets", () => {
    const call = generateTwoHandLevel({ stage: 1, bars: 4, seed: 3 });
    call.lines![0]!.forEach((bar, i) => {
      const other = call.lines![1]![i]!;
      expect([bar, other].filter((b) => b.length === 1 && b[0]!.rest && b[0]!.value === "w")).toHaveLength(1);
    });
    const together = generateTwoHandLevel({ stage: 2, bars: 8, seed: 3 });
    expect(together.lines![0]).toEqual(together.lines![1]);
    const poly = generateTwoHandLevel({ stage: 4, bars: 8, seed: 3 });
    expect(poly.lines!.flat(2).some((e) => e.tuplet === 3)).toBe(true);
  });

  it("is deterministic for a seed", () => {
    expect(generateTwoHandLevel({ stage: 3, bars: 8, seed: 42 })).toEqual(generateTwoHandLevel({ stage: 3, bars: 8, seed: 42 }));
  });
});

import { describe, expect, it } from "vitest";
import type { Hit, Onset } from "../types";
import { createLiveJudge, judgeRun } from "./judge";
import { levelOnsets } from "./onsets";
import { LEVELS } from "./levels";

// Level 1 is 4 bars of plain quarters at 80 bpm: 16 onsets, one per quarter.
const level = LEVELS[0];
if (!level) throw new Error("expected LEVELS[0] to exist");
const onsets: Onset[] = levelOnsets(level);
const bpm = level.bpm;
const secPerQuarter = 60 / bpm;
const startTime = 10;

function hitsAtTempo(onsetList: Onset[], tempoScale: number): Hit[] {
  return onsetList.map((o) => ({ time: startTime + o.beat * secPerQuarter * tempoScale, zone: 0 }));
}

describe("judgeRun", () => {
  it("scores perfectly-timed, on-tempo playing near 100 accuracy and steadiness", () => {
    const hits = hitsAtTempo(onsets, 1);
    const result = judgeRun(onsets, startTime, bpm, hits);

    expect(result.accuracy).toBeGreaterThan(98);
    expect(result.steadiness).toBeGreaterThan(95);
    expect(result.playedBpm).toBeCloseTo(bpm, 0);
    expect(result.extraHits).toHaveLength(0);
    expect(result.judgements.every((j) => j.grade === "perfect")).toBe(true);
  });

  it("keeps accuracy high but drops steadiness for uniformly 5% slower, proportionally perfect playing", () => {
    const onTempo = judgeRun(onsets, startTime, bpm, hitsAtTempo(onsets, 1));
    const slower = judgeRun(onsets, startTime, bpm, hitsAtTempo(onsets, 1.05));

    // Proportions are still exactly right relative to the player's own (slower) pulse.
    expect(slower.accuracy).toBeGreaterThan(90);
    // But the tempo itself is off, and it's off consistently -> steadiness should suffer.
    expect(slower.steadiness).toBeLessThan(onTempo.steadiness);
    expect(slower.steadiness).toBeLessThan(90);
    expect(slower.playedBpm).toBeLessThan(bpm);

    // Strict (fixed-grid) error should grow across the run, unlike the relative error.
    const firstJudgement = slower.judgements[0];
    const lastJudgement = slower.judgements[slower.judgements.length - 1];
    expect(firstJudgement?.strictErrorMs).not.toBeNull();
    expect(lastJudgement?.strictErrorMs).not.toBeNull();
    expect(Math.abs(lastJudgement?.strictErrorMs ?? 0)).toBeGreaterThan(Math.abs(firstJudgement?.strictErrorMs ?? 0));
    expect(Math.abs(lastJudgement?.relativeErrorMs ?? 0)).toBeLessThan(20);
  });

  it("marks a missing hit as a miss and leaves other onsets unaffected", () => {
    const hits = hitsAtTempo(onsets, 1);
    hits.splice(5, 1); // drop the hit for onset index 5

    const result = judgeRun(onsets, startTime, bpm, hits);

    expect(result.judgements[5]?.grade).toBe("miss");
    expect(result.judgements[5]?.hitTime).toBeNull();
    expect(result.judgements.filter((j) => j.grade === "miss")).toHaveLength(1);
    expect(result.extraHits).toHaveLength(0);
  });

  it("penalizes an extra hit that matches no onset", () => {
    const clean = hitsAtTempo(onsets, 1);
    const withExtra: Hit[] = [...clean, { time: (clean[clean.length - 1]?.time ?? startTime) + 5, zone: 0 }];

    const cleanResult = judgeRun(onsets, startTime, bpm, clean);
    const extraResult = judgeRun(onsets, startTime, bpm, withExtra);

    expect(extraResult.extraHits).toHaveLength(1);
    expect(extraResult.accuracy).toBeLessThan(cleanResult.accuracy);
  });

  it("validates every shipped level", () => {
    for (const lvl of LEVELS) {
      const lvlOnsets = levelOnsets(lvl);
      expect(lvlOnsets.length).toBeGreaterThan(0);
    }
  });
});

describe("createLiveJudge", () => {
  it("grades a perfectly timed hit as perfect and reports the matched onset", () => {
    const judge = createLiveJudge(onsets, startTime, bpm);
    const firstOnset = onsets[0];
    if (!firstOnset) throw new Error("expected an onset");
    const result = judge.judgeHit({ time: startTime + firstOnset.beat * secPerQuarter, zone: 0 });

    expect(result.onsetIndex).toBe(0);
    expect(result.grade).toBe("perfect");
    expect(result.errorMs).not.toBeNull();
    expect(Math.abs(result.errorMs ?? 100)).toBeLessThan(35);
  });

  it("never lets a single onset be matched twice: a second hit at the same time finds nothing nearby", () => {
    const judge = createLiveJudge(onsets, startTime, bpm);
    const firstOnset = onsets[0];
    if (!firstOnset) throw new Error("expected an onset");
    const hitTime = startTime + firstOnset.beat * secPerQuarter;

    const first = judge.judgeHit({ time: hitTime, zone: 0 });
    const second = judge.judgeHit({ time: hitTime, zone: 0 });

    expect(first.onsetIndex).toBe(0);
    expect(second.onsetIndex).not.toBe(0);
    // The next onset is a full beat (750ms at 80bpm) away, far outside the match window.
    expect(second.onsetIndex).toBeNull();
    expect(second.grade).toBeNull();
  });

  it("tracks a slowly drifting pulse so later hits are still judged as on-time", () => {
    const judge = createLiveJudge(onsets, startTime, bpm);
    let lastResult: ReturnType<typeof judge.judgeHit> | null = null;
    for (const o of onsets) {
      lastResult = judge.judgeHit({ time: startTime + o.beat * secPerQuarter * 1.05, zone: 0 });
    }
    expect(lastResult?.onsetIndex).toBe(onsets.length - 1);
    expect(lastResult?.grade).not.toBeNull();
    expect(lastResult?.grade).not.toBe("miss");
  });
});

import { describe, expect, it } from "vitest";
import type { Hit, Level, Onset, Release, RestSpan } from "../types";
import { combineGrades, createLiveJudge, judgeRun } from "./judge";
import { LEVELS } from "./levels";
import { levelOnsets, restSpans } from "./onsets";

// Level 1 is 4 bars of plain quarters at 80 bpm: 16 onsets, one per quarter.
const level = LEVELS[0];
if (!level) throw new Error("expected LEVELS[0] to exist");
const onsets: Onset[] = levelOnsets(level);
const rests: RestSpan[] = restSpans(level);
const bpm = level.bpm;
const secPerQuarter = 60 / bpm;
const startTime = 10;

function hitsAtTempo(onsetList: Onset[], tempoScale: number): Hit[] {
  return onsetList.map((o) => ({ time: startTime + o.beat * secPerQuarter * tempoScale, zone: 0 }));
}

/** Presses each onset and releases it right at its predicted end (full written value held). */
function heldReleases(onsetList: Onset[], tempoScale: number): Release[] {
  return onsetList.map((o) => ({ time: startTime + (o.beat + o.quarters) * secPerQuarter * tempoScale, zone: 0 }));
}

describe("judgeRun", () => {
  it("scores perfectly-timed, fully-held playing near 100 accuracy and steadiness", () => {
    const hits = hitsAtTempo(onsets, 1);
    const releases = heldReleases(onsets, 1);
    const result = judgeRun(onsets, rests, startTime, bpm, hits, releases);

    expect(result.accuracy).toBeGreaterThan(98);
    expect(result.steadiness).toBeGreaterThan(95);
    expect(result.playedBpm).toBeCloseTo(bpm, 0);
    expect(result.extraHits).toHaveLength(0);
    expect(result.judgements.every((j) => j.grade === "perfect")).toBe(true);
    // Level 1 is plain quarters — none of them are "sustained" (longer than a quarter), so a
    // normal short tap on each gets no release grade at all (null, not "perfect").
    expect(result.judgements.every((j) => j.releaseGrade === null)).toBe(true);
  });

  it("keeps accuracy high but drops steadiness for uniformly 5% slower, proportionally perfect playing", () => {
    const onTempo = judgeRun(onsets, rests, startTime, bpm, hitsAtTempo(onsets, 1), heldReleases(onsets, 1));
    const slower = judgeRun(onsets, rests, startTime, bpm, hitsAtTempo(onsets, 1.05), heldReleases(onsets, 1.05));

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
    const releases = heldReleases(onsets, 1);
    releases.splice(5, 1);

    const result = judgeRun(onsets, rests, startTime, bpm, hits, releases);

    expect(result.judgements[5]?.grade).toBe("miss");
    expect(result.judgements[5]?.hitTime).toBeNull();
    expect(result.judgements.filter((j) => j.grade === "miss")).toHaveLength(1);
    expect(result.extraHits).toHaveLength(0);
  });

  it("penalizes an extra hit that matches no onset", () => {
    const clean = hitsAtTempo(onsets, 1);
    const withExtra: Hit[] = [...clean, { time: (clean[clean.length - 1]?.time ?? startTime) + 5, zone: 0 }];
    const releases = heldReleases(onsets, 1);

    const cleanResult = judgeRun(onsets, rests, startTime, bpm, clean, releases);
    const extraResult = judgeRun(onsets, rests, startTime, bpm, withExtra, releases);

    expect(extraResult.extraHits).toHaveLength(1);
    expect(extraResult.accuracy).toBeLessThan(cleanResult.accuracy);
  });

  it("scores a steady player with realistic phone jitter in the 90s", () => {
    // Deterministic pseudo-random jitter: ±~25 ms spread around a constant 30 ms lateness.
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const gaussian = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
    const hits = onsets.map((o) => ({ time: startTime + o.beat * secPerQuarter + 0.03 + 0.025 * gaussian(), zone: 0 as const }));
    const result = judgeRun(onsets, rests, startTime, bpm, hits, []);
    expect(result.accuracy).toBeGreaterThan(90);
    expect(result.judgements.filter((j) => j.grade === "miss")).toHaveLength(0);
  });

  describe("grid mode (practice, metronome running)", () => {
    it("does not forgive drifting: a player 6% slow ends up missing the later notes", () => {
      const pulse = judgeRun(onsets, rests, startTime, bpm, hitsAtTempo(onsets, 1.06), [], {});
      const grid = judgeRun(onsets, rests, startTime, bpm, hitsAtTempo(onsets, 1.06), [], { grid: true });
      expect(pulse.judgements.every((j) => j.grade !== "miss")).toBe(true);
      const last = grid.judgements[grid.judgements.length - 1];
      expect(last?.grade).toBe("miss");
      expect(grid.accuracy).toBeLessThan(pulse.accuracy);
    });

    it("tolerates a small constant offset (leftover calibration error)", () => {
      const hits = onsets.map((o) => ({ time: startTime + o.beat * secPerQuarter + 0.035, zone: 0 as const }));
      const result = judgeRun(onsets, rests, startTime, bpm, hits, [], { grid: true });
      expect(result.judgements.every((j) => j.grade === "perfect")).toBe(true);
    });

    it("lets a player who drifted jump back on: notes back on the click grade clean again", () => {
      const judge = createLiveJudge(onsets, startTime, bpm, { grid: true });
      const grades = onsets.map((o, i) => {
        // Notes 4-7 drift late by 40 ms per note; from note 8 on the player is back on the click.
        const drift = i >= 4 && i < 8 ? (i - 3) * 0.04 : 0;
        return judge.judgeHit({ time: startTime + o.beat * secPerQuarter + drift, zone: 0 }).grade;
      });
      expect(grades[7] === "miss" || grades[7] === "ok").toBe(true);
      expect(grades.slice(9).every((g) => g === "perfect")).toBe(true);
    });
  });

  it("validates every shipped level", () => {
    for (const lvl of LEVELS) {
      const lvlOnsets = levelOnsets(lvl);
      expect(lvlOnsets.length).toBeGreaterThan(0);
    }
  });

  it("gives a short, normal tap on a quarter note no release grade at all (it's not a hold miss)", () => {
    const hits = hitsAtTempo(onsets, 1);
    // Every note released ~80ms after its press — a normal quick tap, nowhere near its next
    // onset (which is a full quarter, 750ms, away).
    const releases: Release[] = hits.map((h) => ({ time: h.time + 0.08, zone: h.zone }));

    const result = judgeRun(onsets, rests, startTime, bpm, hits, releases);

    expect(result.judgements.every((j) => j.releaseGrade === null)).toBe(true);
    expect(result.accuracy).toBeGreaterThan(98);
  });

  it("widened onset windows: an 80ms-late tap still grades good, a 140ms-late tap still matches and grades ok", () => {
    // Judged on the second note: the first one has no pulse of the player's own yet, so it is
    // deliberately graded more leniently (see the next test).
    const second = onsets[1];
    if (!second) throw new Error("expected two onsets");
    const onTime = (beat: number) => startTime + beat * secPerQuarter;

    const judge = createLiveJudge(onsets, startTime, bpm);
    judge.judgeHit({ time: onTime(0), zone: 0 });
    const good = judge.judgeHit({ time: onTime(second.beat) + 0.08, zone: 0 });
    expect(good.grade).toBe("good");

    const judge2 = createLiveJudge(onsets, startTime, bpm);
    judge2.judgeHit({ time: onTime(0), zone: 0 });
    const ok = judge2.judgeHit({ time: onTime(second.beat) + 0.14, zone: 0 });
    expect(ok.grade).toBe("ok");
    expect(ok.onsetIndex).toBe(1); // still matched, not discarded as an unrelated extra hit
  });

  it("does not let a constant timing offset (calibration error) spoil the notes after the first", () => {
    const judge = createLiveJudge(onsets, startTime, bpm);
    const grades = onsets.map((o) => judge.judgeHit({ time: startTime + o.beat * secPerQuarter + 0.2, zone: 0 }).grade);
    expect(grades[0]).not.toBe("miss");
    expect(grades.slice(1).every((g) => g === "perfect")).toBe(true);
  });

  describe("holding note lengths", () => {
    // Level 2 ("quarters and halves") opens with two half notes: onset 0 at beat 0 (2 quarters
    // long), onset 1 at beat 2 (also 2 quarters long).
    const halvesLevel = LEVELS[1];
    if (!halvesLevel) throw new Error("expected LEVELS[1] to exist");
    const halvesOnsets = levelOnsets(halvesLevel);
    const halvesRests = restSpans(halvesLevel);
    const halvesSecPerQuarter = 60 / halvesLevel.bpm;

    it("releasing a half note after only one beat (half its length) drops accuracy and grades the hold a miss", () => {
      const hits = hitsAtTempo(halvesOnsets, 1);
      const fullyHeld = heldReleases(halvesOnsets, 1);
      // Release the first half note (2 quarters long) after just 1 quarter instead of 2.
      const releasedEarly = fullyHeld.map((r, i) => (i === 0 ? { ...r, time: startTime + 1 * halvesSecPerQuarter } : r));

      const fullResult = judgeRun(halvesOnsets, halvesRests, startTime, halvesLevel.bpm, hits, fullyHeld);
      const earlyResult = judgeRun(halvesOnsets, halvesRests, startTime, halvesLevel.bpm, hits, releasedEarly);

      expect(fullResult.judgements[0]?.releaseGrade).toBe("perfect");
      expect(earlyResult.judgements[0]?.releaseGrade).toBe("miss");
      expect(earlyResult.judgements[0]?.releaseErrorMs).not.toBeNull();
      expect(earlyResult.judgements[0]?.releaseErrorMs ?? 0).toBeLessThan(0); // released early -> negative
      expect(earlyResult.accuracy).toBeLessThan(fullResult.accuracy);
      // Onset (attack) timing is unaffected — only the hold/rest portion of the score should drop.
      expect(earlyResult.judgements[0]?.grade).toBe("perfect");
    });
  });

  describe("rests", () => {
    // Level 3 ("quarters with rests"): bar 2 is [q, rest(q), q, q] -> a quarter rest at beat 5
    // (after onset at beat 4), followed by an onset at beat 6.
    const restsLevel = LEVELS[2];
    if (!restsLevel) throw new Error("expected LEVELS[2] to exist");
    const restsOnsets = levelOnsets(restsLevel);
    const restsRestSpans = restSpans(restsLevel);
    const restsSecPerQuarter = 60 / restsLevel.bpm;

    it("marks a rest miss when the player taps during it", () => {
      const hits = hitsAtTempo(restsOnsets, 1);
      const releases = heldReleases(restsOnsets, 1);
      const firstRest = restsRestSpans[0];
      if (!firstRest) throw new Error("expected a rest");
      // A stray tap in the middle of the rest, far from any onset's match window.
      const strayTime = startTime + (firstRest.beat + firstRest.quarters / 2) * restsSecPerQuarter;
      const hitsWithStray: Hit[] = [...hits, { time: strayTime, zone: 1 }];

      const result = judgeRun(restsOnsets, restsRestSpans, startTime, restsLevel.bpm, hitsWithStray, releases);
      const restJudgement = result.restJudgements.find((r) => r.eventIndex === firstRest.eventIndex);

      expect(restJudgement?.grade).toBe("miss");
      expect(restJudgement?.reason).toBe("you tapped during it");
    });

    it("marks a rest clean when nothing is pressed during it and the previous note was released cleanly", () => {
      const hits = hitsAtTempo(restsOnsets, 1);
      const releases = heldReleases(restsOnsets, 1);
      const firstRest = restsRestSpans[0];
      if (!firstRest) throw new Error("expected a rest");

      const result = judgeRun(restsOnsets, restsRestSpans, startTime, restsLevel.bpm, hits, releases);
      const restJudgement = result.restJudgements.find((r) => r.eventIndex === firstRest.eventIndex);

      expect(restJudgement?.grade).toBe("perfect");
    });

    it("marks a rest miss when the previous note (even a plain quarter) is held well into it (past 30% of its length), but not for a small overhang", () => {
      const hits = hitsAtTempo(restsOnsets, 1);
      const firstRest = restsRestSpans[0];
      if (!firstRest) throw new Error("expected a rest");
      const restStartTime = startTime + firstRest.beat * restsSecPerQuarter;

      const releasesHeldThrough = heldReleases(restsOnsets, 1).map((r, i) => (restsOnsets[i]?.eventIndex === firstRest.eventIndex - 1 ? { ...r, time: restStartTime + 0.3 } : r));
      const heldThroughResult = judgeRun(restsOnsets, restsRestSpans, startTime, restsLevel.bpm, hits, releasesHeldThrough);
      const heldThroughRest = heldThroughResult.restJudgements.find((r) => r.eventIndex === firstRest.eventIndex);
      expect(heldThroughRest?.grade).toBe("miss");
      expect(heldThroughRest?.reason).toBe("held through it");

      // The note itself is a plain quarter (not sustained), so its own hold is never graded —
      // only the rest is affected by how late it was actually let go.
      const noteIndex = restsOnsets.findIndex((o) => o.eventIndex === firstRest.eventIndex - 1);
      expect(heldThroughResult.judgements[noteIndex]?.releaseGrade).toBeNull();

      const releasesSmallOverhang = heldReleases(restsOnsets, 1).map((r, i) => (restsOnsets[i]?.eventIndex === firstRest.eventIndex - 1 ? { ...r, time: restStartTime + 0.05 } : r));
      const smallOverhangResult = judgeRun(restsOnsets, restsRestSpans, startTime, restsLevel.bpm, hits, releasesSmallOverhang);
      const smallOverhangRest = smallOverhangResult.restJudgements.find((r) => r.eventIndex === firstRest.eventIndex);
      expect(smallOverhangRest?.grade).toBe("perfect");
    });
  });

  describe("tied notes", () => {
    it("sums a tied chain's length onto its onset, and holds it across the tie", () => {
      const tiedLevel: Level = {
        id: "t",
        title: "t",
        meter: { beats: 4, beatUnit: 4 },
        bpm: 80,
        bars: [[{ value: "h", dots: 0, rest: false, tie: true }, { value: "h", dots: 0, rest: false }, { value: "q", dots: 0, rest: false }, { value: "q", dots: 0, rest: false }]],
      };
      const tiedOnsets = levelOnsets(tiedLevel);
      const tiedRests = restSpans(tiedLevel);
      const tiedSecPerQuarter = 60 / tiedLevel.bpm;

      // Only 3 onsets: the tied half+half is one 4-quarter-long note, plus the two quarters.
      expect(tiedOnsets).toHaveLength(3);
      expect(tiedOnsets[0]?.quarters).toBe(4);

      const hits: Hit[] = tiedOnsets.map((o) => ({ time: startTime + o.beat * tiedSecPerQuarter, zone: 0 }));
      const releases: Release[] = tiedOnsets.map((o) => ({ time: startTime + (o.beat + o.quarters) * tiedSecPerQuarter, zone: 0 }));

      const result = judgeRun(tiedOnsets, tiedRests, startTime, tiedLevel.bpm, hits, releases);
      expect(result.judgements[0]?.releaseGrade).toBe("perfect");
    });
  });
});

describe("combineGrades", () => {
  it("returns the worse of the two grades", () => {
    expect(combineGrades("perfect", "ok")).toBe("ok");
    expect(combineGrades("miss", "perfect")).toBe("miss");
    expect(combineGrades("good", null)).toBe("good");
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

  it("grades a hold released right at the predicted end as perfect, and one released far too early as a miss", () => {
    const halvesLevel = LEVELS[1];
    if (!halvesLevel) throw new Error("expected LEVELS[1] to exist");
    const halvesOnsets = levelOnsets(halvesLevel);
    const halvesSecPerQuarter = 60 / halvesLevel.bpm;
    const firstOnset = halvesOnsets[0];
    if (!firstOnset) throw new Error("expected an onset");

    const judge = createLiveJudge(halvesOnsets, startTime, halvesLevel.bpm);
    judge.judgeHit({ time: startTime + firstOnset.beat * halvesSecPerQuarter, zone: 0 });
    const held = judge.judgeRelease({ time: startTime + (firstOnset.beat + firstOnset.quarters) * halvesSecPerQuarter, zone: 0 });
    expect(held.releaseGrade).toBe("perfect");
    expect(held.combinedGrade).toBe("perfect");

    const judge2 = createLiveJudge(halvesOnsets, startTime, halvesLevel.bpm);
    judge2.judgeHit({ time: startTime + firstOnset.beat * halvesSecPerQuarter, zone: 0 });
    const releasedEarly = judge2.judgeRelease({ time: startTime + (firstOnset.beat + 0.5) * halvesSecPerQuarter, zone: 0 });
    expect(releasedEarly.releaseGrade).toBe("miss");
  });

  it("treats an unreleased held sustained note as implicitly released by the next press in the same zone", () => {
    // Level 2 opens with two half notes (sustained: quarters > 1), so their release is graded.
    const halvesLevel = LEVELS[1];
    if (!halvesLevel) throw new Error("expected LEVELS[1] to exist");
    const halvesOnsets = levelOnsets(halvesLevel);
    const halvesSecPerQuarter = 60 / halvesLevel.bpm;
    const firstOnset = halvesOnsets[0];
    const secondOnset = halvesOnsets[1];
    if (!firstOnset || !secondOnset) throw new Error("expected two onsets");

    const judge = createLiveJudge(halvesOnsets, startTime, halvesLevel.bpm);
    judge.judgeHit({ time: startTime + firstOnset.beat * halvesSecPerQuarter, zone: 0 });
    // No explicit release for onset 0 — a new press in the same zone implicitly releases it.
    const implicit = judge.implicitRelease(0, startTime + secondOnset.beat * halvesSecPerQuarter);

    expect(implicit.onsetIndex).toBe(0);
    expect(implicit.releaseGrade).not.toBeNull();
  });
});

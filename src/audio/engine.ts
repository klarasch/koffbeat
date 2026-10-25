// Web Audio synthesized click/tap engine. Everything that has to be on-beat is scheduled
// against the AudioContext clock (ctx.currentTime), never against wall-clock timers: timers
// are subject to tab throttling and jank, and would ruin timing precision, which is the whole
// point of this app.

/** Public surface of the audio engine, used by input handling and the run/practice screens. */
export interface AudioEngine {
  ctx: AudioContext;
  /**
   * Resumes the (possibly suspended) AudioContext and plays a silent buffer.
   * Must be invoked synchronously from a user gesture (tap/click/keydown): iOS Safari keeps
   * a freshly-created AudioContext (and even a resumed one) silent until a sound has actually
   * been triggered inside a gesture handler, so this "primes" the context for every sound that
   * follows, including ones scheduled slightly in the future.
   */
  unlock(): Promise<void>;
  /** Current audio clock time, in seconds. */
  now(): number;
  /** Schedules one synthesized woodblock-like click at an exact audio time. */
  scheduleClick(time: number, accent: boolean): void;
  /**
   * Schedules one bar (beatsPerBar clicks) of count-in ending exactly at startTime (i.e. the
   * last click of the bar lands one beat before startTime, and startTime itself is beat 1 of
   * the run). Returns the audio time of the first scheduled click.
   */
  scheduleCountIn(startTime: number, beatsPerBar: number, secondsPerBeat: number): number;
  /** Starts a look-ahead-scheduled metronome for `bars` bars starting at startTime. */
  startMetronome(startTime: number, secondsPerBeat: number, beatsPerBar: number, bars: number): void;
  /** Cancels every pending scheduled sound (metronome ticks and clicks) and stops the scheduler. */
  stopAll(): void;
  /** Plays an immediate, low-latency tactile tap sound for player input feedback. */
  playHit(zone: 0 | 1): void;
  /**
   * Fades the ambient drone to `level` (0 = silent, 1 = full). It has no rhythm of its own, so
   * it can sit under the clicks without pulling the player's timing. Not affected by stopAll.
   */
  setAmbience(level: number, rampSec?: number): void;
  /** A soft, slow-blooming chord for the end of a run; brighter for higher `quality` (0..1). */
  chime(quality: number): void;
}

/** How far ahead of "now" the look-ahead scheduler schedules audio nodes, in seconds. */
const SCHEDULE_AHEAD_SEC = 0.1;
/** How often the look-ahead scheduler wakes up to top up scheduled nodes, in milliseconds. */
const TICK_INTERVAL_MS = 25;

/** Creates the audio engine. Cheap to call; only one instance should exist per page. */
export function createAudioEngine(): AudioEngine {
  const ctx = new AudioContext();

  const master = ctx.createGain();
  master.gain.value = 0.9;

  // A light compressor keeps the synthesized clicks/taps pleasant even when several land
  // close together (e.g. accent + a fast subdivision), instead of clipping or sounding harsh.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;

  master.connect(compressor);
  compressor.connect(ctx.destination);

  /** Every node created by scheduleClick/startMetronome, so stopAll can cancel them. */
  const activeNodes = new Set<AudioScheduledSourceNode>();

  let metronomeTimer: ReturnType<typeof setInterval> | null = null;

  function now(): number {
    return ctx.currentTime;
  }

  async function unlock(): Promise<void> {
    // iOS mutes Web Audio when the ringer switch is on silent, unless the page declares itself
    // a playback session (Safari 17+). Rhythm training is useless without the clicks.
    const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (audioSession) audioSession.type = "playback";
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    // Play an inaudible buffer synchronously within the gesture to fully wake the iOS audio
    // hardware path; a resume() alone is sometimes not enough on older iOS Safari versions.
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.start(0);
  }

  function trackNode(node: AudioScheduledSourceNode): void {
    activeNodes.add(node);
    node.addEventListener("ended", () => activeNodes.delete(node));
  }

  /** Short filtered noise burst + tone, pitched higher on accent, for the click/metronome sound. */
  function scheduleClick(time: number, accent: boolean): void {
    const duration = 0.05;
    const noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = accent ? 2400 : 1500;
    bandpass.Q.value = 6;

    const tone = ctx.createOscillator();
    tone.type = "sine";
    tone.frequency.value = accent ? 1600 : 1000;

    const noiseGain = ctx.createGain();
    const toneGain = ctx.createGain();
    const clickGain = ctx.createGain();

    noiseGain.gain.value = 0.7;
    toneGain.gain.value = 0.35;

    // Percussive envelope: fast attack, quick exponential-ish decay.
    const peak = accent ? 0.9 : 0.6;
    clickGain.gain.setValueAtTime(0, time);
    clickGain.gain.linearRampToValueAtTime(peak, time + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    tone.connect(toneGain);
    noiseGain.connect(clickGain);
    toneGain.connect(clickGain);
    clickGain.connect(master);

    noise.start(time);
    noise.stop(time + duration);
    tone.start(time);
    tone.stop(time + duration);

    trackNode(noise);
    trackNode(tone);
  }

  function scheduleCountIn(startTime: number, beatsPerBar: number, secondsPerBeat: number): number {
    const firstClickTime = startTime - beatsPerBar * secondsPerBeat;
    for (let beat = 0; beat < beatsPerBar; beat++) {
      scheduleClick(firstClickTime + beat * secondsPerBeat, beat === 0);
    }
    return firstClickTime;
  }

  function startMetronome(startTime: number, secondsPerBeat: number, beatsPerBar: number, bars: number): void {
    stopMetronomeTimer();

    const totalBeats = beatsPerBar * bars;
    let nextBeatIndex = 0;
    let nextBeatTime = startTime;

    function scheduler(): void {
      const horizon = ctx.currentTime + SCHEDULE_AHEAD_SEC;
      while (nextBeatIndex < totalBeats && nextBeatTime < horizon) {
        const isAccent = nextBeatIndex % beatsPerBar === 0;
        scheduleClick(nextBeatTime, isAccent);
        nextBeatIndex++;
        nextBeatTime += secondsPerBeat;
      }
      if (nextBeatIndex >= totalBeats) {
        stopMetronomeTimer();
      }
    }

    scheduler();
    metronomeTimer = setInterval(scheduler, TICK_INTERVAL_MS);
  }

  function stopMetronomeTimer(): void {
    if (metronomeTimer !== null) {
      clearInterval(metronomeTimer);
      metronomeTimer = null;
    }
  }

  function stopAll(): void {
    stopMetronomeTimer();
    for (const node of activeNodes) {
      try {
        node.stop();
      } catch {
        // Already stopped/ended; ignore.
      }
    }
    activeNodes.clear();
  }

  /** Soft immediate tactile tap, distinct timbre per zone, for player-triggered feedback. */
  function playHit(zone: 0 | 1): void {
    const time = ctx.currentTime;
    const duration = 0.08;

    const osc = ctx.createOscillator();
    osc.type = zone === 0 ? "triangle" : "sine";
    osc.frequency.value = zone === 0 ? 320 : 480;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.5, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(gain);
    gain.connect(master);

    osc.start(time);
    osc.stop(time + duration);
    trackNode(osc);
  }

  // ---- Ambience: a slowly breathing Dmaj9 drone, routed around the compressor so the clicks
  // never make it pump. Built lazily on first use (the context may still be suspended at load).
  let ambienceGain: GainNode | null = null;

  function buildAmbience(): GainNode {
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 650;
    filter.Q.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 320;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.frequency);
    lfo.start();

    const voices: [number, OscillatorType, number][] = [
      [73.42, "sine", 0.32],
      [110.0, "triangle", 0.16],
      [146.83, "sine", 0.14],
      [164.81, "triangle", 0.07],
      [185.0, "sine", 0.08],
      [329.63, "sine", 0.035],
    ];
    for (const [freq, type, gain] of voices) {
      for (const detune of [-6, 5]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = gain;
        // Each voice swells on its own slow cycle, so the chord keeps shifting colour.
        const swell = ctx.createOscillator();
        swell.frequency.value = 0.02 + Math.random() * 0.05;
        const swellDepth = ctx.createGain();
        swellDepth.gain.value = gain * 0.6;
        swell.connect(swellDepth);
        swellDepth.connect(g.gain);
        swell.start();
        osc.connect(g);
        g.connect(filter);
        osc.start();
      }
    }
    filter.connect(out);
    out.connect(ctx.destination);
    return out;
  }

  function setAmbience(level: number, rampSec = 2.5): void {
    if (!ambienceGain) {
      if (level <= 0) return;
      ambienceGain = buildAmbience();
    }
    const t = ctx.currentTime;
    const g = ambienceGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0, Math.min(1, level)) * 0.16, t + Math.max(0.05, rampSec));
  }

  function chime(quality: number): void {
    const t = ctx.currentTime + 0.05;
    const q = Math.max(0, Math.min(1, quality));
    // D major add9, opened upward with quality.
    const partials = [293.66, 440, 587.33, 659.25, 880, 1174.66].slice(0, 3 + Math.round(q * 3));
    partials.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      const start = t + i * 0.09;
      const peak = 0.05 / (1 + i * 0.35);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0005, start + 4.5);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 4.6);
    });
  }

  return { ctx, unlock, now, scheduleClick, scheduleCountIn, startMetronome, stopAll, playHit, setAmbience, chime };
}

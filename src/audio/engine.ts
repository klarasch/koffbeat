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
  /** A soft resonant-plate chord for the end of a run; fuller for higher `quality` (0..1). */
  chime(quality: number): void;
  /** Starts a sustained resonant-plate tone now; returns an id for noteOff. */
  noteOn(freq: number, velocity?: number): number;
  /** Releases a note started with noteOn (a short natural fade). */
  noteOff(id: number): void;
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

  // ---- Ambience: a soft drone that drifts between four related chords, with each voice, the
  // filter and the overall level wandering on their own slow, irregular cycles, so it breathes
  // instead of droning. Routed around the compressor so the clicks never make it pump. Built
  // lazily on first use (the context may still be suspended at load).
  const CHORDS: number[][] = [
    [73.42, 110.0, 185.0, 220.0, 277.18, 329.63], // Dmaj9
    [61.74, 92.5, 146.83, 164.81, 220.0, 277.18], // Bm11
    [49.0, 73.42, 123.47, 185.0, 220.0, 277.18], // Gmaj9#11
    [82.41, 123.47, 185.0, 196.0, 220.0, 293.66], // Em9
  ];
  const VOICE_GAINS = [0.28, 0.15, 0.1, 0.07, 0.06, 0.035];
  let ambienceGain: GainNode | null = null;
  let ambienceTimer: ReturnType<typeof setTimeout> | null = null;

  function buildAmbience(): GainNode {
    const out = ctx.createGain();
    out.gain.value = 0;
    const breath = ctx.createGain();
    breath.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    filter.Q.value = 0.6;

    const oscillators: OscillatorNode[][] = [];
    const voiceGains: GainNode[] = [];
    CHORDS[0]!.forEach((freq, v) => {
      const g = ctx.createGain();
      g.gain.value = VOICE_GAINS[v] ?? 0.05;
      const pair: OscillatorNode[] = [];
      for (const detune of [-7, 6]) {
        const osc = ctx.createOscillator();
        osc.type = v === 0 || v === 2 ? "sine" : "triangle";
        osc.frequency.value = freq;
        osc.detune.value = detune + (Math.random() - 0.5) * 4;
        osc.connect(g);
        osc.start();
        pair.push(osc);
      }
      g.connect(filter);
      oscillators.push(pair);
      voiceGains.push(g);
    });
    filter.connect(breath);
    breath.connect(out);
    out.connect(ctx.destination);

    let chord = 0;
    // Every 9–20 s: glide some voices to the next chord, re-balance the voices, move the filter
    // and let the whole drone breathe in or out a little. Nothing lands on a regular grid.
    const wander = () => {
      const t = ctx.currentTime;
      if (Math.random() < 0.55) chord = (chord + 1 + Math.floor(Math.random() * 2)) % CHORDS.length;
      const freqs = CHORDS[chord]!;
      oscillators.forEach((pair, v) => {
        const target = freqs[v] ?? freqs[0]!;
        const glide = 3 + Math.random() * 5;
        for (const osc of pair) osc.frequency.setTargetAtTime(target, t + Math.random() * 2, glide / 3);
      });
      voiceGains.forEach((g, v) => {
        const base = VOICE_GAINS[v] ?? 0.05;
        g.gain.setTargetAtTime(base * (0.35 + Math.random() * 1.0), t, 2 + Math.random() * 4);
      });
      filter.frequency.setTargetAtTime(380 + Math.random() * 900, t, 3 + Math.random() * 5);
      breath.gain.setTargetAtTime(0.6 + Math.random() * 0.5, t, 4 + Math.random() * 4);
      ambienceTimer = setTimeout(wander, 9000 + Math.random() * 11000);
    };
    ambienceTimer = setTimeout(wander, 4000);
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
  void ambienceTimer;

  function chime(quality: number): void {
    const t = ctx.currentTime + 0.05;
    const q = Math.max(0, Math.min(1, quality));
    // D major add9, opened upward with quality, struck softly on the plate.
    const partials = [293.66, 440, 587.33, 659.25, 880, 1174.66].slice(0, 3 + Math.round(q * 3));
    partials.forEach((freq, i) => {
      const id = startPlate(freq, 0.5 / (1 + i * 0.3), t + i * 0.11);
      setTimeout(() => noteOff(id), 1800 + i * 110);
    });
  }

  // ---- Resonant plate for taps: a soft mallet on a metal plate, the instrument the scene
  // shows. Its partials are inharmonic (roughly a struck plate's mode ratios), each doubled
  // with a slight detune so it shimmers. It sustains while the key or finger is down, then
  // rings out naturally when released.
  interface PlateVoice {
    out: GainNode;
    oscillators: OscillatorNode[];
  }
  const voices = new Map<number, PlateVoice>();
  let nextVoiceId = 1;
  const plateBus = ctx.createGain();
  plateBus.gain.value = 0.9;
  const plateTone = ctx.createBiquadFilter();
  plateTone.type = "lowpass";
  plateTone.frequency.value = 2600;
  plateTone.Q.value = 0.4;
  plateBus.connect(plateTone);
  plateTone.connect(master);

  /** Partial ratios and relative levels: a fundamental, then the plate's higher modes. */
  const PLATE_PARTIALS: [number, number][] = [
    [1, 1],
    [2.32, 0.42],
    [4.25, 0.2],
    [6.63, 0.09],
  ];

  function startPlate(freq: number, velocity: number, when: number): number {
    const t = Math.max(when, ctx.currentTime);
    const v = Math.max(0.05, Math.min(1, velocity));
    const out = ctx.createGain();
    // A soft mallet: a quick but rounded attack, then a slow bloom-and-settle while held.
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.2 * v, t + 0.012);
    out.gain.exponentialRampToValueAtTime(0.11 * v, t + 0.5);
    out.gain.exponentialRampToValueAtTime(0.07 * v, t + 5);
    out.connect(plateBus);

    const oscillators: OscillatorNode[] = [];
    for (const [ratio, level] of PLATE_PARTIALS) {
      // Higher partials die away faster, as on a real plate.
      const partial = ctx.createGain();
      partial.gain.setValueAtTime(level, t);
      partial.gain.exponentialRampToValueAtTime(Math.max(0.0005, level * 0.15), t + 0.4 + 3 / ratio);
      partial.connect(out);
      for (const detune of [-3, 4]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq * ratio;
        osc.detune.value = detune * ratio;
        osc.connect(partial);
        oscillators.push(osc);
      }
    }
    // The mallet's touch: a brief, soft burst of filtered noise.
    const noise = ctx.createBufferSource();
    const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.03), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = freq * 3;
    noiseFilter.Q.value = 1.2;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05 * v;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(t);

    for (const osc of oscillators) osc.start(t);
    const id = nextVoiceId++;
    voices.set(id, { out, oscillators });
    // Safety: no note rings forever if its release never arrives.
    setTimeout(() => noteOff(id), 12000);
    return id;
  }

  function noteOn(freq: number, velocity = 0.8): number {
    return startPlate(freq, velocity, ctx.currentTime);
  }

  function noteOff(id: number): void {
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    const t = ctx.currentTime;
    const g = voice.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    g.exponentialRampToValueAtTime(0.0001, t + 0.9);
    for (const osc of voice.oscillators) {
      try {
        osc.stop(t + 1);
      } catch {
        // Already stopped.
      }
    }
  }

  return { ctx, unlock, now, scheduleClick, scheduleCountIn, startMetronome, stopAll, playHit, setAmbience, chime, noteOn, noteOff };
}

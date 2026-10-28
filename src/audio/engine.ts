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
  /** `soft`: a quieter in-between click (the 2nd, 3rd, 5th and 6th eighths of 6/8). */
  scheduleClick(time: number, accent: boolean, soft?: boolean): void;
  /**
   * Schedules one bar (beatsPerBar clicks) of count-in ending exactly at startTime (i.e. the
   * last click of the bar lands one beat before startTime, and startTime itself is beat 1 of
   * the run). Returns the audio time of the first scheduled click.
   */
  scheduleCountIn(startTime: number, beatsPerBar: number, secondsPerBeat: number, group?: number): number;
  /**
   * Starts a look-ahead-scheduled metronome for `bars` bars starting at startTime. With `group`
   * above 1 (3 in 6/8) only every group-th click is full; the ones between are softer.
   */
  startMetronome(startTime: number, secondsPerBeat: number, beatsPerBar: number, bars: number, group?: number): void;
  /** Cancels every pending scheduled sound (metronome ticks and clicks) and stops the scheduler. */
  stopAll(): void;
  /** Plays an immediate, low-latency tactile tap sound for player input feedback. */
  playHit(zone: 0 | 1): void;
  /**
   * Fades the ambient drone to `level` (0 = silent, 1 = full). It has no rhythm of its own, so
   * it can sit under the clicks without pulling the player's timing. Not affected by stopAll.
   */
  setAmbience(level: number, rampSec?: number): void;
  /** A soft felt-piano chord for the end of a run; fuller for higher `quality` (0..1). */
  chime(quality: number): void;
  /** Starts a sustained felt-piano tone now (or at `when`); returns an id for noteOff. */
  noteOn(freq: number, velocity?: number): number;
  /** Releases a note started with noteOn (a short natural fade). */
  noteOff(id: number): void;
  /**
   * Schedules a whole felt-piano note at an exact audio time and length (for playing an
   * exercise back). Cancelled by stopAll, like the metronome.
   */
  scheduleNote(freq: number, velocity: number, when: number, duration: number): void;
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
  function scheduleClick(time: number, accent: boolean, soft = false): void {
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
    const peak = accent ? 0.9 : soft ? 0.3 : 0.6;
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

  /** A bar's click pattern: the downbeat accented, and in grouped meters the in-between clicks soft. */
  function clickAt(time: number, index: number, beatsPerBar: number, group: number): void {
    const inBar = index % beatsPerBar;
    scheduleClick(time, inBar === 0, group > 1 && inBar % group !== 0);
  }

  function scheduleCountIn(startTime: number, beatsPerBar: number, secondsPerBeat: number, group = 1): number {
    const firstClickTime = startTime - beatsPerBar * secondsPerBeat;
    for (let beat = 0; beat < beatsPerBar; beat++) {
      clickAt(firstClickTime + beat * secondsPerBeat, beat, beatsPerBar, group);
    }
    return firstClickTime;
  }

  function startMetronome(startTime: number, secondsPerBeat: number, beatsPerBar: number, bars: number, group = 1): void {
    stopMetronomeTimer();

    const totalBeats = beatsPerBar * bars;
    let nextBeatIndex = 0;
    let nextBeatTime = startTime;

    function scheduler(): void {
      const horizon = ctx.currentTime + SCHEDULE_AHEAD_SEC;
      while (nextBeatIndex < totalBeats && nextBeatTime < horizon) {
        clickAt(nextBeatTime, nextBeatIndex, beatsPerBar, group);
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
    // D major add9, opened upward with quality, played softly.
    const partials = [293.66, 440, 587.33, 659.25, 880, 1174.66].slice(0, 3 + Math.round(q * 3));
    partials.forEach((freq, i) => {
      const id = startTone(freq, 0.5 / (1 + i * 0.3), t + i * 0.11);
      setTimeout(() => noteOff(id), 1800 + i * 110);
    });
  }

  // ---- Felt piano for taps: a muted upright, the hammer wrapped in felt. A warm, low-passed
  // tone (triangle fundamental plus two quickly fading harmonics, each doubled with a slight
  // detune) with a soft thump of hammer. It sustains gently while the key or finger is down,
  // so a long note sounds long, and is damped like a piano key when released.
  interface TapVoice {
    out: GainNode;
    oscillators: OscillatorNode[];
  }
  const voices = new Map<number, TapVoice>();
  let nextVoiceId = 1;
  const tapBus = ctx.createGain();
  tapBus.gain.value = 0.95;
  const feltTone = ctx.createBiquadFilter();
  feltTone.type = "lowpass";
  feltTone.frequency.value = 1500;
  feltTone.Q.value = 0.3;
  tapBus.connect(feltTone);
  feltTone.connect(master);

  /** The damper when a note ends: a quick fade (time constant), and when it is silent. */
  const RELEASE_TAU = 0.06;
  const RELEASE_SEC = 0.45;

  /** Partials: [ratio, level, wave, seconds to fade to a whisper]. */
  const FELT_PARTIALS: [number, number, OscillatorType, number][] = [
    [1, 0.8, "triangle", 6],
    [2, 0.3, "sine", 1.2],
    [3, 0.1, "sine", 0.6],
  ];

  /**
   * Starts a felt-piano tone at `when`. With `end`, the whole note is booked at once: it settles
   * like a held key and is damped at `end` (the same release as noteOff), so it sounds exactly
   * as long as a tap held for that time.
   */
  function startTone(freq: number, velocity: number, when: number, end?: number): number {
    const t = Math.max(when, ctx.currentTime);
    const v = Math.max(0.05, Math.min(1, velocity));
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.26 * v, t + 0.012);
    if (end === undefined) {
      out.gain.exponentialRampToValueAtTime(0.12 * v, t + 0.6);
      out.gain.exponentialRampToValueAtTime(0.07 * v, t + 4);
    } else {
      // Only target curves here: a ramp booked after the damper would win over it and keep
      // the note ringing past its end.
      out.gain.setTargetAtTime(0.12 * v, t + 0.012, 0.2);
      out.gain.setTargetAtTime(0.0001, Math.max(end, t + 0.05), RELEASE_TAU);
    }
    out.connect(tapBus);

    const oscillators: OscillatorNode[] = [];
    for (const [ratio, level, wave, fade] of FELT_PARTIALS) {
      const partial = ctx.createGain();
      partial.gain.setValueAtTime(level, t);
      partial.gain.exponentialRampToValueAtTime(Math.max(0.0005, level * 0.05), t + fade);
      partial.connect(out);
      for (const detune of [-2, 3]) {
        const osc = ctx.createOscillator();
        osc.type = wave;
        osc.frequency.value = freq * ratio;
        osc.detune.value = detune;
        osc.connect(partial);
        oscillators.push(osc);
      }
    }
    // The felt hammer: a very short, soft, low thump.
    const noise = ctx.createBufferSource();
    const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.025), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    noise.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 700;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.08 * v;
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

  function scheduleNote(freq: number, velocity: number, when: number, duration: number): void {
    const end = Math.max(when + 0.05, when + duration);
    const id = startTone(freq, velocity, when, end);
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    for (const osc of voice.oscillators) {
      osc.stop(end + RELEASE_SEC);
      trackNode(osc);
    }
  }

  function noteOn(freq: number, velocity = 0.8): number {
    return startTone(freq, velocity, ctx.currentTime);
  }

  function noteOff(id: number): void {
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    const t = ctx.currentTime;
    const g = voice.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    // A piano damper: quick, but not a click.
    g.setTargetAtTime(0.0001, t, RELEASE_TAU);
    for (const osc of voice.oscillators) {
      try {
        osc.stop(t + RELEASE_SEC);
      } catch {
        // Already stopped.
      }
    }
  }

  return { ctx, unlock, now, scheduleClick, scheduleCountIn, startMetronome, stopAll, playHit, setAmbience, chime, noteOn, noteOff, scheduleNote };
}

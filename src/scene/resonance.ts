// The Resonance scene: a dark glass plate covered in glowing sand, drawn with raw WebGL2 behind
// the whole app. Playing excites the plate. Particles on vibrating parts (antinodes) get kicked
// around and drift toward the still lines (nodes), so steady, accurate playing settles the sand
// into a clean Chladni figure, while misses mix in a second, competing mode and blur it.
//
// The physics runs on the CPU (a few thousand particles; cheap thanks to a cosine recurrence),
// the rendering on the GPU: a background shader (nebula, glass plate, ripples, hold ring, glow)
// plus two particle passes (a sharp one and a blurred low-res one that becomes the glow).

import type { Grade } from "../types";

export type StrikeKind = Grade | "neutral";
export type HoldState = "filling" | "ready" | "over";

export interface Scene {
  /** Where the plate sits, in viewport CSS px. The plate glides there smoothly. */
  setPlate(cx: number, cy: number, radius: number): void;
  /** Which Chladni figure the sand is drawn toward (any integer; wraps around the mode list). */
  setFigure(index: number): void;
  /** A tap landed: ripple at the tap point (or the plate centre) and an energy kick. */
  strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null): void;
  /** A held note in progress (0..1 of its written length), or null when nothing is held. */
  setHold(hold: { progress: number; state: HoldState } | null): void;
  /** 0..1: how clean the playing has been so far. Low coherence blurs the figure. */
  setCoherence(value: number): void;
  /** Background energy that keeps the sand gently moving (the home screen's idle state). */
  setAmbient(level: number): void;
  /** 0..1: how much the plate recedes behind UI (home screen text sits on top of it). */
  setDim(value: number): void;
  /** Scatter the sand evenly, ready for a new piece. */
  scatter(): void;
  /** End of a run: the figure settles and glows. `quality` is 0..1. */
  reveal(quality: number): void;
  /** Clear the reveal glow and any hold ring. */
  reset(): void;
  readonly supported: boolean;
}

/** Chladni modes (n, m, sign) for f = cos(nπx)cos(mπy) + s·cos(mπx)cos(nπy), in plate coordinates [-1, 1]. */
const MODES: [number, number, number][] = [
  [1, 3, -1],
  [2, 3, 1],
  [1, 4, -1],
  [3, 4, -1],
  [2, 5, 1],
  [1, 5, -1],
  [3, 5, 1],
  [4, 5, -1],
  [2, 7, -1],
  [3, 7, 1],
  [5, 6, -1],
  [1, 7, 1],
];
const MAX_K = 8;

const GRADE_RGB: Record<StrikeKind, [number, number, number]> = {
  perfect: [0.5, 0.95, 0.82],
  good: [0.66, 0.9, 0.48],
  ok: [0.95, 0.78, 0.38],
  miss: [0.95, 0.42, 0.48],
  neutral: [0.7, 0.85, 1.0],
};
const STRIKE_ENERGY: Record<StrikeKind, number> = { perfect: 0.75, good: 0.6, ok: 0.45, miss: 0.5, neutral: 0.45 };

const MAX_RIPPLES = 8;

const BG_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BG_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uPlate;      // centre x, y (device px, origin bottom-left), radius
uniform float uEnergy;
uniform float uDim;
uniform float uReveal;
uniform vec3 uHold;       // progress, state (0 none, 1 filling, 2 ready, 3 over), visibility
uniform vec4 uRipples[${MAX_RIPPLES}];   // x, y (device px), age (s), strength
uniform vec3 uRippleColor[${MAX_RIPPLES}];
uniform sampler2D uGlow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float minRes = min(uRes.x, uRes.y);

  // Ripples bend the background slightly (cheap refraction) and add coloured rings.
  vec2 bend = vec2(0.0);
  vec3 rippleLight = vec3(0.0);
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    vec2 d = frag - r.xy;
    float dist = length(d);
    float radius = r.z * minRes * 0.55;
    float width = minRes * (0.012 + r.z * 0.03);
    float ring = exp(-pow((dist - radius) / width, 2.0)) * exp(-r.z * 2.6) * r.w;
    bend += (dist > 0.0 ? d / dist : vec2(0.0)) * ring * 6.0;
    rippleLight += uRippleColor[i] * ring;
  }

  vec2 p = (frag + bend) / minRes;
  float t = uTime * 0.025;

  // Deep space: a slow two-colour nebula over a blue-black gradient.
  vec3 col = mix(vec3(0.012, 0.016, 0.03), vec3(0.03, 0.04, 0.07), vUv.y);
  float n1 = fbm(p * 1.6 + vec2(t, -t * 0.6));
  float n2 = fbm(p * 2.4 - vec2(t * 0.7, t * 0.3) + n1);
  col += vec3(0.05, 0.16, 0.16) * pow(n2, 2.2) * 0.9;
  col += vec3(0.12, 0.06, 0.18) * pow(n1, 3.0) * 0.8;
  // Faint dust stars.
  float star = step(0.9965, hash(floor(frag / 2.0))) * (0.4 + 0.6 * sin(uTime * 0.8 + hash(floor(frag)) * 30.0));
  col += vec3(star) * 0.35;

  // The glass plate.
  vec2 rel = frag - uPlate.xy;
  float dist = length(rel);
  float rad = uPlate.z;
  float inside = 1.0 - smoothstep(rad - 1.5, rad + 1.5, dist);
  float rn = dist / max(rad, 1.0);

  // Light pooling under and around the plate, brighter while it rings.
  float halo = exp(-pow(max(rn - 1.0, 0.0) * 3.2, 2.0)) * (1.0 - inside);
  col += vec3(0.1, 0.35, 0.33) * halo * (0.18 + uEnergy * 0.55) * (1.0 - uDim * 0.5);
  col += vec3(0.9, 0.7, 0.35) * halo * uReveal * 0.35;

  vec3 glass = vec3(0.016, 0.022, 0.034) + vec3(0.02, 0.035, 0.045) * (1.0 - rn);
  // Soft specular highlight towards the top left, and fine concentric sheen.
  vec2 hl = rel / max(rad, 1.0) - vec2(-0.35, 0.45);
  glass += vec3(0.07, 0.09, 0.11) * exp(-dot(hl, hl) * 5.0);
  glass += vec3(0.012, 0.02, 0.024) * sin(rn * 140.0 + uTime * 0.4) * (1.0 - rn) * 0.6;
  // Energy makes the plate faintly shimmer.
  glass += vec3(0.03, 0.08, 0.08) * uEnergy * (0.5 + 0.5 * sin(rn * 30.0 - uTime * 18.0)) * (1.0 - rn);
  col = mix(col, glass, inside * 0.92);

  // Fresnel rim.
  float rimLine = exp(-pow((dist - rad) / 1.6, 2.0));
  float rimGlow = exp(-pow((dist - rad) / (rad * 0.045), 2.0));
  vec3 rimCol = mix(vec3(0.55, 0.8, 0.85), vec3(1.0, 0.85, 0.55), uReveal);
  col += rimCol * (rimLine * 0.45 + rimGlow * (0.06 + uEnergy * 0.18));

  // Hold ring: an arc just outside the rim, sweeping clockwise from the top.
  if (uHold.z > 0.001) {
    float ringR = rad * 1.055;
    float band = exp(-pow((dist - ringR) / max(2.2, rad * 0.009), 2.0));
    float bandGlow = exp(-pow((dist - ringR) / (rad * 0.04), 2.0));
    float ang = atan(rel.x, rel.y);                // 0 at top, clockwise positive
    float a01 = fract(ang / 6.2831853 + 1.0);
    float filled = step(a01, clamp(uHold.x, 0.0, 1.0));
    vec3 holdCol = uHold.y > 2.5 ? vec3(1.0, 0.7, 0.3) : uHold.y > 1.5 ? vec3(1.0, 0.97, 0.85) : vec3(0.5, 0.95, 0.82);
    float readyPulse = uHold.y > 1.5 && uHold.y < 2.5 ? 0.6 + 0.4 * sin(uTime * 14.0) : 1.0;
    col += vec3(0.5, 0.6, 0.65) * band * 0.12 * uHold.z;                       // track
    col += holdCol * (band * 1.1 + bandGlow * 0.35) * filled * uHold.z * readyPulse;
  }

  // Sand glow (blurred low-res particle pass).
  vec2 g = vUv;
  vec2 px = 1.0 / vec2(textureSize(uGlow, 0));
  vec3 glow = texture(uGlow, g).rgb * 0.24;
  glow += (texture(uGlow, g + vec2(px.x * 1.5, 0)).rgb + texture(uGlow, g - vec2(px.x * 1.5, 0)).rgb) * 0.15;
  glow += (texture(uGlow, g + vec2(0, px.y * 1.5)).rgb + texture(uGlow, g - vec2(0, px.y * 1.5)).rgb) * 0.15;
  glow += (texture(uGlow, g + px * 2.5).rgb + texture(uGlow, g - px * 2.5).rgb) * 0.08;
  glow += (texture(uGlow, g + vec2(px.x, -px.y) * 2.5).rgb + texture(uGlow, g + vec2(-px.x, px.y) * 2.5).rgb) * 0.08;
  col += glow * (0.75 + uReveal * 0.5);

  col += rippleLight * 0.55;

  // Vignette, dim for UI legibility, gentle film grain against banding.
  float vig = smoothstep(1.25, 0.25, length((vUv - 0.5) * vec2(uRes.x / minRes, uRes.y / minRes)));
  col *= mix(0.55, 1.0, vig);
  col *= 1.0 - uDim * 0.35;
  col += (hash(frag + fract(uTime) * 100.0) - 0.5) * 0.012;

  outColor = vec4(pow(max(col, 0.0), vec3(0.95)), 1.0);
}`;

const PT_VERT = `#version 300 es
in vec3 aPart;           // x, y in plate units, speed
uniform vec4 uPlateNdc;  // centre x, y, radius x, radius y (NDC)
uniform float uSize;
uniform float uReveal;
uniform vec3 uTint;
uniform float uTintAmt;
out vec3 vCol;
void main() {
  vec2 pos = uPlateNdc.xy + aPart.xy * uPlateNdc.zw;
  gl_Position = vec4(pos, 0.0, 1.0);
  float s = clamp(aPart.z * 6.0, 0.0, 1.0);
  vec3 sand = vec3(0.92, 0.84, 0.68);
  vec3 lit = vec3(0.6, 1.0, 0.92);
  vec3 gold = vec3(1.0, 0.82, 0.48);
  vec3 c = mix(sand, lit, s * 0.8);
  c = mix(c, gold, uReveal * 0.65);
  c = mix(c, uTint, uTintAmt * (0.4 + s * 0.6));
  float grain = 0.55 + 0.75 * fract(sin(float(gl_VertexID) * 12.9898) * 43758.5453);
  vCol = c * grain * (0.36 + s * 0.7 + uReveal * 0.15);
  gl_PointSize = uSize * (1.0 + s * 0.35);
}`;

const PT_FRAG = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d));
  outColor = vec4(vCol * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
  return prog;
}

function noopScene(): Scene {
  return {
    supported: false,
    setPlate() {},
    setFigure() {},
    strike() {},
    setHold() {},
    setCoherence() {},
    setAmbient() {},
    setDim() {},
    scatter() {},
    reveal() {},
    reset() {},
  };
}

function isCoarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

export function createScene(canvas: HTMLCanvasElement): Scene {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance" });
  if (!gl) return noopScene();

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = isCoarsePointer();
  const COUNT = mobile ? 9000 : 16000;
  const dprCap = mobile ? 1.75 : 2;

  let bgProg: WebGLProgram;
  let ptProg: WebGLProgram;
  try {
    bgProg = program(gl, BG_VERT, BG_FRAG);
    ptProg = program(gl, PT_VERT, PT_FRAG);
  } catch (err) {
    console.warn("resonance: WebGL scene unavailable", err);
    return noopScene();
  }

  // Fullscreen triangle pair.
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const bgVao = gl.createVertexArray();
  gl.bindVertexArray(bgVao);
  const bgPosLoc = gl.getAttribLocation(bgProg, "aPos");
  gl.enableVertexAttribArray(bgPosLoc);
  gl.vertexAttribPointer(bgPosLoc, 2, gl.FLOAT, false, 0, 0);

  // Particles: x, y, vx, vy on the CPU; x, y, speed uploaded every frame.
  const px = new Float32Array(COUNT);
  const py = new Float32Array(COUNT);
  const vx = new Float32Array(COUNT);
  const vy = new Float32Array(COUNT);
  const gpu = new Float32Array(COUNT * 3);
  const ptBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
  gl.bufferData(gl.ARRAY_BUFFER, gpu.byteLength, gl.DYNAMIC_DRAW);
  const ptVao = gl.createVertexArray();
  gl.bindVertexArray(ptVao);
  const ptLoc = gl.getAttribLocation(ptProg, "aPart");
  gl.enableVertexAttribArray(ptLoc);
  gl.vertexAttribPointer(ptLoc, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Low-res target for the glow pass.
  const glowTex = gl.createTexture();
  const glowFbo = gl.createFramebuffer();
  let glowW = 1;
  let glowH = 1;

  const u = {
    res: gl.getUniformLocation(bgProg, "uRes"),
    time: gl.getUniformLocation(bgProg, "uTime"),
    plate: gl.getUniformLocation(bgProg, "uPlate"),
    energy: gl.getUniformLocation(bgProg, "uEnergy"),
    dim: gl.getUniformLocation(bgProg, "uDim"),
    reveal: gl.getUniformLocation(bgProg, "uReveal"),
    hold: gl.getUniformLocation(bgProg, "uHold"),
    ripples: gl.getUniformLocation(bgProg, "uRipples"),
    rippleColor: gl.getUniformLocation(bgProg, "uRippleColor"),
    glow: gl.getUniformLocation(bgProg, "uGlow"),
    plateNdc: gl.getUniformLocation(ptProg, "uPlateNdc"),
    size: gl.getUniformLocation(ptProg, "uSize"),
    ptReveal: gl.getUniformLocation(ptProg, "uReveal"),
    tint: gl.getUniformLocation(ptProg, "uTint"),
    tintAmt: gl.getUniformLocation(ptProg, "uTintAmt"),
  };

  // ---- State ----
  let dpr = 1;
  let width = 1;
  let height = 1;
  const plate = { cx: 0, cy: 0, r: 100 };
  const plateTarget = { cx: 0, cy: 0, r: 100 };
  let plateInit = false;

  let energy = 0;
  let ambient = 0;
  let coherence = 1;
  let dim = 0;
  let dimTarget = 0;
  let reveal = 0;
  let revealTarget = 0;
  let hold: { progress: number; state: HoldState } | null = null;
  let holdVis = 0;
  let holdShown = { progress: 0, state: 1 };
  const tint: [number, number, number] = [1, 1, 1];
  let tintAmt = 0;

  let figure = 0;
  let prevFigure = 0;
  let morph = 1; // 0 → 1 crossfade from prevFigure to figure
  const noiseFigure = { index: 5 };

  const ripples = new Float32Array(MAX_RIPPLES * 4);
  const rippleColors = new Float32Array(MAX_RIPPLES * 3);
  let rippleCursor = 0;

  function scatter(): void {
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.985;
      px[i] = Math.cos(a) * r;
      py[i] = Math.sin(a) * r;
      vx[i] = 0;
      vy[i] = 0;
    }
  }
  scatter();

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    width = Math.max(1, Math.round(window.innerWidth * dpr));
    height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    glowW = Math.max(1, Math.round(width / 4));
    glowH = Math.max(1, Math.round(height / 4));
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, glowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, glowW, glowH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resize();
  window.addEventListener("resize", resize);

  // ---- Physics ----
  const cx = new Float64Array(MAX_K + 1);
  const sx = new Float64Array(MAX_K + 1);
  const cy = new Float64Array(MAX_K + 1);
  const sy = new Float64Array(MAX_K + 1);

  function fillRecurrence(c: Float64Array, s: Float64Array, v: number): void {
    const c1 = Math.cos(Math.PI * v);
    const s1 = Math.sin(Math.PI * v);
    c[0] = 1;
    s[0] = 0;
    for (let k = 1; k <= MAX_K; k++) {
      c[k] = c[k - 1]! * c1 - s[k - 1]! * s1;
      s[k] = s[k - 1]! * c1 + c[k - 1]! * s1;
    }
  }

  // Mode evaluation writes into these to avoid allocating.
  let fOut = 0;
  let gxOut = 0;
  let gyOut = 0;
  function evalMode(index: number): void {
    const mode = MODES[((index % MODES.length) + MODES.length) % MODES.length]!;
    const n = mode[0];
    const m = mode[1];
    const sgn = mode[2];
    const A = cx[n]!;
    const B = cy[m]!;
    const C = cx[m]!;
    const D = cy[n]!;
    fOut = A * B + sgn * C * D;
    gxOut = -n * Math.PI * sx[n]! * B - sgn * m * Math.PI * sx[m]! * D;
    gyOut = -m * Math.PI * A * sy[m]! - sgn * n * Math.PI * C * sy[n]!;
  }

  function stepPhysics(dt: number): void {
    const drive = Math.max(energy, ambient);
    if (drive < 0.004) {
      for (let i = 0; i < COUNT; i++) {
        vx[i] = 0;
        vy[i] = 0;
      }
      return;
    }
    const noiseW = (1 - coherence) * 0.85;
    const wPrev = (1 - morph) * (1 - noiseW);
    const wCur = morph * (1 - noiseW);
    const pull = 1.15 * drive;
    const agitate = 0.95 * drive;
    const damping = Math.exp(-dt * 9);
    const sdt = Math.min(dt, 1 / 30);

    for (let i = 0; i < COUNT; i++) {
      const x = px[i]!;
      const y = py[i]!;
      fillRecurrence(cx, sx, x);
      fillRecurrence(cy, sy, y);
      evalMode(figure);
      let f = fOut * wCur;
      let gx = gxOut * wCur;
      let gy = gyOut * wCur;
      if (wPrev > 0.001) {
        evalMode(prevFigure);
        f += fOut * wPrev;
        gx += gxOut * wPrev;
        gy += gyOut * wPrev;
      }
      if (noiseW > 0.001) {
        evalMode(noiseFigure.index);
        f += fOut * noiseW;
        gx += gxOut * noiseW;
        gy += gyOut * noiseW;
      }
      // Agitation is strongest on the antinodes; a little everywhere keeps the lines grainy.
      const jitter = (Math.abs(f) + 0.08) * agitate;
      let nvx = vx[i]! * damping - f * gx * pull * sdt + (Math.random() - 0.5) * jitter * sdt * 3.2;
      let nvy = vy[i]! * damping - f * gy * pull * sdt + (Math.random() - 0.5) * jitter * sdt * 3.2;
      let nx = x + nvx * sdt;
      let ny = y + nvy * sdt;
      const r2 = nx * nx + ny * ny;
      if (r2 > 0.97) {
        const r = Math.sqrt(r2);
        nx *= 0.984 / r;
        ny *= 0.984 / r;
        nvx *= -0.3;
        nvy *= -0.3;
      }
      px[i] = nx;
      py[i] = ny;
      vx[i] = nvx;
      vy[i] = nvy;
    }
  }

  // ---- Frame loop ----
  let last = performance.now();
  const startedAt = last;

  function frame(now: number): void {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const time = (now - startedAt) / 1000;

    // Ease toward targets.
    const ease = 1 - Math.exp(-dt * 6);
    plate.cx += (plateTarget.cx - plate.cx) * ease;
    plate.cy += (plateTarget.cy - plate.cy) * ease;
    plate.r += (plateTarget.r - plate.r) * ease;
    dim += (dimTarget - dim) * ease;
    reveal += (revealTarget - reveal) * (1 - Math.exp(-dt * 1.6));
    morph = Math.min(1, morph + dt * 0.7);
    tintAmt *= Math.exp(-dt * 4);

    // Sustained notes keep the plate ringing while held; otherwise energy decays.
    if (hold && hold.state !== "over") energy = Math.max(energy, 0.42 + 0.3 * hold.progress);
    energy *= Math.exp(-dt * (reducedMotion ? 3 : 1.7));
    holdVis += ((hold ? 1 : 0) - holdVis) * (1 - Math.exp(-dt * (hold ? 20 : 5)));
    if (hold) holdShown = { progress: hold.progress, state: hold.state === "filling" ? 1 : hold.state === "ready" ? 2 : 3 };

    for (let i = 0; i < MAX_RIPPLES; i++) {
      if (ripples[i * 4 + 3]! > 0) {
        ripples[i * 4 + 2]! += dt;
        if (ripples[i * 4 + 2]! > 2.2) ripples[i * 4 + 3] = 0;
      }
    }

    stepPhysics(dt);
    for (let i = 0; i < COUNT; i++) {
      gpu[i * 3] = px[i]!;
      gpu[i * 3 + 1] = py[i]!;
      gpu[i * 3 + 2] = Math.hypot(vx[i]!, vy[i]!);
    }

    render(time);
    requestAnimationFrame(frame);
  }

  function render(time: number): void {
    if (!gl) return;
    const pcx = plate.cx * dpr;
    const pcy = height - plate.cy * dpr;
    const pr = plate.r * dpr;
    const ndc = [(pcx / width) * 2 - 1, (pcy / height) * 2 - 1, ((pr * 0.985) / width) * 2, ((pr * 0.985) / height) * 2];

    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, gpu);

    // 1. Particles into the low-res glow target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, glowFbo);
    gl.viewport(0, 0, glowW, glowH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(ptProg);
    gl.uniform4f(u.plateNdc, ndc[0]!, ndc[1]!, ndc[2]!, ndc[3]!);
    gl.uniform1f(u.size, Math.max(1.5, (pr / 4) * 0.012));
    gl.uniform1f(u.ptReveal, reveal);
    gl.uniform3f(u.tint, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.tintAmt, tintAmt);
    gl.bindVertexArray(ptVao);
    gl.drawArrays(gl.POINTS, 0, COUNT);

    // 2. Background, plate and glow composite.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(bgProg);
    gl.uniform2f(u.res, width, height);
    gl.uniform1f(u.time, time);
    gl.uniform3f(u.plate, pcx, pcy, pr);
    gl.uniform1f(u.energy, Math.min(1, Math.max(energy, ambient * 0.6)));
    gl.uniform1f(u.dim, dim);
    gl.uniform1f(u.reveal, reveal);
    gl.uniform3f(u.hold, holdShown.progress, holdShown.state, holdVis);
    gl.uniform4fv(u.ripples, ripples);
    gl.uniform3fv(u.rippleColor, rippleColors);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glowTex);
    gl.uniform1i(u.glow, 0);
    gl.bindVertexArray(bgVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 3. Sharp particles on top.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(ptProg);
    gl.uniform1f(u.size, Math.max(1.2, Math.min(2.6, pr * 0.006)));
    gl.bindVertexArray(ptVao);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.bindVertexArray(null);
  }

  requestAnimationFrame(frame);

  function addRipple(x: number, y: number, strength: number, rgb: [number, number, number]): void {
    const i = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    ripples[i * 4] = x * dpr;
    ripples[i * 4 + 1] = height - y * dpr;
    ripples[i * 4 + 2] = 0;
    ripples[i * 4 + 3] = strength;
    rippleColors[i * 3] = rgb[0];
    rippleColors[i * 3 + 1] = rgb[1];
    rippleColors[i * 3 + 2] = rgb[2];
  }

  return {
    supported: true,
    setPlate(x: number, y: number, radius: number) {
      plateTarget.cx = x;
      plateTarget.cy = y;
      plateTarget.r = Math.max(20, radius);
      if (!plateInit) {
        plate.cx = x;
        plate.cy = y;
        plate.r = plateTarget.r;
        plateInit = true;
      }
    },
    setFigure(index: number) {
      if (index === figure) return;
      prevFigure = figure;
      figure = index;
      morph = 0;
      noiseFigure.index = index + 5;
    },
    strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null) {
      energy = Math.min(1.2, energy + STRIKE_ENERGY[kind]);
      const rgb = GRADE_RGB[kind];
      addRipple(clientX ?? plate.cx, clientY ?? plate.cy, kind === "miss" ? 1.1 : 0.9, rgb);
      if (kind !== "neutral") {
        tint[0] = rgb[0];
        tint[1] = rgb[1];
        tint[2] = rgb[2];
        tintAmt = kind === "perfect" ? 0.35 : 0.6;
      }
      if (kind === "miss") {
        // A wrong tap shakes everything loose a little.
        for (let i = 0; i < COUNT; i++) {
          vx[i]! += (Math.random() - 0.5) * 0.5;
          vy[i]! += (Math.random() - 0.5) * 0.5;
        }
      }
    },
    setHold(next) {
      hold = next;
    },
    setCoherence(value: number) {
      coherence = Math.min(1, Math.max(0, value));
    },
    setAmbient(level: number) {
      ambient = reducedMotion ? level * 0.4 : level;
    },
    setDim(value: number) {
      dimTarget = value;
    },
    scatter,
    reveal(quality: number) {
      // The figure settles calmly (a low, steady drive) and glows; how clean it gets reflects
      // how clean the run was.
      const q = Math.min(1, Math.max(0, quality));
      revealTarget = 0.3 + 0.7 * q;
      coherence = q;
      energy = Math.max(energy, 0.45);
      ambient = reducedMotion ? 0.08 : 0.2;
    },
    reset() {
      revealTarget = 0;
      hold = null;
      coherence = 1;
    },
  };
}

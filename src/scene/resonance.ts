// The Resonance scene: red, orange and purple sand lying on an endless white floor, seen from a
// low camera, drawn with raw WebGL2 behind the whole app. Playing makes the floor resonate: grains
// on the vibrating parts (antinodes) lift off and hover, grains drift toward the still lines
// (nodes), so steady playing settles the sand into a Chladni figure. How high the sand floats
// follows how in-tempo the playing is.
//
// Physics runs on the CPU (a cosine recurrence keeps it cheap), rendering on the GPU: a floor
// shader (ray-cast floor with ripples and the hold ring), a shadow pass and a grain pass.

import type { Grade } from "../types";

export type StrikeKind = Grade | "neutral";
export type HoldState = "filling" | "ready" | "over";

export interface Scene {
  /** Where the sand bed sits on screen, in viewport CSS px: its centre and half-width. */
  setPlate(cx: number, cy: number, radius: number): void;
  /** Which Chladni figure the sand is drawn toward (any integer; wraps around the mode list). */
  setFigure(index: number): void;
  /** A tap landed: a ripple on the floor under the tap point (or the centre) and an energy kick. */
  strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null): void;
  /** A held note in progress (0..1 of its written length), or null when nothing is held. */
  setHold(hold: { progress: number; state: HoldState } | null): void;
  /** 0..1: how in-tempo and clean the playing is. High lifts the sand; low blurs the figure. */
  setCoherence(value: number): void;
  /** Background energy that keeps the sand gently moving (the home screen's idle state). */
  setAmbient(level: number): void;
  /** 0..1: how much the scene fades back behind UI. */
  setDim(value: number): void;
  /** Scatter the sand evenly. */
  scatter(): void;
  /** End of a run: the sand rises together and settles into the figure. `quality` is 0..1. */
  reveal(quality: number): void;
  /** Clear the reveal and any hold ring. */
  reset(): void;
  readonly supported: boolean;
}

/** Chladni modes (n, m, sign) for f = cos(nπx)cos(mπz) + s·cos(mπx)cos(nπz), x, z in [-1, 1]. */
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

/** Grade colours, shared with the staff: orange clean, light orange good, purple close, red miss. */
const GRADE_RGB: Record<StrikeKind, [number, number, number]> = {
  perfect: [0.89, 0.38, 0.11],
  good: [0.94, 0.6, 0.24],
  ok: [0.48, 0.29, 0.69],
  miss: [0.82, 0.23, 0.23],
  neutral: [0.45, 0.4, 0.5],
};
const STRIKE_ENERGY: Record<StrikeKind, number> = { perfect: 0.8, good: 0.65, ok: 0.5, miss: 0.55, neutral: 0.45 };

const MAX_RIPPLES = 8;

/** Camera: low over the floor, looking slightly down at the sand bed. */
const EYE: [number, number, number] = [0, 0.62, 2.55];
const TARGET: [number, number, number] = [0, 0, 0];
const FOV_TAN = Math.tan((32 * Math.PI) / 180 / 2);

/** Shared GLSL: world → screen through the camera basis, then the 2D fit onto the layout. */
const CAMERA_GLSL = `
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform float uTan;
uniform float uAspect;
uniform vec4 uFit;   // scale x, scale y, offset x, offset y (NDC)
vec4 project(vec3 p) {
  vec3 v = p - uEye;
  float zc = dot(v, uFwd);
  vec2 ndc = vec2(dot(v, uRight) / (uTan * uAspect), dot(v, uUp) / uTan) / zc;
  ndc = ndc * uFit.xy + uFit.zw;
  return vec4(ndc, 0.0, 1.0);
}
float depthOf(vec3 p) { return dot(p - uEye, uFwd); }
`;

const FLOOR_VERT = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FLOOR_FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
${CAMERA_GLSL}
uniform float uTime;
uniform float uEnergy;
uniform float uDim;
uniform float uReveal;
uniform vec3 uHold;     // progress, state (1 filling, 2 ready, 3 over), visibility
uniform vec4 uRipples[${MAX_RIPPLES}];  // x, z (world), age (s), strength
uniform vec3 uRippleColor[${MAX_RIPPLES}];

const vec3 SKY_TOP = vec3(0.985, 0.98, 0.968);
const vec3 SKY_LOW = vec3(0.965, 0.955, 0.94);
const vec3 FLOOR = vec3(0.975, 0.968, 0.955);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 base = (vNdc - uFit.zw) / uFit.xy;
  vec3 ray = normalize(uFwd + base.x * uTan * uAspect * uRight + base.y * uTan * uUp);
  vec3 col;
  if (ray.y >= -0.0005) {
    col = mix(SKY_LOW, SKY_TOP, smoothstep(0.0, 0.35, ray.y));
  } else {
    float t = -uEye.y / ray.y;
    vec3 hit = uEye + ray * t;
    vec2 p = hit.xz;
    col = FLOOR;
    // A faint bed of warmth where the sand lies.
    float r = length(p);
    col -= vec3(0.01, 0.018, 0.02) * exp(-r * r * 1.4) * (0.6 + uEnergy * 0.6);
    col += vec3(0.02, 0.006, -0.01) * exp(-r * r * 1.2) * uReveal;

    // Ripples travel across the floor from each tap.
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      vec4 rp = uRipples[i];
      if (rp.w <= 0.0) continue;
      float d = length(p - rp.xy);
      float radius = rp.z * 1.1;
      float width = 0.025 + rp.z * 0.05;
      float ring = exp(-pow((d - radius) / width, 2.0)) * exp(-rp.z * 2.2) * rp.w;
      col = mix(col, uRippleColor[i], clamp(ring * 0.35, 0.0, 0.6));
    }

    // Hold ring: a thin arc on the floor around the sand, sweeping clockwise from the back.
    if (uHold.z > 0.001) {
      float ringR = 1.16;
      float band = exp(-pow((r - ringR) / 0.012, 2.0));
      float ang = atan(p.x, -p.y);
      float a01 = fract(ang / 6.2831853 + 1.0);
      float filled = step(a01, clamp(uHold.x, 0.0, 1.0));
      vec3 holdCol = uHold.y > 2.5 ? vec3(0.82, 0.23, 0.23) : uHold.y > 1.5 ? vec3(0.17, 0.12, 0.2) : vec3(0.89, 0.38, 0.11);
      col = mix(col, vec3(0.17, 0.12, 0.2), band * 0.08 * uHold.z);
      col = mix(col, holdCol, band * filled * uHold.z * 0.9);
    }

    // The floor dissolves into the sky towards the horizon.
    col = mix(col, SKY_LOW, smoothstep(3.5, 16.0, t));
  }
  col = mix(col, SKY_TOP, uDim * 0.6);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.006;
  outColor = vec4(col, 1.0);
}`;

const GRAIN_VERT = `#version 300 es
in vec3 aGrain;   // x, z, height
${CAMERA_GLSL}
uniform float uSize;
uniform float uShadow;   // 1 for the shadow pass
uniform vec3 uLight;     // shadow offset per unit of height (world xz)
uniform float uDim;
out vec4 vCol;

const vec3 PALETTE[6] = vec3[6](
  vec3(0.84, 0.25, 0.2), vec3(0.93, 0.44, 0.19), vec3(0.96, 0.59, 0.27),
  vec3(0.59, 0.27, 0.67), vec3(0.42, 0.24, 0.63), vec3(0.78, 0.24, 0.43));

void main() {
  float h = aGrain.z;
  float id = float(gl_VertexID);
  float rnd = fract(sin(id * 12.9898) * 43758.5453);
  vec3 world = uShadow > 0.5 ? vec3(aGrain.x + uLight.x * h, 0.0, aGrain.y + uLight.z * h) : vec3(aGrain.x, h, aGrain.y);
  gl_Position = project(world);
  float zc = depthOf(world);
  float fog = 1.0 - smoothstep(4.0, 9.0, zc);
  // Sand thins out at the bed's edge instead of ending in a hard rim.
  float r = length(aGrain.xy);
  float edge = 1.0 - smoothstep(0.9, 1.0, r);
  if (uShadow > 0.5) {
    float lifted = smoothstep(0.0, 0.02, h);
    float a = mix(0.07, 0.15 * (1.0 - smoothstep(0.05, 0.4, h)), lifted);
    vCol = vec4(vec3(0.17, 0.12, 0.2), a * fog * edge * (1.0 - uDim * 0.7));
    gl_PointSize = uSize * (1.2 + h * 6.0) / zc;
  } else {
    vec3 c = PALETTE[int(mod(id, 6.0))];
    c *= 0.82 + 0.3 * rnd;
    vCol = vec4(c, (0.78 + 0.22 * rnd) * fog * edge * (1.0 - uDim * 0.75));
    gl_PointSize = uSize * (0.75 + 0.5 * rnd) / zc;
  }
}`;

const GRAIN_FRAG = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.32, length(d));
  outColor = vec4(vCol.rgb, vCol.a * a);
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

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function createScene(canvas: HTMLCanvasElement): Scene {
  const glMaybe = canvas.getContext("webgl2", { antialias: true, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance" });
  if (!glMaybe) return noopScene();
  const gl: WebGL2RenderingContext = glMaybe;

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const COUNT = mobile ? 11000 : 20000;

  let floorProg: WebGLProgram;
  let grainProg: WebGLProgram;
  try {
    floorProg = program(gl, FLOOR_VERT, FLOOR_FRAG);
    grainProg = program(gl, GRAIN_VERT, GRAIN_FRAG);
  } catch (err) {
    console.warn("resonance: WebGL scene unavailable", err);
    return noopScene();
  }

  // Camera basis (fixed).
  const fwd = norm(sub(TARGET, EYE));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const floorVao = gl.createVertexArray();
  gl.bindVertexArray(floorVao);
  const floorPosLoc = gl.getAttribLocation(floorProg, "aPos");
  gl.enableVertexAttribArray(floorPosLoc);
  gl.vertexAttribPointer(floorPosLoc, 2, gl.FLOAT, false, 0, 0);

  const px = new Float32Array(COUNT);
  const pz = new Float32Array(COUNT);
  const vx = new Float32Array(COUNT);
  const vz = new Float32Array(COUNT);
  /** |f| at each grain: how hard its spot of floor vibrates. */
  const amp = new Float32Array(COUNT);
  const phase = new Float32Array(COUNT);
  const heights = new Float32Array(COUNT);
  const gpu = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) phase[i] = Math.random() * Math.PI * 2;
  const grainBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, grainBuf);
  gl.bufferData(gl.ARRAY_BUFFER, gpu.byteLength, gl.DYNAMIC_DRAW);
  const grainVao = gl.createVertexArray();
  gl.bindVertexArray(grainVao);
  const grainLoc = gl.getAttribLocation(grainProg, "aGrain");
  gl.enableVertexAttribArray(grainLoc);
  gl.vertexAttribPointer(grainLoc, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  function cameraUniforms(prog: WebGLProgram) {
    return {
      eye: gl.getUniformLocation(prog, "uEye"),
      right: gl.getUniformLocation(prog, "uRight"),
      up: gl.getUniformLocation(prog, "uUp"),
      fwd: gl.getUniformLocation(prog, "uFwd"),
      tan: gl.getUniformLocation(prog, "uTan"),
      aspect: gl.getUniformLocation(prog, "uAspect"),
      fit: gl.getUniformLocation(prog, "uFit"),
    };
  }
  const floorCam = cameraUniforms(floorProg);
  const grainCam = cameraUniforms(grainProg);
  const uf = {
    time: gl.getUniformLocation(floorProg, "uTime"),
    energy: gl.getUniformLocation(floorProg, "uEnergy"),
    dim: gl.getUniformLocation(floorProg, "uDim"),
    reveal: gl.getUniformLocation(floorProg, "uReveal"),
    hold: gl.getUniformLocation(floorProg, "uHold"),
    ripples: gl.getUniformLocation(floorProg, "uRipples"),
    rippleColor: gl.getUniformLocation(floorProg, "uRippleColor"),
  };
  const ug = {
    size: gl.getUniformLocation(grainProg, "uSize"),
    shadow: gl.getUniformLocation(grainProg, "uShadow"),
    light: gl.getUniformLocation(grainProg, "uLight"),
    dim: gl.getUniformLocation(grainProg, "uDim"),
  };

  // ---- State ----
  let dpr = 1;
  let width = 1;
  let heightPx = 1;
  const plate = { cx: 0, cy: 0, r: 100 };
  const plateTarget = { cx: 0, cy: 0, r: 100 };
  let plateInit = false;
  const fit = [1, 1, 0, 0];

  let energy = 0;
  let ambient = 0;
  let coherence = 1;
  let lift = 0;
  let dim = 0;
  let dimTarget = 0;
  let reveal = 0;
  let revealTarget = 0;
  let hold: { progress: number; state: HoldState } | null = null;
  let holdVis = 0;
  let holdShown = { progress: 0, state: 1 };

  let figure = 0;
  let prevFigure = 0;
  let morph = 1;
  let noiseFigure = 5;

  const ripples = new Float32Array(MAX_RIPPLES * 4);
  const rippleColors = new Float32Array(MAX_RIPPLES * 3);
  let rippleCursor = 0;

  function scatter(): void {
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.99;
      px[i] = Math.cos(a) * r;
      pz[i] = Math.sin(a) * r;
      vx[i] = 0;
      vz[i] = 0;
    }
  }
  scatter();

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(window.innerWidth * dpr));
    heightPx = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== heightPx) {
      canvas.width = width;
      canvas.height = heightPx;
    }
  }
  resize();
  window.addEventListener("resize", resize);

  /** Unfitted NDC of a world point (before the layout fit). */
  function baseNdc(p: Vec3): [number, number] {
    const v = sub(p, EYE);
    const zc = dot(v, fwd);
    const aspect = width / heightPx;
    return [dot(v, right) / (FOV_TAN * aspect) / zc, dot(v, up) / FOV_TAN / zc];
  }

  /** Scale and offset so the bed's centre lands on (cx, cy) and its width spans 2r. */
  function updateFit(): void {
    const leftP = baseNdc([-1, 0, 0]);
    const rightP = baseNdc([1, 0, 0]);
    const centre = baseNdc([0, 0, 0]);
    const spanPx = ((rightP[0] - leftP[0]) / 2) * window.innerWidth;
    const s = spanPx > 0 ? (2 * plate.r) / spanPx : 1;
    const targetX = (plate.cx / window.innerWidth) * 2 - 1;
    const targetY = 1 - (plate.cy / window.innerHeight) * 2;
    fit[0] = s;
    fit[1] = s;
    fit[2] = targetX - centre[0] * s;
    fit[3] = targetY - centre[1] * s;
  }

  /** The floor point under a screen point, or null when it's above the horizon. */
  function floorAt(clientX: number, clientY: number): [number, number] | null {
    const ndcX = ((clientX / window.innerWidth) * 2 - 1 - fit[2]!) / fit[0]!;
    const ndcY = (1 - (clientY / window.innerHeight) * 2 - fit[3]!) / fit[1]!;
    const aspect = width / heightPx;
    const ray = norm([
      fwd[0] + ndcX * FOV_TAN * aspect * right[0] + ndcY * FOV_TAN * up[0],
      fwd[1] + ndcX * FOV_TAN * aspect * right[1] + ndcY * FOV_TAN * up[1],
      fwd[2] + ndcX * FOV_TAN * aspect * right[2] + ndcY * FOV_TAN * up[2],
    ]);
    if (ray[1] >= -0.01) return null;
    const t = -EYE[1] / ray[1];
    return [EYE[0] + ray[0] * t, EYE[2] + ray[2] * t];
  }

  // ---- Physics ----
  const cxr = new Float64Array(MAX_K + 1);
  const sxr = new Float64Array(MAX_K + 1);
  const czr = new Float64Array(MAX_K + 1);
  const szr = new Float64Array(MAX_K + 1);

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

  let fOut = 0;
  let gxOut = 0;
  let gzOut = 0;
  function evalMode(index: number): void {
    const mode = MODES[((index % MODES.length) + MODES.length) % MODES.length]!;
    const n = mode[0];
    const m = mode[1];
    const sgn = mode[2];
    const A = cxr[n]!;
    const B = czr[m]!;
    const C = cxr[m]!;
    const D = czr[n]!;
    fOut = A * B + sgn * C * D;
    gxOut = -n * Math.PI * sxr[n]! * B - sgn * m * Math.PI * sxr[m]! * D;
    gzOut = -m * Math.PI * A * szr[m]! - sgn * n * Math.PI * C * szr[n]!;
  }

  function stepPhysics(dt: number, time: number): void {
    const drive = Math.max(energy, ambient);
    const noiseW = (1 - coherence) * 0.85;
    const wPrev = (1 - morph) * (1 - noiseW);
    const wCur = morph * (1 - noiseW);
    const pull = 1.15 * drive;
    const agitate = 0.95 * drive;
    const damping = Math.exp(-dt * 9);
    const sdt = Math.min(dt, 1 / 30);
    const moving = drive > 0.004;

    for (let i = 0; i < COUNT; i++) {
      if (moving) {
        const x = px[i]!;
        const z = pz[i]!;
        fillRecurrence(cxr, sxr, x);
        fillRecurrence(czr, szr, z);
        evalMode(figure);
        let f = fOut * wCur;
        let gx = gxOut * wCur;
        let gz = gzOut * wCur;
        if (wPrev > 0.001) {
          evalMode(prevFigure);
          f += fOut * wPrev;
          gx += gxOut * wPrev;
          gz += gzOut * wPrev;
        }
        if (noiseW > 0.001) {
          evalMode(noiseFigure);
          f += fOut * noiseW;
          gx += gxOut * noiseW;
          gz += gzOut * noiseW;
        }
        amp[i] = Math.abs(f);
        const jitter = (Math.abs(f) + 0.08) * agitate;
        let nvx = vx[i]! * damping - f * gx * pull * sdt + (Math.random() - 0.5) * jitter * sdt * 3.2;
        let nvz = vz[i]! * damping - f * gz * pull * sdt + (Math.random() - 0.5) * jitter * sdt * 3.2;
        let nx = x + nvx * sdt;
        let nz = z + nvz * sdt;
        const r2 = nx * nx + nz * nz;
        if (r2 > 0.985) {
          const r = Math.sqrt(r2);
          nx *= 0.99 / r;
          nz *= 0.99 / r;
          nvx *= -0.3;
          nvz *= -0.3;
        }
        px[i] = nx;
        pz[i] = nz;
        vx[i] = nvx;
        vz[i] = nvz;
      } else {
        vx[i] = 0;
        vz[i] = 0;
      }
      // Vibrating grains bob on a slow standing wave; grains on the still lines stay down.
      const wave = 0.55 + 0.45 * Math.sin(time * 3.2 + phase[i]! + (px[i]! - pz[i]!) * 3);
      const target = lift * Math.min(1.6, amp[i]!) * 0.13 * wave;
      heights[i]! += (target - heights[i]!) * Math.min(1, sdt * 8);
    }
  }

  // ---- Frame loop ----
  let last = performance.now();
  const startedAt = last;

  function frame(now: number): void {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const time = (now - startedAt) / 1000;

    const ease = 1 - Math.exp(-dt * 6);
    plate.cx += (plateTarget.cx - plate.cx) * ease;
    plate.cy += (plateTarget.cy - plate.cy) * ease;
    plate.r += (plateTarget.r - plate.r) * ease;
    dim += (dimTarget - dim) * ease;
    reveal += (revealTarget - reveal) * (1 - Math.exp(-dt * 1.4));
    morph = Math.min(1, morph + dt * 0.7);

    if (hold && hold.state !== "over") energy = Math.max(energy, 0.42 + 0.3 * hold.progress);
    energy *= Math.exp(-dt * (reducedMotion ? 3 : 1.6));
    // Lift follows energy, gated by how in-tempo the playing is (squared, so a sloppy run stays
    // visibly low), plus a gentle float when idle and the calm rise of the reveal.
    const liftTarget = (reducedMotion ? 0.4 : 1) * (Math.min(1, energy) * coherence * coherence + ambient * 0.35 + reveal * 0.45);
    lift += (liftTarget - lift) * (1 - Math.exp(-dt * 5));
    holdVis += ((hold ? 1 : 0) - holdVis) * (1 - Math.exp(-dt * (hold ? 20 : 5)));
    if (hold) holdShown = { progress: hold.progress, state: hold.state === "filling" ? 1 : hold.state === "ready" ? 2 : 3 };

    for (let i = 0; i < MAX_RIPPLES; i++) {
      if (ripples[i * 4 + 3]! > 0) {
        ripples[i * 4 + 2]! += dt;
        if (ripples[i * 4 + 2]! > 2.5) ripples[i * 4 + 3] = 0;
      }
    }

    stepPhysics(dt, time);
    for (let i = 0; i < COUNT; i++) {
      gpu[i * 3] = px[i]!;
      gpu[i * 3 + 1] = pz[i]!;
      gpu[i * 3 + 2] = heights[i]!;
    }

    updateFit();
    render(time);
    requestAnimationFrame(frame);
  }

  function setCamera(cam: ReturnType<typeof cameraUniforms>): void {
    gl.uniform3f(cam.eye, EYE[0], EYE[1], EYE[2]);
    gl.uniform3f(cam.right, right[0], right[1], right[2]);
    gl.uniform3f(cam.up, up[0], up[1], up[2]);
    gl.uniform3f(cam.fwd, fwd[0], fwd[1], fwd[2]);
    gl.uniform1f(cam.tan, FOV_TAN);
    gl.uniform1f(cam.aspect, width / heightPx);
    gl.uniform4f(cam.fit, fit[0]!, fit[1]!, fit[2]!, fit[3]!);
  }

  function render(time: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, heightPx);

    // 1. Floor and sky.
    gl.disable(gl.BLEND);
    gl.useProgram(floorProg);
    setCamera(floorCam);
    gl.uniform1f(uf.time, time);
    gl.uniform1f(uf.energy, Math.min(1, Math.max(energy, ambient * 0.5)));
    gl.uniform1f(uf.dim, dim);
    gl.uniform1f(uf.reveal, reveal);
    gl.uniform3f(uf.hold, holdShown.progress, holdShown.state, holdVis);
    gl.uniform4fv(uf.ripples, ripples);
    gl.uniform3fv(uf.rippleColor, rippleColors);
    gl.bindVertexArray(floorVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. Shadows of the grains, then the grains themselves.
    gl.bindBuffer(gl.ARRAY_BUFFER, grainBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, gpu);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(grainProg);
    setCamera(grainCam);
    const sizePx = Math.max(2, plate.r * dpr * 0.0105);
    gl.uniform1f(ug.size, sizePx * 2.4);
    gl.uniform3f(ug.light, 0.35, 0, 0.55);
    gl.uniform1f(ug.dim, dim);
    gl.bindVertexArray(grainVao);
    gl.uniform1f(ug.shadow, 1);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.uniform1f(ug.shadow, 0);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.bindVertexArray(null);
  }

  requestAnimationFrame(frame);

  function addRipple(x: number, z: number, strength: number, rgb: [number, number, number]): void {
    const i = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    ripples[i * 4] = x;
    ripples[i * 4 + 1] = z;
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
      noiseFigure = index + 5;
    },
    strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null) {
      energy = Math.min(1.2, energy + STRIKE_ENERGY[kind]);
      const at = clientX != null && clientY != null ? floorAt(clientX, clientY) : null;
      const [x, z] = at && Math.hypot(at[0], at[1]) < 2.5 ? at : [0, 0];
      addRipple(x, z, kind === "miss" ? 1.1 : 0.9, GRADE_RGB[kind]);
      if (kind === "miss") {
        for (let i = 0; i < COUNT; i++) {
          vx[i]! += (Math.random() - 0.5) * 0.5;
          vz[i]! += (Math.random() - 0.5) * 0.5;
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

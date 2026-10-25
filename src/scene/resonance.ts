// The Resonance scene, in Three.js: a bed of red, orange and purple sand on an endless white
// floor that behaves like a liquid surface. Everything runs on the GPU:
//
// - The floor is a displaced mesh. Its height is an analytic function (`surface` below): ripples
//   travelling out from each tap, plus the plate's standing Chladni wave while it rings.
// - The sand is a GPGPU particle system (position and velocity textures). Grains ride the
//   surface, drift toward the Chladni figure's still lines, flow with a slow curl-noise current
//   (the "liquid" in liquid sand), and levitate on the vibrating parts — higher the more in
//   tempo the playing is. Holding a note lifts the bed; releasing drops it with a splash; rests
//   let it settle flat.
// - Grains are drawn as lit spheres (impostors) with soft shadows on the floor.

import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import type { Grade } from "../types";

export type StrikeKind = Grade | "neutral";
export type HoldState = "filling" | "ready" | "over";

export interface Scene {
  /** Where the sand bed sits on screen, in viewport CSS px: its centre and half-width. */
  setPlate(cx: number, cy: number, radius: number): void;
  /** Which Chladni figure the sand is drawn toward (any integer; wraps around the mode list). */
  setFigure(index: number): void;
  /**
   * A tap landed: a wave on the floor under the tap point (or the centre) and an energy kick.
   * `quarters` is the note's written length: longer notes send broader, slower waves.
   */
  strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null, quarters?: number): void;
  /** A held note let go: the lifted sand drops back with a soft splash. */
  release(kind?: StrikeKind): void;
  /** A held note in progress (0..1 of its written length), or null when nothing is held. */
  setHold(hold: { progress: number; state: HoldState } | null): void;
  /** True while the music is in a rest: the sand settles flat and the floor calms. */
  setRest(active: boolean): void;
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
  /** Clear the reveal, hold and rest state. */
  reset(): void;
  /** Numbers for debugging in the browser console. */
  debug?(): Record<string, number>;
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

/** Grade colours, shared with the staff: purple clean, light purple good, orange close, red miss. */
const GRADE_RGB: Record<StrikeKind, [number, number, number]> = {
  perfect: [0.42, 0.25, 0.63],
  good: [0.64, 0.4, 0.78],
  ok: [0.94, 0.6, 0.24],
  miss: [0.82, 0.23, 0.23],
  neutral: [0.45, 0.4, 0.5],
};
const STRIKE_ENERGY: Record<StrikeKind, number> = { perfect: 0.85, good: 0.7, ok: 0.55, miss: 0.6, neutral: 0.45 };

const MAX_RIPPLES = 8;
const BG = new THREE.Color("#f6f3ed");

/** Shared GLSL: the liquid floor height and the Chladni field. */
const SURFACE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${MAX_RIPPLES}];   // x, z, age (s), strength
uniform vec2 uRippleShape[${MAX_RIPPLES}]; // wavelength, speed
uniform float uStanding;                  // standing-wave amplitude
uniform vec3 uModeA;
uniform vec3 uModeB;
uniform vec3 uModeN;
uniform vec3 uModeW;                      // weights: current, previous, noise

const float PI = 3.14159265;

float chladniMode(vec2 p, vec3 m) {
  return cos(m.x * PI * p.x) * cos(m.y * PI * p.y) + m.z * cos(m.y * PI * p.x) * cos(m.x * PI * p.y);
}
float chladni(vec2 p) {
  return chladniMode(p, uModeA) * uModeW.x + chladniMode(p, uModeB) * uModeW.y + chladniMode(p, uModeN) * uModeW.z;
}

float surface(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    vec2 shape = uRippleShape[i];
    float d = length(p - r.xy);
    float front = r.z * shape.y;
    float k = 6.2831853 / shape.x;
    // A damped wave train behind the front, fading with age and distance.
    float env = smoothstep(front + shape.x * 0.5, front - shape.x * 0.2, d) * exp(-max(front - d, 0.0) * 1.8);
    h += sin((d - front) * k) * env * r.w * exp(-r.z * 1.3) / (1.0 + d * 1.5);
  }
  float bed = 1.0 - smoothstep(0.9, 1.35, length(p));
  h += chladni(p) * uStanding * sin(uTime * 9.0) * bed;
  return h;
}
`;

const NOISE_GLSL = /* glsl */ `
vec3 hash3(vec2 p) {
  vec3 q = vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)));
  return fract(sin(q) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1, 0), vec2(12.9898, 78.233))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0, 1), vec2(12.9898, 78.233))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1, 1), vec2(12.9898, 78.233))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Divergence-free flow from the curl of a scalar noise field: the slow "liquid" current.
vec2 curl(vec2 p) {
  float e = 0.05;
  float n1 = vnoise(p + vec2(0, e)), n2 = vnoise(p - vec2(0, e));
  float n3 = vnoise(p + vec2(e, 0)), n4 = vnoise(p - vec2(e, 0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform float uDt;
uniform float uEnergy;
uniform float uLift;
uniform float uFlow;
uniform float uSettle;
${SURFACE_GLSL}
${NOISE_GLSL}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  vec2 p = pos.xz;
  float seed = pos.w;

  float f = chladni(p);
  vec2 e = vec2(0.004, 0.0);
  vec2 grad = vec2(chladni(p + e.xy) - chladni(p - e.xy), chladni(p + e.yx) - chladni(p - e.yx)) / (2.0 * e.x);

  vec3 acc = vec3(0.0);
  // Drift toward the still lines, gently shaken loose on the vibrating parts.
  acc.xz += -f * grad * 3.0 * uEnergy;
  vec3 rnd = hash3(uv * 917.0 + fract(uTime * 13.7)) - 0.5;
  acc.xz += rnd.xz * (abs(f) + 0.14) * uEnergy * 2.6;
  // The liquid current.
  // Kept weak: grains held on the lines would bunch up where a stronger current converges.
  acc.xz += curl(p * 1.7 + uTime * 0.12) * uFlow * 0.05;

  // Ripples push grains outward as they pass, like a wave through wet sand.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float front = r.z * uRippleShape[i].y;
    float ring = exp(-pow((dist - front) / (uRippleShape[i].x * 0.35), 2.0)) * exp(-r.z * 1.6) * r.w;
    acc.xz += d / dist * ring * 0.6;
    acc.y += ring * 2.2;
  }

  // Vertical: a spring toward the floor plus the levitation height for this grain's spot.
  float floorY = surface(p);
  // One smooth hovering sheet: the bob varies across the bed, barely from grain to grain.
  float bob = 0.72 + 0.28 * sin(uTime * 2.2 + (p.x - p.y) * 2.4) * cos(uTime * 1.3 + (p.x + p.y) * 1.7);
  // The whole figure rises together, a little higher where the plate vibrates most.
  float target = floorY + uLift * (0.16 * bob + 0.05 * min(abs(f), 1.6)) * (0.92 + 0.16 * fract(seed * 7.13));
  acc.y += (target - pos.y) * mix(28.0, 60.0, uSettle) - vel.y * mix(5.0, 11.0, uSettle);

  // Keep the bed together: a soft wall past its edge.
  float r = length(p);
  if (r > 0.97) acc.xz -= p / r * (r - 0.97) * 40.0;

  vel.xyz += acc * uDt;
  vel.xz *= exp(-uDt * mix(6.0, 12.0, uSettle));
  // w carries the floor height under the grain, so later passes needn't recompute it.
  vel.w = floorY;
  gl_FragColor = vel;
}
`;

const POSITION_SHADER = /* glsl */ `
uniform float uDt;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  pos.xyz += vel.xyz * uDt;
  pos.y = max(pos.y, vel.w - 0.002);
  gl_FragColor = pos;
}
`;

const GRAIN_VERT = /* glsl */ `
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform float uSize;
uniform float uShadow;
uniform vec3 uLightDir;
uniform float uDim;
attribute vec2 aRef;
varying vec3 vColor;
varying float vAlpha;
varying float vLift;

const vec3 PALETTE[6] = vec3[6](
  vec3(0.84, 0.25, 0.2), vec3(0.93, 0.44, 0.19), vec3(0.96, 0.59, 0.27),
  vec3(0.59, 0.27, 0.67), vec3(0.42, 0.24, 0.63), vec3(0.78, 0.24, 0.43));

void main() {
  vec4 data = texture2D(uPositions, aRef);
  vec3 p = data.xyz;
  float seed = data.w;
  float floorY = texture2D(uVelocities, aRef).w;
  float lift = max(0.0, p.y - floorY);
  vLift = lift;
  if (uShadow > 0.5) {
    p.xz += uLightDir.xz * lift;
    p.y = floorY + 0.002;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float r = length(data.xz);
  float edge = 1.0 - smoothstep(0.9, 1.0, r);
  float scale = 0.7 + 0.6 * fract(seed * 13.37);
  if (uShadow > 0.5) {
    // Shadows soften as the sand rises, but stay small: they are the most overdrawn layer.
    gl_PointSize = uSize * (1.5 + min(lift, 0.25) * 3.0) * scale / -mv.z;
    vAlpha = (0.085 * (1.0 - smoothstep(0.02, 0.35, lift)) + 0.025) * edge * (1.0 - uDim * 0.7);
    vColor = vec3(0.2, 0.14, 0.24);
  } else {
    gl_PointSize = uSize * scale / -mv.z;
    vec3 c = PALETTE[int(mod(floor(seed * 6000.0), 6.0))];
    vColor = c * (0.85 + 0.3 * fract(seed * 91.7));
    vAlpha = edge * (1.0 - uDim * 0.75);
  }
}
`;

const GRAIN_FRAG = /* glsl */ `
uniform float uShadow;
uniform vec3 uLightDir;
varying vec3 vColor;
varying float vAlpha;
varying float vLift;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (uShadow > 0.5) {
    float a = smoothstep(1.0, 0.0, r2) * vAlpha;
    gl_FragColor = vec4(vColor, a);
    return;
  }
  if (r2 > 1.0 || vAlpha < 0.02) discard;
  // A lit bead: sphere normal from the sprite, soft key light, warm fill, a little sheen.
  vec3 n = vec3(d.x, -d.y, sqrt(1.0 - r2));
  vec3 l = normalize(vec3(-0.4, 0.75, 0.55));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), vec3(0, 0, 1)), 0.0), 24.0);
  vec3 col = vColor * (0.42 + 0.72 * diff) + vec3(1.0, 0.96, 0.9) * spec * (0.25 + vLift * 2.0);
  gl_FragColor = vec4(col, vAlpha);
}
`;

const FLOOR_VERT = /* glsl */ `
${SURFACE_GLSL}
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec3 p = position.xzy * vec3(1.0, 0.0, -1.0);
  vNormal2 = vec3(0.0, 1.0, 0.0);
  // Waves never travel far from the bed: skip the work out there.
  if (length(p.xz) < 4.0) {
    float e = 0.03;
    float h0 = surface(p.xz);
    float hx = surface(p.xz + vec2(e, 0.0)) - h0;
    float hz = surface(p.xz + vec2(0.0, e)) - h0;
    p.y = h0;
    vNormal2 = normalize(vec3(-hx, e, -hz));
  }
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uFogNearFar;  // near, far, unused
uniform vec3 uHold;        // progress, state (1 filling, 2 ready, 3 over), visibility
uniform vec3 uRippleColor[${MAX_RIPPLES}];
uniform float uDim;
uniform float uReveal;
${SURFACE_GLSL}
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec3 n = normalize(vNormal2);
  vec3 l = normalize(vec3(-0.4, 0.85, 0.45));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), viewDir), 0.0), 60.0);
  vec3 col = vec3(0.972, 0.962, 0.945) * (0.86 + 0.16 * diff) + vec3(1.0) * spec * 0.35;

  vec2 p = vWorld.xz;
  float r = length(p);
  // A faint warm bed where the sand lies, warmer at the reveal.
  col *= 1.0 - 0.025 * exp(-r * r * 1.3);
  col += vec3(0.03, 0.012, -0.01) * exp(-r * r * 1.1) * uReveal;

  // Ripple tint: each wave front carries its grade colour faintly.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 rp = uRipples[i];
    if (rp.w <= 0.0) continue;
    float d = length(p - rp.xy);
    float front = rp.z * uRippleShape[i].y;
    float ring = exp(-pow((d - front) / (uRippleShape[i].x * 0.25), 2.0)) * exp(-rp.z * 1.8) * rp.w;
    col = mix(col, uRippleColor[i], clamp(ring * 0.28, 0.0, 0.5));
  }

  // Hold ring on the floor around the bed, sweeping clockwise from the back.
  if (uHold.z > 0.001) {
    float band = exp(-pow((r - 1.14) / 0.01, 2.0));
    float ang = atan(p.x, -p.y);
    float a01 = fract(ang / 6.2831853 + 1.0);
    float filled = step(a01, clamp(uHold.x, 0.0, 1.0));
    vec3 holdCol = uHold.y > 2.5 ? vec3(0.82, 0.23, 0.23) : uHold.y > 1.5 ? vec3(0.17, 0.12, 0.2) : vec3(0.42, 0.25, 0.63);
    col = mix(col, vec3(0.17, 0.12, 0.2), band * 0.07 * uHold.z);
    col = mix(col, holdCol, band * filled * uHold.z * 0.9);
  }

  float dist = length(cameraPosition - vWorld);
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, dist);
  col = mix(col, uBg, fog);
  col = mix(col, uBg, uDim * 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

function noopScene(): Scene {
  return {
    supported: false,
    setPlate() {},
    setFigure() {},
    strike() {},
    release() {},
    setHold() {},
    setRest() {},
    setCoherence() {},
    setAmbient() {},
    setDim() {},
    scatter() {},
    reveal() {},
    reset() {},
  };
}

function modeVec(index: number): THREE.Vector3 {
  const m = MODES[((index % MODES.length) + MODES.length) % MODES.length]!;
  return new THREE.Vector3(m[0], m[1], m[2]);
}

export function createScene(canvas: HTMLCanvasElement): Scene {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    console.warn("resonance: WebGL unavailable", err);
    return noopScene();
  }
  if (!renderer.capabilities.isWebGL2) return noopScene();

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const SIM_W = 256;
  const SIM_H = mobile ? 128 : 256;
  const COUNT = SIM_W * SIM_H;

  // Render resolution adapts to the device: it starts at up to 1.5x and steps down when frames
  // run long (see the frame loop). The UI is DOM, so only the scene gets softer.
  const RATIOS = [1.5, 1.25, 1, 0.8].filter((r) => r <= Math.max(1, window.devicePixelRatio || 1));
  let ratioStep = 0;
  renderer.setPixelRatio(RATIOS[0] ?? 1);
  renderer.setClearColor(BG, 1);

  const scene = new THREE.Scene();
  scene.background = BG;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  camera.position.set(0, 0.78, 3.2);
  camera.lookAt(0, 0.02, 0);

  // ---- Shared uniforms (one object, referenced by every material) ----
  const ripples = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0));
  const rippleShape = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector2(0.4, 0.8));
  const rippleColor = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3(0.5, 0.5, 0.5));
  const shared = {
    uTime: { value: 0 },
    uRipples: { value: ripples },
    uRippleShape: { value: rippleShape },
    uStanding: { value: 0 },
    uModeA: { value: modeVec(0) },
    uModeB: { value: modeVec(0) },
    uModeN: { value: modeVec(5) },
    uModeW: { value: new THREE.Vector3(1, 0, 0) },
  };

  // ---- GPGPU sand ----
  const gpu = new GPUComputationRenderer(SIM_W, SIM_H, renderer);
  if (!renderer.extensions.has("EXT_color_buffer_float")) gpu.setDataType(THREE.HalfFloatType);
  const pos0 = gpu.createTexture();
  const vel0 = gpu.createTexture();
  const posData = pos0.image.data as unknown as Float32Array;
  function fillScatter(data: Float32Array): void {
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.96;
      data[i * 4] = Math.cos(a) * r;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = Math.sin(a) * r;
      data[i * 4 + 3] = Math.random();
    }
  }
  fillScatter(posData);

  const posVar: Variable = gpu.addVariable("texturePosition", POSITION_SHADER, pos0);
  const velVar: Variable = gpu.addVariable("textureVelocity", VELOCITY_SHADER, vel0);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  const simUniforms = {
    uDt: { value: 1 / 60 },
    uEnergy: { value: 0 },
    uLift: { value: 0 },
    uFlow: { value: 0 },
    uSettle: { value: 0 },
  };
  Object.assign(velVar.material.uniforms, shared, simUniforms);
  Object.assign(posVar.material.uniforms, { uDt: simUniforms.uDt });
  const gpuError = gpu.init();
  if (gpuError !== null) {
    console.warn("resonance: GPU simulation unavailable", gpuError);
    renderer.dispose();
    return noopScene();
  }

  // ---- Floor: a big displaced plane fading into the background ----
  const floorGeo = new THREE.PlaneGeometry(26, 26, 208, 208);
  const fogNearFar = new THREE.Vector3(4, 10.5, 0);
  const holdU = new THREE.Vector3(0, 1, 0);
  const floorUniforms = {
    ...shared,
    // Shader output is written as-is (no colour management), so the fog colour must be the
    // background in display (sRGB) values, not Three's linear ones.
    uBg: { value: (() => { const c = BG.clone().convertLinearToSRGB(); return new THREE.Vector3(c.r, c.g, c.b); })() },
    uFogNearFar: { value: fogNearFar },
    uHold: { value: holdU },
    uRippleColor: { value: rippleColor },
    uDim: { value: 0 },
    uReveal: { value: 0 },
  };
  const floor = new THREE.Mesh(floorGeo, new THREE.ShaderMaterial({ vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, uniforms: floorUniforms }));
  floor.frustumCulled = false;
  scene.add(floor);

  // ---- Grains: one point per sim texel, read from the position texture ----
  const refs = new Float32Array(COUNT * 2);
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      const i = y * SIM_W + x;
      refs[i * 2] = (x + 0.5) / SIM_W;
      refs[i * 2 + 1] = (y + 0.5) / SIM_H;
    }
  }
  const grainGeo = new THREE.BufferGeometry();
  grainGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
  grainGeo.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
  const grainUniforms = {
    ...shared,
    uPositions: { value: null as THREE.Texture | null },
    uVelocities: { value: null as THREE.Texture | null },
    uSize: { value: 10 },
    uShadow: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0.45, 0, 0.6) },
    uDim: { value: 0 },
  };
  const grains = new THREE.Points(grainGeo, new THREE.ShaderMaterial({ vertexShader: GRAIN_VERT, fragmentShader: GRAIN_FRAG, uniforms: grainUniforms, transparent: true, depthWrite: true }));
  grains.frustumCulled = false;
  grains.renderOrder = 2;
  const shadowUniforms = { ...grainUniforms, uShadow: { value: 1 } };
  const shadows = new THREE.Points(
    grainGeo,
    new THREE.ShaderMaterial({ vertexShader: GRAIN_VERT, fragmentShader: GRAIN_FRAG, uniforms: shadowUniforms, transparent: true, depthWrite: false }),
  );
  shadows.frustumCulled = false;
  shadows.renderOrder = 1;
  scene.add(shadows, grains);

  // ---- State ----
  const plate = { cx: 0, cy: 0, r: 100 };
  const plateTarget = { cx: 0, cy: 0, r: 100 };
  let plateInit = false;
  let energy = 0;
  let ambient = 0;
  let coherence = 1;
  let lift = 0;
  let dim = 0;
  let dimTarget = 0;
  let reveal = 0;
  let revealTarget = 0;
  let resting = false;
  let settle = 0;
  let hold: { progress: number; state: HoldState } | null = null;
  let holdVis = 0;
  let holdLift = 0;
  let figure = 0;
  let prevFigure = 0;
  let morph = 1;
  let noiseFigure = 5;
  let rippleCursor = 0;
  let idleRippleAt = 0;

  function addRipple(x: number, z: number, strength: number, wavelength: number, speed: number, rgb: [number, number, number]): void {
    const i = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    ripples[i]!.set(x, z, 0, strength);
    rippleShape[i]!.set(wavelength, speed);
    rippleColor[i]!.set(rgb[0], rgb[1], rgb[2]);
  }

  // ---- Layout: fit the bed onto the slot the current screen reserved for it ----
  const tmp = new THREE.Vector3();
  function projectPx(x: number, y: number, z: number): [number, number] {
    tmp.set(x, y, z).project(camera);
    return [(tmp.x * 0.5 + 0.5) * window.innerWidth, (-tmp.y * 0.5 + 0.5) * window.innerHeight];
  }
  function fitCamera(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.zoom = 1;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const left = projectPx(-1, 0, 0);
    const right = projectPx(1, 0, 0);
    const spanPx = right[0] - left[0];
    camera.zoom = spanPx > 0 ? (2 * plate.r) / spanPx : 1;
    camera.updateProjectionMatrix();
    const c = projectPx(0, 0, 0);
    camera.setViewOffset(w, h, c[0] - plate.cx, c[1] - plate.cy, w, h);
    camera.updateProjectionMatrix();
  }
  function resize(): void {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  resize();
  window.addEventListener("resize", resize);

  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function floorAt(clientX: number, clientY: number): [number, number] | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(floorPlane, tmp);
    return hit ? [hit.x, hit.z] : null;
  }

  // ---- Frame loop ----
  let last = performance.now();
  const startedAt = last;
  let slowFrames = 0;
  let fastFrames = 0;
  function adaptQuality(frameMs: number): void {
    if (document.hidden) return;
    if (frameMs > 22) slowFrames++;
    else if (frameMs < 14) fastFrames++;
    if (slowFrames > 90 && ratioStep < RATIOS.length - 1) {
      ratioStep++;
      renderer.setPixelRatio(RATIOS[ratioStep]!);
      resize();
      slowFrames = 0;
      fastFrames = 0;
    } else if (fastFrames > 600 && ratioStep > 0) {
      ratioStep--;
      renderer.setPixelRatio(RATIOS[ratioStep]!);
      resize();
      slowFrames = 0;
      fastFrames = 0;
    }
    if (slowFrames + fastFrames > 1200) {
      slowFrames = 0;
      fastFrames = 0;
    }
  }

  function frame(now: number): void {
    const frameMs = now - last;
    const dt = Math.min(1 / 30, Math.max(1 / 240, frameMs / 1000));
    last = now;
    adaptQuality(frameMs);
    const time = (now - startedAt) / 1000;

    const ease = 1 - Math.exp(-dt * 6);
    plate.cx += (plateTarget.cx - plate.cx) * ease;
    plate.cy += (plateTarget.cy - plate.cy) * ease;
    plate.r += (plateTarget.r - plate.r) * ease;
    dim += (dimTarget - dim) * ease;
    reveal += (revealTarget - reveal) * (1 - Math.exp(-dt * 1.2));
    morph = Math.min(1, morph + dt * 0.6);
    settle += ((resting ? 1 : 0) - settle) * (1 - Math.exp(-dt * 6));

    // Holding keeps the plate ringing and slowly raises the bed; a rest calms everything.
    if (hold && hold.state !== "over") energy = Math.max(energy, 0.45 + 0.25 * hold.progress);
    holdLift += ((hold && hold.state !== "over" ? 0.35 + 0.65 * hold.progress : 0) - holdLift) * (1 - Math.exp(-dt * (hold ? 3 : 8)));
    energy *= Math.exp(-dt * (reducedMotion ? 3 : 1.5 + settle * 3));
    const tempo = coherence * coherence;
    const liftTarget = (reducedMotion ? 0.4 : 1) * (Math.min(1, energy) * tempo * (1 - settle * 0.85) + holdLift * tempo * 0.8 + ambient * 0.3 + reveal * 0.55);
    lift += (liftTarget - lift) * (1 - Math.exp(-dt * 4));
    holdVis += ((hold ? 1 : 0) - holdVis) * (1 - Math.exp(-dt * (hold ? 20 : 5)));
    if (hold) holdU.set(hold.progress, hold.state === "filling" ? 1 : hold.state === "ready" ? 2 : 3, holdVis);
    else holdU.z = holdVis;

    // The home screen breathes: an occasional slow drop somewhere on the bed.
    if (ambient > 0.05 && time > idleRippleAt) {
      idleRippleAt = time + 2.2 + Math.random() * 2.5;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.8;
      addRipple(Math.cos(a) * rr, Math.sin(a) * rr, 0.012 + Math.random() * 0.01, 0.35, 0.55, GRADE_RGB.neutral);
    }

    for (const r of ripples) {
      if (r.w > 0) {
        r.z += dt;
        if (r.z > 4) r.w = 0;
      }
    }

    // Mode weights: crossfade between figures, blurred by a competing mode when playing is off.
    const noiseW = (1 - coherence) * 0.85;
    shared.uModeW.value.set(morph * (1 - noiseW), (1 - morph) * (1 - noiseW), noiseW);
    shared.uStanding.value = 0.012 * Math.min(1, Math.max(energy, ambient * 0.4)) * (1 - settle);
    shared.uTime.value = time;

    simUniforms.uDt.value = dt;
    simUniforms.uEnergy.value = Math.max(energy, ambient) * (1 - settle * 0.7);
    simUniforms.uLift.value = lift;
    simUniforms.uFlow.value = (0.15 + Math.max(energy, ambient)) * (1 - settle * 0.8);
    simUniforms.uSettle.value = settle;
    gpu.compute();
    grainUniforms.uPositions.value = gpu.getCurrentRenderTarget(posVar).texture;
    grainUniforms.uVelocities.value = gpu.getCurrentRenderTarget(velVar).texture;

    floorUniforms.uDim.value = dim;
    floorUniforms.uReveal.value = reveal;
    grainUniforms.uDim.value = dim;
    fitCamera();
    // Point size in pixels for a grain of fixed world size, through the current projection.
    const grainWorld = mobile ? 0.013 : 0.0095;
    grainUniforms.uSize.value = grainWorld * camera.projectionMatrix.elements[5]! * renderer.domElement.height * 0.5;

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function scatter(): void {
    const tex = gpu.createTexture();
    fillScatter(tex.image.data as unknown as Float32Array);
    gpu.renderTexture(tex, posVar.renderTargets[0]!);
    gpu.renderTexture(tex, posVar.renderTargets[1]!);
  }

  return {
    supported: true,
    debug: () => ({
      zoom: camera.zoom,
      proj5: camera.projectionMatrix.elements[5]!,
      uSize: grainUniforms.uSize.value,
      canvasH: renderer.domElement.height,
      plateR: plate.r,
      lift,
      energy,
      count: COUNT,
      pixelRatio: renderer.getPixelRatio(),
    }),
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
      shared.uModeB.value.copy(modeVec(prevFigure));
      shared.uModeA.value.copy(modeVec(figure));
      shared.uModeN.value.copy(modeVec(noiseFigure));
    },
    strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null, quarters = 1) {
      energy = Math.min(1.3, energy + STRIKE_ENERGY[kind]);
      resting = false;
      const at = clientX != null && clientY != null ? floorAt(clientX, clientY) : null;
      const [x, z] = at && Math.hypot(at[0], at[1]) < 2.2 ? at : [0, 0];
      const q = Math.max(0.25, Math.min(4, quarters));
      // Short notes: tight, quick ripples. Long notes: a broad, slow swell.
      const wavelength = 0.22 + 0.12 * Math.sqrt(q);
      const speed = 0.9 + 0.25 * Math.sqrt(q);
      const strength = (kind === "miss" ? 0.05 : 0.035) * (0.8 + 0.35 * Math.sqrt(q));
      addRipple(x, z, strength, wavelength, speed, GRADE_RGB[kind]);
    },
    release(kind: StrikeKind = "neutral") {
      addRipple(0, 0, 0.02, 0.5, 0.7, GRADE_RGB[kind]);
    },
    setHold(next) {
      hold = next;
    },
    setRest(active: boolean) {
      resting = active;
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
      resting = false;
      energy = Math.max(energy, 0.5);
      ambient = reducedMotion ? 0.08 : 0.22;
      addRipple(0, 0, 0.05 * q + 0.01, 0.6, 0.6, GRADE_RGB.perfect);
    },
    reset() {
      revealTarget = 0;
      hold = null;
      resting = false;
      coherence = 1;
    },
  };
}

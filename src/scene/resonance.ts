// The Resonance scene, in Three.js: an abstract white space. In the middle lies a bed of fine
// red, orange and purple pigment sand, and sparse neutral motes drift through the air around it. Playing makes the ground resonate: the pigment
// sorts itself into a Chladni figure, waves roll out from each tap, and when the playing is in
// tempo the sand lifts off the figure in thin flowing veils that curl and drift back down.
//
// Everything runs on the GPU:
// - Void: a soft white gradient with no horizon; the ground is invisible except for the light
//   and shadow that fall on it (ripples, the hold ring, the dust shadow).
// - Motes: a few thousand neutral specks drifting slowly at many depths.
// - Pigment: a GPGPU particle system (position and velocity textures). Motion uses smooth noise
//   fields only, never per-frame random kicks, so grains glide instead of flickering.
// - Dust shadow: airborne pigment is splatted into a small top-down texture that the ground
//   samples, blurred, as one soft shared shadow.

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
   * A tap landed: a wave on the ground under the tap point (or the centre) and an energy kick.
   * `quarters` is the note's written length: longer notes send broader, slower waves.
   */
  strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null, quarters?: number): void;
  /** A held note let go: the lifted sand drifts back down with a soft wave. */
  release(kind?: StrikeKind): void;
  /** A held note in progress (0..1 of its written length), or null when nothing is held. */
  setHold(hold: { progress: number; state: HoldState } | null): void;
  /** True while the music is in a rest: the sand settles and the ground calms. */
  setRest(active: boolean): void;
  /** 0..1: how in-tempo and clean the playing is. High lifts the sand; low blurs the figure. */
  setCoherence(value: number): void;
  /** Background energy that keeps the sand gently moving (the home screen's idle state). */
  setAmbient(level: number): void;
  /** 0..1: how much the scene fades back behind UI. */
  setDim(value: number): void;
  /** Scatter the sand evenly. */
  scatter(): void;
  /** End of a run: the sand rises and settles into the figure. `quality` is 0..1. */
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
  neutral: [0.55, 0.45, 0.4],
};
const STRIKE_ENERGY: Record<StrikeKind, number> = { perfect: 0.85, good: 0.7, ok: 0.55, miss: 0.6, neutral: 0.45 };

const MAX_RIPPLES = 8;
/** World half-size of the top-down dust shadow texture, centred on the bed. */
const SHADOW_EXTENT = 1.8;

/** Light and air, in display (sRGB) values: shader output is written without colour management. */
const COLORS_GLSL = /* glsl */ `
const vec3 SUN_DIR = normalize(vec3(-0.45, 0.8, 0.35));
const vec3 SUN = vec3(1.0, 0.98, 0.95);
const vec3 SKY_AMBIENT = vec3(0.85, 0.85, 0.87);
// The void: near-white, a touch warmer and darker low down, with no horizon line.
const vec3 VOID_TOP = vec3(0.976, 0.973, 0.966);
const vec3 VOID_LOW = vec3(0.945, 0.94, 0.93);
const vec3 HAZE = VOID_LOW;
`;

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
// Divergence-free flow from the curl of a scalar noise field.
vec2 curl(vec2 p) {
  float e = 0.08;
  float n1 = vnoise(p + vec2(0, e)), n2 = vnoise(p - vec2(0, e));
  float n3 = vnoise(p + vec2(e, 0)), n4 = vnoise(p - vec2(e, 0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}
`;

/** Shared GLSL: the bed's liquid ground (ripples + standing wave) and the Chladni field. */
const SURFACE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${MAX_RIPPLES}];     // x, z, age (s), strength
uniform vec2 uRippleShape[${MAX_RIPPLES}]; // wavelength, speed
uniform float uStanding;
uniform vec3 uModeA;
uniform vec3 uModeB;
uniform vec3 uModeN;
uniform vec3 uModeW;

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
    float env = smoothstep(front + shape.x * 0.5, front - shape.x * 0.2, d) * exp(-max(front - d, 0.0) * 1.8);
    h += sin((d - front) * k) * env * r.w * exp(-r.z * 1.3) / (1.0 + d * 1.5);
  }
  float bed = 1.0 - smoothstep(0.9, 1.35, length(p));
  h += chladni(p) * uStanding * sin(uTime * 9.0) * bed;
  return h;
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform float uDt;
uniform float uEnergy;
uniform float uLift;
uniform float uSettle;
${SURFACE_GLSL}
${NOISE_GLSL}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  vec2 p = pos.xz;
  float seed = pos.w;

  float floorY = surface(p);
  float height = max(pos.y - floorY, 0.0);
  // 1 for grains lying on the ground, 0 for grains in the air.
  // Only clearly airborne grains follow the air current; low ones still count as lying sand.
  float air = smoothstep(0.06, 0.16, height);
  float ground = 1.0 - air;

  float f = chladni(p);
  vec2 e = vec2(0.004, 0.0);
  vec2 grad = vec2(chladni(p + e.xy) - chladni(p - e.xy), chladni(p + e.yx) - chladni(p - e.yx)) / (2.0 * e.x);

  vec3 acc = vec3(0.0);
  // On the ground: drift toward the still lines, stirred by a smooth (never random) shimmer.
  acc.xz += -f * grad * 3.2 * uEnergy * ground;
  // A tiny jiggle where the ground vibrates. Uncorrelated from grain to grain, so it can never
  // herd grains into clumps the way any smooth current does; at this grain size it reads as
  // shimmer, not flicker.
  vec2 jiggle = vec2(hash12(uv * 811.0 + uTime * 61.7), hash12(uv * 577.0 - uTime * 43.1)) - 0.5;
  acc.xz += jiggle * (abs(f) + 0.08) * uEnergy * 5.0 * ground;

  // In the air: an even, gentle breeze that slowly turns, so veils drift without pooling.
  vec2 breeze = vec2(cos(uTime * 0.07), sin(uTime * 0.05)) * 0.12;
  acc.xz += breeze * air * (0.4 + uLift);

  // Ripples push and lift grains as they pass, like a wave through dry sand.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float front = r.z * uRippleShape[i].y;
    float ring = exp(-pow((dist - front) / (uRippleShape[i].x * 0.35), 2.0)) * exp(-r.z * 1.6) * r.w;
    acc.xz += d / dist * ring * 0.5;
    acc.y += ring * 2.0;
  }

  // Vertical: a soft spring toward a flowing height field. When the playing is in tempo the
  // field rises into thin veils, highest above the vibrating parts; otherwise it is the ground.
  float veil = vnoise(p * 1.6 + vec2(uTime * 0.13, -uTime * 0.09) + seed * 0.15);
  veil = smoothstep(0.25, 0.95, veil);
  float target = floorY + min(uLift, 0.85) * (0.02 + 0.26 * veil * (0.55 + 0.6 * min(abs(f), 1.0))) * (0.8 + 0.4 * fract(seed * 7.13));
  acc.y += (target - pos.y) * mix(9.0, 30.0, uSettle) - vel.y * mix(3.5, 8.0, uSettle);

  // Keep the bed together: grounded grains are held inside it; airborne ones are drawn back.
  float r = length(p);
  if (r > 0.97) acc.xz -= p / r * (r - 0.97) * mix(4.0, 40.0, ground);

  vel.xyz += acc * uDt;
  vel.xz *= exp(-uDt * mix(2.5, mix(6.0, 12.0, uSettle), ground));
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
  pos.y = max(pos.y, vel.w);
  gl_FragColor = pos;
}
`;

const PIGMENT_VERT = /* glsl */ `
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform float uSize;
uniform float uDim;
uniform float uReveal;
attribute vec2 aRef;
varying vec4 vColor;
${COLORS_GLSL}

const vec3 PALETTE[6] = vec3[6](
  vec3(0.78, 0.22, 0.17), vec3(0.88, 0.4, 0.16), vec3(0.93, 0.56, 0.24),
  vec3(0.52, 0.24, 0.6), vec3(0.37, 0.21, 0.56), vec3(0.72, 0.21, 0.38));

void main() {
  vec4 data = texture2D(uPositions, aRef);
  vec3 p = data.xyz;
  float seed = data.w;
  float floorY = texture2D(uVelocities, aRef).w;
  float lift = max(0.0, p.y - floorY);
  float air = smoothstep(0.015, 0.12, lift);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float scale = 0.7 + 0.6 * fract(seed * 13.37);
  gl_PointSize = max(1.0, uSize * scale * mix(1.0, 0.8, air) / -mv.z);

  vec3 c = PALETTE[int(mod(floor(seed * 6000.0), 6.0))] * (0.86 + 0.28 * fract(seed * 91.7));
  // On the ground the pigment is matte; in the air light passes through it and the veil
  // turns lighter and softer.
  vec3 lit = c * (SUN * 0.7 + SKY_AMBIENT * 0.32);
  vec3 glow = mix(c, vec3(1.0), 0.22);
  vec3 col = mix(lit, glow, air);
  col = mix(col, col * 1.08 + vec3(0.04, 0.02, 0.0), uReveal * 0.5);
  float r = length(p.xz);
  float edge = 1.0 - smoothstep(1.02, 1.5, r);
  float alpha = mix(0.92, 0.42, air) * edge * (1.0 - uDim * 0.75);
  vColor = vec4(mix(col, VOID_TOP, uDim * 0.5), alpha);
}
`;

const PIGMENT_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.25, dot(d, d)) * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}
`;

/** Airborne pigment splatted top-down into the shadow texture. */
const SHADOW_SPLAT_VERT = /* glsl */ `
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
attribute vec2 aRef;
varying float vWeight;
${COLORS_GLSL}
void main() {
  vec4 data = texture2D(uPositions, aRef);
  float floorY = texture2D(uVelocities, aRef).w;
  float lift = max(0.0, data.y - floorY);
  // The shadow falls away from the sun, further the higher the grain floats.
  vec2 p = data.xz - SUN_DIR.xz / max(SUN_DIR.y, 0.2) * lift;
  gl_Position = vec4(p.x / ${SHADOW_EXTENT.toFixed(2)}, -p.y / ${SHADOW_EXTENT.toFixed(2)}, 0.0, 1.0);
  gl_PointSize = 4.0 + lift * 10.0;
  vWeight = smoothstep(0.02, 0.15, lift) * (1.0 - smoothstep(0.3, 0.6, lift)) * 0.005;
}
`;

const SHADOW_SPLAT_FRAG = /* glsl */ `
varying float vWeight;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, dot(d, d));
  gl_FragColor = vec4(vec3(vWeight * a), 1.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = p.xyww;
}
`;

const SKY_FRAG = /* glsl */ `
uniform float uDim;
varying vec3 vDir;
${COLORS_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = mix(VOID_LOW, VOID_TOP, smoothstep(-0.25, 0.45, d.y));
  col = mix(col, VOID_TOP, uDim * 0.4);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GROUND_VERT = /* glsl */ `
${SURFACE_GLSL}
varying vec3 vWorld;
varying vec3 vNormal2;
void main() {
  vec3 p = position;
  vNormal2 = vec3(0.0, 1.0, 0.0);
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

const GROUND_FRAG = /* glsl */ `
uniform vec3 uHold;
uniform vec3 uRippleColor[${MAX_RIPPLES}];
uniform float uDim;
uniform float uReveal;
uniform sampler2D uDustShadow;
varying vec3 vWorld;
varying vec3 vNormal2;
${COLORS_GLSL}
${SURFACE_GLSL}

void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  // The floor is the void itself; only what happens on it shows.
  vec3 view = normalize(toCam);
  vec3 col = VOID_LOW * 1.006;

  // Waves catch the light: faint shading where the liquid surface tilts.
  vec3 n = normalize(vNormal2);
  float shade = dot(n, SUN_DIR) - SUN_DIR.y;
  col *= 1.0 + shade * 0.35;

  // A whisper of contact shade under the bed grounds the sand in the space.
  col *= 1.0 - 0.035 * exp(-r * r * 1.6);
  col += vec3(0.02, 0.008, -0.004) * exp(-r * r * 1.1) * uReveal;

  // One soft shadow for all the dust in the air.
  vec2 suv = vec2(p.x, -p.y) / ${SHADOW_EXTENT.toFixed(2)} * 0.5 + 0.5;
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
    float o = 4.0 / 256.0;
    float sh = texture2D(uDustShadow, suv).r * 0.36;
    sh += (texture2D(uDustShadow, suv + vec2(o, 0)).r + texture2D(uDustShadow, suv - vec2(o, 0)).r) * 0.16;
    sh += (texture2D(uDustShadow, suv + vec2(0, o)).r + texture2D(uDustShadow, suv - vec2(0, o)).r) * 0.16;
    col *= 1.0 - min(sh, 0.1);
  }

  // Ripple fronts: a thin line of grade colour travelling out across the white.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 rp = uRipples[i];
    if (rp.w <= 0.0) continue;
    float d = length(p - rp.xy);
    float front = rp.z * uRippleShape[i].y;
    float ring = exp(-pow((d - front) / (uRippleShape[i].x * 0.08), 2.0)) * exp(-rp.z * 1.5) * rp.w;
    col = mix(col, uRippleColor[i], clamp(ring * 9.0, 0.0, 0.35));
  }

  // Hold ring traced around the bed.
  if (uHold.z > 0.001) {
    float band = exp(-pow((r - 1.16) / 0.006, 2.0));
    float ang = atan(p.x, -p.y);
    float a01 = fract(ang / 6.2831853 + 1.0);
    float filled = step(a01, clamp(uHold.x, 0.0, 1.0));
    vec3 holdCol = uHold.y > 2.5 ? vec3(0.82, 0.23, 0.23) : uHold.y > 1.5 ? vec3(0.17, 0.12, 0.2) : vec3(0.42, 0.25, 0.63);
    col = mix(col, vec3(0.17, 0.12, 0.2), band * 0.06 * uHold.z);
    col = mix(col, holdCol, band * filled * uHold.z * 0.85);
  }

  // Everything dissolves into the void with distance, so there is never a horizon.
  float fade = smoothstep(2.5, 9.0, dist);
  vec3 voidCol = mix(VOID_LOW, VOID_TOP, smoothstep(-0.25, 0.45, -view.y));
  col = mix(col, voidCol, fade);
  col = mix(col, VOID_TOP, uDim * 0.45);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Neutral motes: positions are a pure function of time, so they need no simulation. */
const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uStir;
uniform float uDim;
attribute vec4 aMote;   // home x, y, z, seed
varying float vAlpha;
float hash11(float n) { return fract(sin(n * 91.345) * 47453.21); }
void main() {
  float s = aMote.w;
  vec3 p = aMote.xyz;
  // Slow, independent drifting on looping paths; a tap stirs them a little.
  float t = uTime * (0.03 + 0.04 * hash11(s));
  p += vec3(sin(t * 6.2831 + s * 17.0), sin(t * 4.1 + s * 9.0) * 0.6, cos(t * 5.3 + s * 13.0)) * (0.25 + 0.35 * hash11(s + 1.0));
  p.y += sin(uTime * 0.9 + s * 40.0) * 0.02 * uStir;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = -mv.z;
  gl_PointSize = clamp(uSize * (0.6 + 0.8 * hash11(s + 2.0)) / depth, 1.0, 7.0);
  // Out-of-focus near and far, crisp around the bed's distance.
  float focus = exp(-pow((depth - 3.2) / 2.6, 2.0));
  vAlpha = (0.12 + 0.3 * focus) * (0.5 + 0.5 * hash11(s + 3.0)) * smoothstep(0.8, 2.2, depth) * (1.0 - uDim * 0.6);
}
`;

const MOTE_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, dot(d, d)) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.32, 0.3, 0.33), a);
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

/** A disc of rings, dense near the centre and sparse toward the horizon. */
function polarGround(rings: number, segments: number, inner: number, outer: number): THREE.BufferGeometry {
  const positions: number[] = [0, 0, 0];
  const growth = Math.log(outer / inner) / (rings - 1);
  for (let i = 0; i < rings; i++) {
    const r = inner * Math.exp(growth * i);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < segments; j++) index.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = 1 + i * segments + j;
      const b = 1 + i * segments + ((j + 1) % segments);
      const c = 1 + (i + 1) * segments + j;
      const d = 1 + (i + 1) * segments + ((j + 1) % segments);
      index.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  return geo;
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
  const SIM_W = mobile ? 256 : 512;
  const SIM_H = 256;
  const COUNT = SIM_W * SIM_H;

  // Render resolution adapts: up to 1.5x, stepping down when frames run long.
  const RATIOS = [1.5, 1.25, 1, 0.8].filter((r) => r <= Math.max(1, window.devicePixelRatio || 1));
  let ratioStep = 0;
  renderer.setPixelRatio(RATIOS[0] ?? 1);
  renderer.autoClear = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
  // A low, gallery-like view of the figure; there is no horizon to frame.
  const CAM_BASE = new THREE.Vector3(0, 0.75, 3.1);
  const LOOK_AT = new THREE.Vector3(0, 0.08, 0);
  camera.position.copy(CAM_BASE);
  camera.lookAt(LOOK_AT);

  // ---- Shared uniforms ----
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
  const dimU = { value: 0 };
  const revealU = { value: 0 };

  // ---- GPGPU pigment ----
  const gpu = new GPUComputationRenderer(SIM_W, SIM_H, renderer);
  if (!renderer.extensions.has("EXT_color_buffer_float")) gpu.setDataType(THREE.HalfFloatType);
  const pos0 = gpu.createTexture();
  const vel0 = gpu.createTexture();
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
  fillScatter(pos0.image.data as unknown as Float32Array);
  const posVar: Variable = gpu.addVariable("texturePosition", POSITION_SHADER, pos0);
  const velVar: Variable = gpu.addVariable("textureVelocity", VELOCITY_SHADER, vel0);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  const simUniforms = {
    uDt: { value: 1 / 60 },
    uEnergy: { value: 0 },
    uLift: { value: 0 },
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

  // ---- Sky ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: { uDim: dimU }, side: THREE.BackSide, depthWrite: false }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ---- Dust shadow target ----
  const shadowRT = new THREE.WebGLRenderTarget(256, 256, { type: THREE.HalfFloatType, depthBuffer: false });
  const refs = new Float32Array(COUNT * 2);
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      const i = y * SIM_W + x;
      refs[i * 2] = (x + 0.5) / SIM_W;
      refs[i * 2 + 1] = (y + 0.5) / SIM_H;
    }
  }
  const pigmentGeo = new THREE.BufferGeometry();
  pigmentGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
  pigmentGeo.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
  const texU = { uPositions: { value: null as THREE.Texture | null }, uVelocities: { value: null as THREE.Texture | null } };
  const shadowScene = new THREE.Scene();
  const splat = new THREE.Points(
    pigmentGeo,
    new THREE.ShaderMaterial({
      vertexShader: SHADOW_SPLAT_VERT,
      fragmentShader: SHADOW_SPLAT_FRAG,
      uniforms: texU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  splat.frustumCulled = false;
  shadowScene.add(splat);

  // ---- Ground ----
  const holdU = new THREE.Vector3(0, 1, 0);
  const ground = new THREE.Mesh(
    polarGround(110, 180, 0.03, 40),
    new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: { ...shared, uHold: { value: holdU }, uRippleColor: { value: rippleColor }, uDim: dimU, uReveal: revealU, uDustShadow: { value: shadowRT.texture } },
    }),
  );
  ground.frustumCulled = false;
  scene.add(ground);

  // ---- Pigment ----
  const pigmentUniforms = { ...texU, uSize: { value: 10 }, uDim: dimU, uReveal: revealU };
  const pigment = new THREE.Points(
    pigmentGeo,
    new THREE.ShaderMaterial({ vertexShader: PIGMENT_VERT, fragmentShader: PIGMENT_FRAG, uniforms: pigmentUniforms, transparent: true, depthWrite: false }),
  );
  pigment.frustumCulled = false;
  pigment.renderOrder = 2;
  scene.add(pigment);

  // ---- Motes ----
  const MOTES = mobile ? 1400 : 2600;
  const moteData = new Float32Array(MOTES * 4);
  for (let i = 0; i < MOTES; i++) {
    moteData[i * 4] = (Math.random() - 0.5) * 12;
    moteData[i * 4 + 1] = Math.random() * 2.6 - 0.1;
    moteData[i * 4 + 2] = -Math.random() * 12 + 2.5;
    moteData[i * 4 + 3] = Math.random() * 1000;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3));
  moteGeo.setAttribute("aMote", new THREE.BufferAttribute(moteData, 4));
  const moteUniforms = { uTime: shared.uTime, uSize: { value: 8 }, uStir: { value: 0 }, uDim: dimU };
  const motes = new THREE.Points(
    moteGeo,
    new THREE.ShaderMaterial({ vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, uniforms: moteUniforms, transparent: true, depthWrite: false }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = 3;
  scene.add(motes);

  // ---- State ----
  const plate = { cx: 0, cy: 0, r: 100 };
  const plateTarget = { cx: 0, cy: 0, r: 100 };
  let plateInit = false;
  let energy = 0;
  let ambient = 0;
  let coherence = 1;
  let lift = 0;
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
  let rippleCursor = 0;
  let idleRippleAt = 0;
  let drift = 0;

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
    camera.updateMatrixWorld();
    const left = projectPx(-1, 0, 0);
    const right = projectPx(1, 0, 0);
    const spanPx = Math.hypot(right[0] - left[0], right[1] - left[1]);
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

  // ---- Adaptive quality ----
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

  // ---- Frame loop ----
  let last = performance.now();
  const startedAt = last;
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
    dimU.value += (dimTarget - dimU.value) * ease;
    reveal += (revealTarget - reveal) * (1 - Math.exp(-dt * 1.2));
    revealU.value = reveal;
    morph = Math.min(1, morph + dt * 0.6);
    settle += ((resting ? 1 : 0) - settle) * (1 - Math.exp(-dt * 5));

    if (hold && hold.state !== "over") energy = Math.max(energy, 0.45 + 0.25 * hold.progress);
    holdLift += ((hold && hold.state !== "over" ? 0.35 + 0.65 * hold.progress : 0) - holdLift) * (1 - Math.exp(-dt * (hold ? 2.5 : 4)));
    energy *= Math.exp(-dt * (reducedMotion ? 3 : 1.4 + settle * 2.5));
    const tempo = coherence * coherence;
    const liftTarget = (reducedMotion ? 0.35 : 1) * (Math.min(1, energy) * tempo * (1 - settle * 0.85) + holdLift * tempo * 0.9 + ambient * 0.45 + reveal * 0.6);
    // Rising is slow and elegant; falling back a little quicker.
    lift += (liftTarget - lift) * (1 - Math.exp(-dt * (liftTarget > lift ? 1.8 : 2.6)));
    holdVis += ((hold ? 1 : 0) - holdVis) * (1 - Math.exp(-dt * (hold ? 20 : 5)));
    if (hold) holdU.set(hold.progress, hold.state === "filling" ? 1 : hold.state === "ready" ? 2 : 3, holdVis);
    else holdU.z = holdVis;

    // Idle (home): the occasional slow drop on the bed, and the camera drifts very slowly.
    if (ambient > 0.05 && time > idleRippleAt) {
      idleRippleAt = time + 2.5 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.8;
      addRipple(Math.cos(a) * rr, Math.sin(a) * rr, 0.012 + Math.random() * 0.008, 0.35, 0.5, GRADE_RGB.neutral);
    }
    drift += ((ambient > 0.05 && !reducedMotion ? 1 : 0) - drift) * (1 - Math.exp(-dt * 0.5));
    const az = Math.sin(time * 0.035) * 0.16 * drift;
    camera.position.set(CAM_BASE.x * Math.cos(az) + CAM_BASE.z * Math.sin(az), CAM_BASE.y, -CAM_BASE.x * Math.sin(az) + CAM_BASE.z * Math.cos(az));
    camera.lookAt(LOOK_AT);

    for (const r of ripples) {
      if (r.w > 0) {
        r.z += dt;
        if (r.z > 4) r.w = 0;
      }
    }

    const noiseW = (1 - coherence) * 0.85;
    shared.uModeW.value.set(morph * (1 - noiseW), (1 - morph) * (1 - noiseW), noiseW);
    shared.uStanding.value = 0.01 * Math.min(1, Math.max(energy, ambient * 0.4)) * (1 - settle);
    shared.uTime.value = time;

    simUniforms.uDt.value = dt;
    // Idle sorting is a little stronger than idle lifting, so the figure forms between drifts.
    simUniforms.uEnergy.value = Math.max(energy, ambient * 1.8) * (1 - settle * 0.7);
    simUniforms.uLift.value = lift;
    simUniforms.uSettle.value = settle;
    gpu.compute();
    texU.uPositions.value = gpu.getCurrentRenderTarget(posVar).texture;
    texU.uVelocities.value = gpu.getCurrentRenderTarget(velVar).texture;

    fitCamera();
    const grainWorld = mobile ? 0.0075 : 0.0052;
    pigmentUniforms.uSize.value = grainWorld * camera.projectionMatrix.elements[5]! * renderer.domElement.height * 0.5;
    moteUniforms.uSize.value = (mobile ? 0.011 : 0.009) * camera.projectionMatrix.elements[5]! * renderer.domElement.height * 0.5;
    moteUniforms.uStir.value = Math.min(1, energy);

    // Dust shadow first, then the world.
    renderer.setRenderTarget(shadowRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (lift > 0.01) renderer.render(shadowScene, camera);
    renderer.setRenderTarget(null);
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
    debug: () => ({ zoom: camera.zoom, uSize: pigmentUniforms.uSize.value, plateR: plate.r, lift, energy, count: COUNT, pixelRatio: renderer.getPixelRatio() }),
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
      shared.uModeB.value.copy(modeVec(prevFigure));
      shared.uModeA.value.copy(modeVec(figure));
      shared.uModeN.value.copy(modeVec(index + 5));
    },
    strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null, quarters = 1) {
      energy = Math.min(1.3, energy + STRIKE_ENERGY[kind]);
      resting = false;
      const at = clientX != null && clientY != null ? floorAt(clientX, clientY) : null;
      const [x, z] = at && Math.hypot(at[0], at[1]) < 2.2 ? at : [0, 0];
      const q = Math.max(0.25, Math.min(4, quarters));
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

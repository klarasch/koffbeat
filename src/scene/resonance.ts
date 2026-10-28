// The Resonance scene, in Three.js: an abstract white space. In the middle lies a bed of fine
// red, orange and purple pigment sand, and sparse neutral motes drift through the air around it.
// Playing makes the ground resonate: the pigment sorts itself into a Chladni figure and stays on
// the plate. Playing in time keeps it calm and crisp, and each clean bar moves it on to a new
// figure; mistakes jolt it up and scramble it. Only the home screen's idle drift, the results
// reveal and a lost run lift the sand into the air.
//
// Everything runs on the GPU:
// - Void: a soft white gradient with no horizon and no ground; only thin ripple lines and the
//   hold ring are drawn on the plane the sand rests on.
// - Motes: a few thousand neutral specks drifting slowly at many depths.
// - Pigment: a GPGPU particle system (position and velocity textures). Motion uses smooth noise
//   fields only, never per-frame random kicks, so grains glide instead of flickering.

import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import type { Grade } from "../types";

export type StrikeKind = Grade | "neutral";
export type HoldState = "filling" | "ready" | "over";

export interface Scene {
  /**
   * Where the sand bed sits on screen, in viewport CSS px: its centre and half-width. With
   * `snap` the centre jumps there at once (it follows scrolled content) instead of gliding.
   */
  setPlate(cx: number, cy: number, radius: number, snap?: boolean): void;
  /** Which Chladni figure the sand is drawn toward (any integer; wraps around the mode list). */
  setFigure(index: number): void;
  /** Look down on the plate more steeply (as on an upright phone), e.g. to frame a finished figure. */
  setSteep(on: boolean): void;
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
  /** Background energy that keeps the sand gently moving (the home screen's idle state). */
  setAmbient(level: number): void;
  /** 0..1: how much the scene fades back behind UI. */
  setDim(value: number): void;
  /** Scatter the sand evenly. */
  scatter(): void;
  /** End of a run: the sand rises and settles into the figure. `quality` is 0..1. */
  reveal(quality: number): void;
  /** The run is lost: the sand is flung up off the plate and drifts there until `reset`. */
  fling(): void;
  /** Clear the reveal, hold and rest state. */
  reset(): void;
  /** Numbers for debugging in the browser console. */
  debug?(): Record<string, number>;
  readonly supported: boolean;
}

/** Chladni modes (n, m, sign) for f = cos(nπx)cos(mπz) + s*cos(mπx)cos(nπz), x, z in [-1, 1]. */
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
uniform vec3 uRippleShape[${MAX_RIPPLES}]; // wavelength, speed, push (how hard it moves the sand)
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
    vec3 shape = uRippleShape[i];
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
uniform float uShake;
uniform float uHarmony;
uniform float uJitter;
uniform float uBand;
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

  // How far the grain is from the nearest still line (in plate units), and which way it lies.
  // Pulling by distance, not by the raw field, keeps the pull the same for every figure: dense,
  // steep figures no longer overshoot their lines and make the grains bounce across them.
  float slope = length(grad);
  vec2 toward = -grad / max(slope, 1e-4);
  float dist = f / max(slope, 2.0);
  // Grains rest anywhere inside a band around the line, so the figure is drawn in soft,
  // textured strokes instead of single-grain lines. Outside the band they are pulled in.
  float off = sign(dist) * min(max(abs(dist) - uBand, 0.0), 0.15);
  float inBand = 1.0 - smoothstep(uBand * 0.7, uBand * 1.3, abs(dist));

  vec3 acc = vec3(0.0);
  // On the ground: drift toward the still lines. Precise playing (harmony) sorts the sand faster.
  acc.xz += toward * off * 120.0 * (0.7 + 0.8 * uHarmony) * uEnergy * ground;
  // A tiny jiggle where the ground vibrates. Uncorrelated from grain to grain, so it can never
  // herd grains into clumps the way any smooth current does; at this grain size it reads as
  // shimmer, not flicker.
  vec2 jiggle = vec2(hash12(uv * 811.0 + uTime * 61.7), hash12(uv * 577.0 - uTime * 43.1)) - 0.5;
  // Clean playing keeps it faint (uJitter low), so steady playing looks calm; mistakes let it
  // grow back to full strength.
  acc.xz += jiggle * (abs(f) + 0.08) * uEnergy * 5.0 * uJitter * ground;

  // A mistake shakes everything loose: grains are knocked out of the figure, in every
  // direction, and thrown a little into the air.
  vec2 knock = vec2(hash12(uv * 313.0 + uTime * 17.3), hash12(uv * 271.0 - uTime * 29.9)) - 0.5;
  acc.xz += knock * uShake * 34.0;
  acc.y += (0.3 + 0.7 * hash12(uv * 97.0 + uTime)) * uShake * 6.0 * ground;

  // In the air: an even, gentle breeze that slowly turns, so veils drift without pooling.
  vec2 breeze = vec2(cos(uTime * 0.07), sin(uTime * 0.05)) * 0.05;
  acc.xz += breeze * air * (0.4 + uLift);
  // Lifted sand keeps its shape: the figure's pull still acts in the air, so the whole figure
  // rises intact instead of breaking into clouds.
  acc.xz += toward * off * 90.0 * max(uEnergy, 0.35) * air;

  // Ripples push and lift grains as they pass, like a wave through dry sand.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float front = r.z * uRippleShape[i].y;
    float ring = exp(-pow((dist - front) / (uRippleShape[i].x * 0.35), 2.0)) * exp(-r.z * 1.6) * r.w * uRippleShape[i].z;
    acc.xz += d / dist * ring * 0.5;
    acc.y += ring * 2.0;
  }

  // Vertical: a soft spring toward a flowing height field. When the playing is in tempo the
  // field rises into thin veils, highest above the vibrating parts; otherwise it is the ground.
  // A smooth, slowly rolling sheet (no patches): the figure lifts as one surface, a little
  // higher where the plate vibrates most.
  float veil = 0.5 + 0.5 * sin(uTime * 0.9 + p.x * 1.7 - p.y * 1.2) * cos(uTime * 0.6 + p.y * 1.4 + p.x * 0.5);
  float target = floorY + min(uLift, 0.85) * (0.04 + 0.2 * veil * (0.65 + 0.4 * min(abs(f), 1.0))) * (0.93 + 0.14 * fract(seed * 7.13));
  acc.y += (target - pos.y) * mix(9.0, 30.0, uSettle) - vel.y * mix(3.5, 8.0, uSettle);

  // Keep the bed together: grounded grains are held inside it; airborne ones are drawn back.
  float r = length(p);
  if (r > 0.97) acc.xz -= p / r * (r - 0.97) * mix(4.0, 40.0, ground);

  vel.xyz += acc * uDt;
  vel.xz *= exp(-uDt * mix(2.5, mix(6.0, 12.0, uSettle), ground));
  // Sand that has reached its band comes to rest there, as on a real plate: friction stops it.
  vel.xz *= exp(-uDt * 18.0 * inBand * ground);
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
uniform float uBloom;
uniform float uHarmony;
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
  gl_PointSize = max(1.0, uSize * scale * mix(1.0, 0.8, air) * (1.0 + 0.3 * uBloom) / -mv.z);

  vec3 c = PALETTE[int(mod(floor(seed * 6000.0), 6.0))] * (0.86 + 0.28 * fract(seed * 91.7));
  // On the ground the pigment is matte; in the air light passes through it and the veil
  // turns lighter and softer.
  vec3 lit = c * (SUN * 0.7 + SKY_AMBIENT * 0.32);
  vec3 glow = mix(c, vec3(1.0), 0.22);
  vec3 col = mix(lit, glow, air);
  col = mix(col, col * 1.08 + vec3(0.04, 0.02, 0.0), uReveal * 0.5);
  // Precision is colour: in harmony the pigment is vivid and blooms with every clean tap; as
  // the playing falls apart it fades toward grey dust.
  float grey = dot(col, vec3(0.3, 0.55, 0.15));
  col = mix(vec3(grey) * 0.95 + 0.05, col, 0.35 + 0.65 * uHarmony);
  col = mix(col, min(col * 1.35 + vec3(0.05), vec3(1.0)), uBloom * 0.6);
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
varying vec3 vWorld;
void main() {
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const GROUND_FRAG = /* glsl */ `
uniform vec3 uHold;
uniform vec3 uRippleColor[${MAX_RIPPLES}];
uniform float uDim;
varying vec3 vWorld;
${COLORS_GLSL}
${SURFACE_GLSL}

// There is no ground: only the ripples and the hold ring are drawn, and the page's own paper
// (CSS) shows through everywhere else. Colours are layered as premultiplied ink with coverage.
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  vec3 ink = vec3(0.0);
  float a = 0.0;

  // Ripple fronts: thin lines of grade colour travelling out through the white.
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 rp = uRipples[i];
    if (rp.w <= 0.0) continue;
    float d = length(p - rp.xy);
    float front = rp.z * uRippleShape[i].y;
    float ring = exp(-pow((d - front) / (uRippleShape[i].x * 0.08), 2.0)) * exp(-rp.z * 1.5) * rp.w;
    float f = clamp(ring * 9.0, 0.0, 0.3) * (1.0 - smoothstep(1.5, 3.0, d));
    ink = uRippleColor[i] * f + ink * (1.0 - f);
    a = f + a * (1.0 - f);
  }

  // Hold ring traced around the bed.
  if (uHold.z > 0.001) {
    float band = exp(-pow((r - 1.16) / 0.006, 2.0));
    float ang = atan(p.x, -p.y);
    float a01 = fract(ang / 6.2831853 + 1.0);
    float filled = step(a01, clamp(uHold.x, 0.0, 1.0));
    vec3 holdCol = uHold.y > 2.5 ? vec3(0.82, 0.23, 0.23) : uHold.y > 1.5 ? vec3(0.17, 0.12, 0.2) : vec3(0.42, 0.25, 0.63);
    float f1 = band * 0.05 * uHold.z;
    ink = vec3(0.17, 0.12, 0.2) * f1 + ink * (1.0 - f1);
    a = f1 + a * (1.0 - f1);
    float f2 = band * filled * uHold.z * 0.85;
    ink = holdCol * f2 + ink * (1.0 - f2);
    a = f2 + a * (1.0 - f2);
  }
  float keep = 1.0 - uDim * 0.45;
  a *= keep;
  ink *= keep;
  gl_FragColor = vec4(a > 0.0001 ? ink / a : vec3(0.0), a);
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
    setSteep() {},
    setAmbient() {},
    setDim() {},
    scatter() {},
    reveal() {},
    fling() {},
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

/**
 * How much sand the device can carry. Full is the whole scene; light has a quarter of the grains;
 * lite is for weak or software-only graphics: a few thousand larger grains, a low render
 * resolution and 30 frames a second. Every tier plays the same figures, ripples and hold ring.
 */
type Tier = "full" | "light" | "lite";
const TIERS: Tier[] = ["full", "light", "lite"];
/** The tier this device settled on last time, so a slow machine starts light instead of stuttering. */
const TIER_KEY = "resonance.sandTier2";
/** The first version saved tiers too eagerly (a busy moment was enough); those are ignored. */
const OLD_TIER_KEY = "resonance.sandTier";

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as string[]).includes(value);
}

/** True when the browser draws WebGL on the processor (no usable graphics chip). */
function softwareRendering(): boolean {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

export function createScene(canvas: HTMLCanvasElement): Scene {
  // `?sand=full|light|lite` pins a tier (for testing); otherwise it is picked here and adapts.
  const forcedTier = new URLSearchParams(window.location.search).get("sand");
  const pinned = isTier(forcedTier);
  const software = !pinned && softwareRendering();
  let storedTier: string | null = null;
  try {
    storedTier = localStorage.getItem(TIER_KEY);
    localStorage.removeItem(OLD_TIER_KEY);
  } catch {
    // Storage blocked: start at full and adapt.
  }
  let tier: Tier = pinned ? (forcedTier as Tier) : software ? "lite" : isTier(storedTier) ? storedTier : "full";

  let renderer: THREE.WebGLRenderer;
  try {
    // Antialiasing only shows on hard edges, which the sand has none of; weak tiers skip its cost.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: tier === "full", alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
  } catch (err) {
    console.warn("resonance: WebGL unavailable", err);
    return noopScene();
  }
  if (!renderer.capabilities.isWebGL2) return noopScene();

  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const simSize = (t: Tier): [number, number] => (t === "full" ? [256, mobile ? 128 : 256] : t === "light" ? [128, 128] : [96, 96]);
  const moteCount = (t: Tier): number => (t === "full" ? (mobile ? 1400 : 2600) : t === "light" ? 1200 : 500);
  const BASE_COUNT = simSize("full")[0] * simSize("full")[1];
  let [SIM_W, SIM_H] = simSize(tier);
  let COUNT = SIM_W * SIM_H;

  // Render resolution adapts within the tier, stepping down when frames run long.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const ratiosFor = (t: Tier): number[] =>
    (t === "full" ? [1.25, 1, 0.8] : t === "light" ? [1, 0.8] : [0.8, 0.65]).filter((r) => r <= dpr);
  let RATIOS = ratiosFor(tier);
  let ratioStep = 0;
  renderer.setPixelRatio(RATIOS[0] ?? 1);
  renderer.autoClear = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
  // A low, gallery-like view of the figure; there is no horizon to frame. On a tall, narrow
  // screen (a phone held upright) the plate is only as wide as the screen, so the camera looks
  // down more steeply: the ripples read as rings instead of flat streaks.
  const LOOK_AT = new THREE.Vector3(0, 0.08, 0);
  const CAM_DIST = Math.hypot(0.75 - LOOK_AT.y, 3.1);
  const LOW_ELEVATION = Math.atan2(0.75 - LOOK_AT.y, 3.1);
  const PORTRAIT_ELEVATION = 0.6;
  let steep = false;
  const elevationTarget = (): number => (steep || window.innerWidth < window.innerHeight * 0.9 ? PORTRAIT_ELEVATION : LOW_ELEVATION);
  let elevation = elevationTarget();
  function placeCamera(azimuth: number): void {
    const flat = CAM_DIST * Math.cos(elevation);
    camera.position.set(flat * Math.sin(azimuth), LOOK_AT.y + CAM_DIST * Math.sin(elevation), flat * Math.cos(azimuth));
    camera.lookAt(LOOK_AT);
  }
  placeCamera(0);

  // ---- Shared uniforms ----
  const ripples = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0));
  const rippleShape = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3(0.4, 0.8, 1));
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
  const simUniforms = {
    uShake: { value: 0 },
    uJitter: { value: 1 },
    uHarmony: { value: 1 },
    uDt: { value: 1 / 60 },
    uEnergy: { value: 0 },
    uLift: { value: 0 },
    uSettle: { value: 0 },
    /** Half-width of the band the sand rests in around each line (plate units). */
    uBand: { value: 0.016 },
  };
  let gpu: GPUComputationRenderer | null = null;
  let posVar!: Variable;
  let velVar!: Variable;
  /**
   * Builds the simulation at the current SIM_W x SIM_H. With `from`, the grains keep where they
   * are: the new textures sample the old ones, so a tier change carries the figure over intact.
   */
  function buildSim(from?: { pos: THREE.Texture; vel: THREE.Texture }): string | null {
    const next = new GPUComputationRenderer(SIM_W, SIM_H, renderer);
    if (!renderer.extensions.has("EXT_color_buffer_float")) next.setDataType(THREE.HalfFloatType);
    const pos0 = next.createTexture();
    fillScatter(pos0.image.data as unknown as Float32Array);
    const p = next.addVariable("texturePosition", POSITION_SHADER, pos0);
    const v = next.addVariable("textureVelocity", VELOCITY_SHADER, next.createTexture());
    next.setVariableDependencies(p, [p, v]);
    next.setVariableDependencies(v, [p, v]);
    Object.assign(v.material.uniforms, shared, simUniforms);
    Object.assign(p.material.uniforms, { uDt: simUniforms.uDt });
    const err = next.init();
    if (err !== null) {
      next.dispose();
      return err;
    }
    if (from) {
      for (const target of p.renderTargets) next.renderTexture(from.pos, target);
      for (const target of v.renderTargets) next.renderTexture(from.vel, target);
    }
    gpu?.dispose();
    gpu = next;
    posVar = p;
    velVar = v;
    return null;
  }
  const gpuError = buildSim();
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
  // The paper is the page's own CSS background (light and grain included): the sky stays off so
  // the canvas is clear and Safari's edges match the page exactly.
  sky.visible = false;
  sky.renderOrder = -1;
  scene.add(sky);

  /** One point per simulated grain, each pointing at its texel. */
  function buildPigmentGeo(): THREE.BufferGeometry {
    const refs = new Float32Array(COUNT * 2);
    for (let y = 0; y < SIM_H; y++) {
      for (let x = 0; x < SIM_W; x++) {
        const i = y * SIM_W + x;
        refs[i * 2] = (x + 0.5) / SIM_W;
        refs[i * 2 + 1] = (y + 0.5) / SIM_H;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
    return geo;
  }
  const texU = { uPositions: { value: null as THREE.Texture | null }, uVelocities: { value: null as THREE.Texture | null } };

  // ---- Ground ----
  const holdU = new THREE.Vector3(0, 1, 0);
  const ground = new THREE.Mesh(
    polarGround(48, 128, 0.03, 6),
    new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: { ...shared, uHold: { value: holdU }, uRippleColor: { value: rippleColor }, uDim: dimU },
      transparent: true,
    }),
  );
  ground.frustumCulled = false;
  ground.renderOrder = -1;
  scene.add(ground);

  // ---- Pigment ----
  const pigmentUniforms = { ...texU, uSize: { value: 10 }, uDim: dimU, uReveal: revealU, uBloom: { value: 0 }, uHarmony: simUniforms.uHarmony };
  const pigment = new THREE.Points(
    buildPigmentGeo(),
    new THREE.ShaderMaterial({ vertexShader: PIGMENT_VERT, fragmentShader: PIGMENT_FRAG, uniforms: pigmentUniforms, transparent: true, depthWrite: false }),
  );
  pigment.frustumCulled = false;
  pigment.renderOrder = 2;
  scene.add(pigment);

  // ---- Motes ----
  // Allocated for the full scene; lighter tiers draw only the first few.
  const MOTES = moteCount("full");
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
  moteGeo.setDrawRange(0, moteCount(tier));
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
  let lift = 0;
  let dimTarget = 0;
  let reveal = 0;
  let revealTarget = 0;
  let resting = false;
  /** 0..1: how scrambled the figure is: mistakes add to it, time and clean taps take it away. */
  let disorder = 0;
  /** Disorder never recovers below this (the results screen shows how the run went). */
  let disorderFloor = 0;
  /** 0..1: the lost-run state, with the sand flung up and drifting. */
  let flung = 0;
  let shake = 0;
  let bloom = 0;
  let settle = 0;
  let hold: { progress: number; state: HoldState } | null = null;
  let holdVis = 0;
  let figure = 0;
  let prevFigure = 0;
  let morph = 1;
  let rippleCursor = 0;
  let idleRippleAt = 0;
  let drift = 0;

  /** `push` scales how hard the wave moves the sand (its line on the ground is unaffected). */
  function addRipple(x: number, z: number, strength: number, wavelength: number, speed: number, rgb: [number, number, number], push = 1): void {
    const i = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    ripples[i]!.set(x, z, 0, strength);
    rippleShape[i]!.set(wavelength, speed, push);
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
  // First the render resolution steps down within the tier; when that is not enough the tier
  // itself steps down. A tier change waits for a screen without playing (home, results), since
  // rebuilding the simulation can hitch for a moment.
  // Measured in time, not frames, so a machine managing only a few frames a second still
  // adapts within seconds. "Slow" means frames missed against the display's own pace, so a
  // display or power mode that runs at 30 Hz is not mistaken for a slow machine.
  let slowMs = 0;
  let fastMs = 0;
  /** The display's pace: the shortest recent refresh interval, creeping up slowly over time. */
  let baseTick = 1000 / 60;
  let lastTick = performance.now();
  /** A running average of drawn-frame time per refresh, relative to the display's pace. */
  let avgLoad = 1;
  /** No measuring until this time: shader compiles and page load make the first frames slow. */
  let graceUntil = performance.now() + 2500;
  /** After stepping down this session, never step back up (no back and forth). */
  let steppedDown = false;
  let pendingTier: Tier | null = null;
  function setRatio(step: number): void {
    ratioStep = step;
    renderer.setPixelRatio(RATIOS[ratioStep]!);
    resize();
  }
  function adaptQuality(tickMs: number, frameMs: number, now: number): void {
    // Only judge while the page is in front: a covered or background window is throttled by the
    // browser without being hidden, and a single long stall (a tab switch, a hiccup) says nothing.
    if (document.hidden || !document.hasFocus() || now < graceUntil || frameMs > 250) return;
    const load = tickMs / baseTick;
    avgLoad += (load - avgLoad) * 0.05;
    // Slowness has to be sustained: good frames wear it down, so scattered slow frames among
    // good ones never add up. Likewise a slow frame sets back the count toward a sharper step.
    if (load > 1.45) {
      slowMs += frameMs;
      fastMs = Math.max(0, fastMs - frameMs * 4);
    } else {
      slowMs = Math.max(0, slowMs - frameMs * 0.5);
      if (load < 1.15) fastMs += frameMs;
    }
    if (slowMs > 2500) {
      // Far too slow (missing more than every other frame on average): a sharper picture will
      // not save it, so go straight to a lighter tier.
      const severe = avgLoad > 2.4;
      if (ratioStep < RATIOS.length - 1 && !(severe && tier !== "lite")) setRatio(ratioStep + 1);
      else if (tier !== "lite" && !pinned && !pendingTier) {
        pendingTier = TIERS[TIERS.indexOf(tier) + 1]!;
        steppedDown = true;
      }
      slowMs = 0;
      fastMs = 0;
    } else if (fastMs > 10000) {
      if (ratioStep > 0) setRatio(ratioStep - 1);
      else if (tier !== "full" && !pinned && !software && !steppedDown) pendingTier = TIERS[TIERS.indexOf(tier) - 1]!;
      slowMs = 0;
      fastMs = 0;
    }
  }
  function applyTier(next: Tier): void {
    const prev = { tier, w: SIM_W, h: SIM_H };
    const from = { pos: gpu!.getCurrentRenderTarget(posVar).texture, vel: gpu!.getCurrentRenderTarget(velVar).texture };
    [SIM_W, SIM_H] = simSize(next);
    COUNT = SIM_W * SIM_H;
    if (buildSim(from) !== null) {
      [SIM_W, SIM_H] = [prev.w, prev.h];
      COUNT = SIM_W * SIM_H;
      return;
    }
    tier = next;
    pigment.geometry.dispose();
    pigment.geometry = buildPigmentGeo();
    moteGeo.setDrawRange(0, moteCount(tier));
    // Carry on at the nearest resolution no sharper than the current one.
    const current = renderer.getPixelRatio();
    RATIOS = ratiosFor(tier);
    const step = RATIOS.findIndex((r) => r <= current + 1e-6);
    setRatio(step < 0 ? RATIOS.length - 1 : step);
    graceUntil = performance.now() + 2000;
    slowMs = 0;
    fastMs = 0;
    try {
      localStorage.setItem(TIER_KEY, tier);
    } catch {
      // Storage blocked: the next visit adapts again.
    }
  }

  // ---- Frame loop ----
  let last = performance.now();
  const startedAt = last;
  /** Every other display refresh is skipped on idle screens (and always in the lite tier). */
  let skipNext = false;
  /** Display refreshes since the last drawn frame, so frame times compare at any frame rate. */
  let ticks = 0;
  function frame(now: number): void {
    ticks++;
    const interval = now - lastTick;
    lastTick = now;
    if (interval > 4 && interval < 100) baseTick = Math.min(interval, baseTick + interval * 0.0005);
    // Home and results run an idle drift (ambient); play never does.
    const idle = ambient > 0.05 && !hold && energy < 0.05;
    const halfRate = idle || tier === "lite";
    if (halfRate && skipNext) {
      skipNext = false;
      requestAnimationFrame(frame);
      return;
    }
    skipNext = halfRate;
    if (pendingTier && ambient > 0.05) {
      applyTier(pendingTier);
      pendingTier = null;
    }
    const frameMs = now - last;
    const dt = Math.min(1 / 30, Math.max(1 / 240, frameMs / 1000));
    last = now;
    adaptQuality(frameMs / ticks, frameMs, now);
    ticks = 0;
    const time = (now - startedAt) / 1000;

    const ease = 1 - Math.exp(-dt * 6);
    plate.cx += (plateTarget.cx - plate.cx) * ease;
    plate.cy += (plateTarget.cy - plate.cy) * ease;
    // The zoom between the framed view and edge-to-edge play glides more slowly than moves.
    plate.r += (plateTarget.r - plate.r) * (1 - Math.exp(-dt * 2.2));
    dimU.value += (dimTarget - dimU.value) * ease;
    reveal += (revealTarget - reveal) * (1 - Math.exp(-dt * 1.2));
    revealU.value = reveal;
    morph = Math.min(1, morph + dt * 0.6);
    settle += ((resting ? 1 : 0) - settle) * (1 - Math.exp(-dt * 5));

    if (hold && hold.state !== "over") energy = Math.max(energy, 0.45 + 0.25 * hold.progress);
    energy *= Math.exp(-dt * (reducedMotion ? 3 : 1.4 + settle * 2.5));
    shake *= Math.exp(-dt * 3.5);
    bloom *= Math.exp(-dt * 2.2);
    simUniforms.uShake.value = reducedMotion ? shake * 0.3 : shake;
    // Mistakes scramble the figure; it recovers on its own over a few seconds.
    disorder = disorderFloor + (disorder - disorderFloor) * Math.exp(-dt / 4);
    const harmony = 1 - 0.7 * disorder;
    simUniforms.uHarmony.value += (harmony - simUniforms.uHarmony.value) * (1 - Math.exp(-dt * 3));
    // In tempo the grains barely shimmer; scrambled sand shimmers at full strength.
    // On the idle screens (home, results) there is no jiggle at all: grains only glide.
    const jitter = (ambient > 0.05 ? 0 : 0.15) + 0.85 * Math.min(1, disorder * 2.5);
    simUniforms.uJitter.value += (jitter - simUniforms.uJitter.value) * (1 - Math.exp(-dt * 4));
    // Clean playing draws the figure in finer strokes; sloppy playing smears them wider.
    const band = ambient > 0.05 ? 0.016 : 0.011 + 0.02 * disorder;
    simUniforms.uBand.value += (band - simUniforms.uBand.value) * (1 - Math.exp(-dt * 2));
    pigmentUniforms.uBloom.value = bloom;
    // Playing never lifts the sand: it lies on the plate. Only the idle home drift, the results
    // reveal and a lost run raise it.
    const liftTarget = (reducedMotion ? 0.35 : 1) * (ambient * 0.1 + reveal * 0.6 + flung * 0.8);
    // Rising is slow and elegant; falling back a little quicker.
    lift += (liftTarget - lift) * (1 - Math.exp(-dt * (liftTarget > lift ? 1.8 : 2.6)));
    holdVis += ((hold ? 1 : 0) - holdVis) * (1 - Math.exp(-dt * (hold ? 20 : 5)));
    if (hold) holdU.set(hold.progress, hold.state === "filling" ? 1 : hold.state === "ready" ? 2 : 3, holdVis);
    else holdU.z = holdVis;

    // Idle (home): the occasional slow drop on the bed, and the camera drifts very slowly.
    if (ambient > 0.05 && time > idleRippleAt) {
      idleRippleAt = time + 5 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.8;
      addRipple(Math.cos(a) * rr, Math.sin(a) * rr, 0.012 + Math.random() * 0.008, 0.35, 0.5, GRADE_RGB.neutral, 0.25);
    }
    drift += ((ambient > 0.05 && !reducedMotion ? 1 : 0) - drift) * (1 - Math.exp(-dt * 0.5));
    const az = Math.sin(time * 0.035) * 0.16 * drift;
    elevation += (elevationTarget() - elevation) * ease;
    placeCamera(az);

    for (const r of ripples) {
      if (r.w > 0) {
        r.z += dt;
        if (r.z > 4) r.w = 0;
      }
    }

    // Imprecision blurs the figure with a competing mode, sooner and harder than before.
    const noiseW = Math.pow(disorder, 0.8) * 0.9;
    shared.uModeW.value.set(morph * (1 - noiseW), (1 - morph) * (1 - noiseW), noiseW);
    // The plate rings only while it is played; on the idle screens the sand lies still.
    shared.uStanding.value = 0.01 * Math.min(1, energy) * (1 - settle);
    shared.uTime.value = time;

    simUniforms.uDt.value = dt;
    // Idle sorting is a little stronger than idle lifting, so the figure forms between drifts.
    // While the figure morphs the grains need energy to travel to the new lines.
    simUniforms.uEnergy.value = Math.max(energy, ambient * 1.8, (1 - morph) * 0.9) * (1 - settle * 0.7);
    simUniforms.uLift.value = lift;
    simUniforms.uSettle.value = settle;
    const sim = gpu!;
    sim.compute();
    texU.uPositions.value = sim.getCurrentRenderTarget(posVar).texture;
    texU.uVelocities.value = sim.getCurrentRenderTarget(velVar).texture;

    fitCamera();
    // Fine grains; fewer grains are drawn only a touch larger, so lighter tiers stay fine too.
    const grainWorld = (mobile ? 0.0065 : 0.0046) * Math.pow(BASE_COUNT / COUNT, 0.15);
    pigmentUniforms.uSize.value = grainWorld * camera.projectionMatrix.elements[5]! * renderer.domElement.height * 0.5;
    moteUniforms.uSize.value = (mobile ? 0.011 : 0.009) * camera.projectionMatrix.elements[5]! * renderer.domElement.height * 0.5;
    moteUniforms.uStir.value = Math.min(1, energy);

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function scatter(): void {
    const sim = gpu!;
    const tex = sim.createTexture();
    fillScatter(tex.image.data as unknown as Float32Array);
    sim.renderTexture(tex, posVar.renderTargets[0]!);
    sim.renderTexture(tex, posVar.renderTargets[1]!);
    tex.dispose();
  }

  return {
    supported: true,
    debug: () => ({
      zoom: camera.zoom,
      uSize: pigmentUniforms.uSize.value,
      plateR: plate.r,
      lift,
      energy,
      count: COUNT,
      pixelRatio: renderer.getPixelRatio(),
      tier: TIERS.indexOf(tier),
      software: software ? 1 : 0,
    }),
    setPlate(x: number, y: number, radius: number, snap = false) {
      plateTarget.cx = x;
      plateTarget.cy = y;
      plateTarget.r = Math.max(20, radius);
      if (snap) {
        plate.cx = x;
        plate.cy = y;
      }
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
      // A soft ripple through the sand on the plate marks the change (the home screen has its own).
      if (ambient <= 0.05) addRipple(0, 0, 0.02, 0.7, 0.5, GRADE_RGB.neutral, 0.4);
    },
    strike(kind: StrikeKind, clientX?: number | null, clientY?: number | null, quarters = 1) {
      const q = Math.max(0.25, Math.min(4, quarters));
      const clean = kind === "perfect" || kind === "good" || kind === "neutral";
      // A clean note adds energy in proportion to its length, so fast notes (triplets,
      // sixteenths) keep the sand as calm as quarters do instead of piling up energy.
      // Everything a note does to the sand is weighed by its length, so a bar of sixteenths
      // stirs it about as much as a bar of quarters, for clean notes and mistakes alike.
      const len = Math.min(1, q);
      const share = clean ? len : 1;
      energy = Math.min(clean ? 0.6 + 0.3 * len : 1.3, energy + STRIKE_ENERGY[kind] * share);
      resting = false;
      const at = clientX != null && clientY != null ? floorAt(clientX, clientY) : null;
      const [x, z] = at && Math.hypot(at[0], at[1]) < 2.2 ? at : [0, 0];
      const wavelength = 0.22 + 0.12 * Math.sqrt(q);
      const speed = 0.9 + 0.25 * Math.sqrt(q);
      // Clean fast notes send small ripples; a mistake always sends a strong one.
      const strength = kind === "miss" ? 0.05 * (0.8 + 0.35 * Math.sqrt(q)) : 0.035 * (0.35 + 0.65 * Math.min(1, q)) * (clean ? 1 : 1.3);
      // The line is always drawn; only its push on the sand is weighed. Clean taps barely move it.
      const push = clean ? 0.6 * len : kind === "ok" ? 0.5 + 0.5 * len : 1;
      addRipple(x, z, strength, wavelength, speed, GRADE_RGB[kind], push);
      // Clean taps tidy the figure and brighten the pigment a touch; mistakes jolt the sand up
      // off the plate (by how bad) and scramble the figure. Nothing here lifts the sand as a reward.
      if (kind === "perfect") {
        disorder = Math.max(disorderFloor, disorder - 0.12);
        bloom = Math.min(1.2, bloom + 0.5);
      } else if (kind === "good") {
        disorder = Math.max(disorderFloor, disorder - 0.08);
        bloom = Math.min(1.2, bloom + 0.25);
      } else if (kind === "ok") {
        disorder = Math.min(1, disorder + 0.15 * (0.4 + 0.6 * len));
        shake = Math.max(shake, 0.4 * (0.5 + 0.5 * len));
        energy = Math.max(energy, 0.6 + 0.2 * len);
      } else if (kind === "miss") {
        disorder = Math.min(1, disorder + 0.45 * (0.6 + 0.4 * len));
        shake = Math.max(shake, 0.7 + 0.3 * len);
        energy = Math.max(energy, 1);
      }
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
    fling() {
      flung = 1;
      shake = 1.6;
      disorder = Math.max(disorder, 0.7);
      resting = false;
    },
    setAmbient(level: number) {
      ambient = reducedMotion ? level * 0.4 : level;
    },
    setSteep(on: boolean) {
      steep = on;
    },
    setDim(value: number) {
      dimTarget = value;
    },
    scatter,
    reveal(quality: number) {
      const q = Math.min(1, Math.max(0, quality));
      revealTarget = 0.3 + 0.7 * q;
      disorderFloor = (1 - q) * 0.5;
      disorder = Math.max(disorder, disorderFloor);
      resting = false;
      energy = Math.max(energy, 0.5);
      ambient = reducedMotion ? 0.08 : 0.22;
      addRipple(0, 0, 0.05 * q + 0.01, 0.6, 0.6, GRADE_RGB.perfect);
    },
    reset() {
      revealTarget = 0;
      hold = null;
      resting = false;
      disorder = 0;
      disorderFloor = 0;
      flung = 0;
      shake = 0;
    },
  };
}

// Look-and-feel values: the paper's light, the glass of the bento blocks, and how faint the sand
// is behind text. They are applied as CSS variables on the root; the sand values are read where
// the sand is placed. The defaults are the tuned ones; the live tuning panel for the phone lives
// on the `tweaker` branch.

export interface TweakDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export const TWEAKS: TweakDef[] = [
  { key: "light", label: "Light strength", min: 0, max: 1, step: 0.05, value: 0.5 },
  { key: "lightY", label: "Light height (%)", min: 0, max: 100, step: 1, value: 42 },
  { key: "lightW", label: "Light width (%)", min: 20, max: 200, step: 5, value: 110 },
  { key: "lightH", label: "Light depth (%)", min: 5, max: 80, step: 1, value: 34 },
  { key: "glass", label: "Glass opacity", min: 0, max: 1, step: 0.05, value: 0.6 },
  { key: "blur", label: "Glass blur (px)", min: 0, max: 40, step: 1, value: 14 },
  { key: "lines", label: "Line strength", min: 0, max: 0.4, step: 0.01, value: 0.12 },
  { key: "sandHome", label: "Sand fade, home (phone)", min: 0, max: 1, step: 0.05, value: 0.45 },
  { key: "sandResults", label: "Sand fade, results (phone)", min: 0, max: 1, step: 0.05, value: 0.6 },
];

const STORAGE_KEY = "resonance.tweaks";
const values = new Map<string, number>(TWEAKS.map((t) => [t.key, t.value]));
const listeners = new Set<() => void>();

/** Values saved on this device by the tweaker (only the tweaker loads them; the app uses the defaults). */
export function loadSavedTweaks(): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return;
    for (const def of TWEAKS) {
      const v = Number((raw as Record<string, unknown>)[def.key]);
      if (Number.isFinite(v)) values.set(def.key, Math.min(def.max, Math.max(def.min, v)));
    }
  } catch {
    // Defaults stay.
  }
}

export function tweak(key: string): number {
  return values.get(key) ?? 0;
}

export function setTweak(key: string, value: number): void {
  values.set(key, value);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(values)));
  } catch {
    // Not saved; still applies now.
  }
  apply();
}

export function resetTweaks(): void {
  for (const def of TWEAKS) values.set(def.key, def.value);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing saved.
  }
  apply();
}

/** Called after any change (the sand re-reads its fade). */
export function onTweak(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(): void {
  const root = document.documentElement.style;
  root.setProperty("--paper-light", String(tweak("light")));
  root.setProperty("--paper-light-y", `${tweak("lightY")}%`);
  root.setProperty("--paper-light-w", `${tweak("lightW")}%`);
  root.setProperty("--paper-light-h", `${tweak("lightH")}%`);
  root.setProperty("--glass", String(tweak("glass")));
  root.setProperty("--glass-blur", `${tweak("blur")}px`);
  root.setProperty("--lines", String(tweak("lines")));
  for (const listener of listeners) listener();
}

export function installTweaks(): void {
  apply();
}

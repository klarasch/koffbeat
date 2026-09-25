import type { AudioEngine } from "../audio/engine";
import type { Hit, Release } from "../types";

/**
 * Attaches pointer + keyboard input handling to `target`.
 * Returns a detach function that removes every listener and style it added.
 *
 * Zone mapping: left half of target's bounding box = zone 0, right half = zone 1
 * (pointer input); F / D / Space / ArrowLeft = zone 0, J / K / ArrowRight = zone 1 (keyboard).
 * A release (pointerup/pointercancel, or keyup of a mapped key) reports the zone its press was
 * in — pointer releases are tracked per pointerId since the finger may have moved off target by
 * then; keyboard releases use the key's own zone mapping.
 */
export function attachInput(
  target: HTMLElement,
  engine: AudioEngine,
  onHit: (hit: Hit) => void,
  getOffsetSec: () => number,
  onRelease: (release: Release) => void = () => {},
): () => void {
  const previousTouchAction = target.style.touchAction;
  const previousUserSelect = target.style.userSelect;
  const previousWebkitUserSelect = target.style.getPropertyValue("-webkit-user-select");
  const previousWebkitTouchCallout = target.style.getPropertyValue("-webkit-touch-callout");

  // Prevent iOS double-tap-to-zoom, long-press callouts, and text selection from interfering
  // with rapid repeated taps.
  target.style.touchAction = "none";
  target.style.userSelect = "none";
  target.style.setProperty("-webkit-user-select", "none");
  target.style.setProperty("-webkit-touch-callout", "none");

  const pressedKeys = new Set<string>();
  const zone0Keys = new Set(["f", "d", " ", "arrowleft"]);
  const zone1Keys = new Set(["j", "k", "arrowright"]);
  /** Zone each currently-down pointer pressed in, so its release reports the same zone. */
  const pointerZones = new Map<number, 0 | 1>();

  /**
   * Maps an event's high-resolution timestamp onto the audio clock. getOutputTimestamp pairs a
   * performance.now() instant with the context time audible at the speaker, so the result is
   * smooth (ctx.currentTime advances in hardware-buffer chunks, 20–40 ms on iOS) and already
   * compensates output latency. Falls back to currentTime where it's unsupported.
   */
  function eventTimeToAudioTime(eventTimeStamp: number): number {
    const nowPerf = performance.now();
    const eventPerf = Number.isFinite(eventTimeStamp) && eventTimeStamp <= nowPerf && nowPerf - eventTimeStamp < 100 ? eventTimeStamp : nowPerf;
    const stamp = typeof engine.ctx.getOutputTimestamp === "function" ? engine.ctx.getOutputTimestamp() : null;
    if (stamp?.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      return stamp.contextTime + (eventPerf - stamp.performanceTime) / 1000 - getOffsetSec();
    }
    return engine.now() - (nowPerf - eventPerf) / 1000 - getOffsetSec();
  }

  function zoneForClientX(clientX: number): 0 | 1 {
    const rect = target.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    return clientX < midpoint ? 0 : 1;
  }

  // Tap feedback is visual, not a sound: phone audio output lags 100–250 ms, so a tap sound
  // arrives late and players learn to line it up with the (also late) click instead of the pulse.
  if (getComputedStyle(target).position === "static") target.style.position = "relative";
  target.style.overflow = "hidden";

  function ripple(clientX: number | null, zone: 0 | 1): void {
    const rect = target.getBoundingClientRect();
    const x = clientX === null ? rect.width * (zone === 0 ? 0.25 : 0.75) : clientX - rect.left;
    const size = Math.min(rect.width, rect.height) * 0.6;
    const el = document.createElement("span");
    el.style.cssText = `position:absolute;left:${x - size / 2}px;top:${rect.height / 2 - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;pointer-events:none;background:radial-gradient(circle, rgba(127,224,196,0.55) 0%, rgba(127,224,196,0) 70%);`;
    target.appendChild(el);
    const animation = el.animate(
      [
        { transform: "scale(0.35)", opacity: 1 },
        { transform: "scale(1.2)", opacity: 0 },
      ],
      { duration: 380, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
    );
    animation.onfinish = () => el.remove();
  }

  function registerHit(zone: 0 | 1, eventTimeStamp: number, clientX: number | null): void {
    const time = eventTimeToAudioTime(eventTimeStamp);
    ripple(clientX, zone);
    onHit({ time, zone });
  }

  function registerRelease(zone: 0 | 1, eventTimeStamp: number): void {
    const time = eventTimeToAudioTime(eventTimeStamp);
    onRelease({ time, zone });
  }

  function handlePointerDown(event: PointerEvent): void {
    event.preventDefault();
    const zone = zoneForClientX(event.clientX);
    pointerZones.set(event.pointerId, zone);
    registerHit(zone, event.timeStamp, event.clientX);
  }

  function handlePointerUp(event: PointerEvent): void {
    const zone = pointerZones.get(event.pointerId);
    pointerZones.delete(event.pointerId);
    if (zone === undefined) return;
    registerRelease(zone, event.timeStamp);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.repeat) {
      return;
    }
    const key = event.key.toLowerCase();
    let zone: 0 | 1 | null = null;
    if (zone0Keys.has(key)) {
      zone = 0;
    } else if (zone1Keys.has(key)) {
      zone = 1;
    }
    if (zone === null) {
      return;
    }
    if (pressedKeys.has(key)) {
      return;
    }
    pressedKeys.add(key);
    if (key === " " || key === "arrowleft" || key === "arrowright") {
      event.preventDefault();
    }
    registerHit(zone, event.timeStamp, null);
  }

  function handleKeyUp(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    pressedKeys.delete(key);
    let zone: 0 | 1 | null = null;
    if (zone0Keys.has(key)) {
      zone = 0;
    } else if (zone1Keys.has(key)) {
      zone = 1;
    }
    if (zone === null) return;
    registerRelease(zone, event.timeStamp);
  }

  target.addEventListener("pointerdown", handlePointerDown);
  target.addEventListener("pointerup", handlePointerUp);
  target.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  return function detach(): void {
    target.removeEventListener("pointerdown", handlePointerDown);
    target.removeEventListener("pointerup", handlePointerUp);
    target.removeEventListener("pointercancel", handlePointerUp);
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    target.style.touchAction = previousTouchAction;
    target.style.userSelect = previousUserSelect;
    target.style.setProperty("-webkit-user-select", previousWebkitUserSelect);
    target.style.setProperty("-webkit-touch-callout", previousWebkitTouchCallout);
    pressedKeys.clear();
    pointerZones.clear();
  };
}

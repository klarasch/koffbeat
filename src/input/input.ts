import type { AudioEngine } from "../audio/engine";
import type { Hit } from "../types";

/**
 * Attaches pointer + keyboard input handling to `target`.
 * Returns a detach function that removes every listener and style it added.
 *
 * Zone mapping: left half of target's bounding box = zone 0, right half = zone 1
 * (pointer input); F / D / Space / ArrowLeft = zone 0, J / K / ArrowRight = zone 1 (keyboard).
 */
export function attachInput(target: HTMLElement, engine: AudioEngine, onHit: (hit: Hit) => void, getOffsetSec: () => number): () => void {
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

  function registerHit(zone: 0 | 1, eventTimeStamp: number): void {
    const time = eventTimeToAudioTime(eventTimeStamp);
    engine.playHit(zone);
    onHit({ time, zone });
  }

  function handlePointerDown(event: PointerEvent): void {
    event.preventDefault();
    const zone = zoneForClientX(event.clientX);
    registerHit(zone, event.timeStamp);
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
    registerHit(zone, event.timeStamp);
  }

  function handleKeyUp(event: KeyboardEvent): void {
    pressedKeys.delete(event.key.toLowerCase());
  }

  target.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  return function detach(): void {
    target.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    target.style.touchAction = previousTouchAction;
    target.style.userSelect = previousUserSelect;
    target.style.setProperty("-webkit-user-select", previousWebkitUserSelect);
    target.style.setProperty("-webkit-touch-callout", previousWebkitTouchCallout);
    pressedKeys.clear();
  };
}

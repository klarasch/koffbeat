// "How to play": a few short cards, shown before the first exercise (whatever it is) and from
// the home screen's button. Styled like latency calibration (the cal-* classes in style.css).

import { t, type Key } from "../i18n";

const SEEN_KEY = "resonance.seenHowTo";

export function hasSeenHowTo(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true; // Storage unavailable: don't show it before every exercise.
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Not persisted.
  }
}

/** Touch screens get "tap"; a keyboard and mouse get the keys. */
function usesTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

interface Card {
  title: Key;
  text: Key;
}

function cards(): Card[] {
  const touch = usesTouch();
  return [
    { title: "howto.tap.title", text: touch ? "howto.tap.touch" : "howto.tap.keys" },
    { title: "howto.hold.title", text: touch ? "howto.hold.touch" : "howto.hold.keys" },
    { title: "howto.hands.title", text: touch ? "howto.hands.touch" : "howto.hands.keys" },
    { title: "howto.modes.title", text: "howto.modes.text" },
    { title: "howto.sand.title", text: "howto.sand.text" },
  ];
}

/**
 * Shows the cards over the page and resolves when they're closed (done or skipped).
 * `beforePlay`: shown on the way into an exercise, so the last button says "Let's play".
 */
export function showHowTo(beforePlay = false): Promise<void> {
  return new Promise((resolve) => {
    const list = cards();
    let index = 0;

    const overlay = document.createElement("div");
    overlay.className = "howto";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", t("howto.button"));
    const page = document.createElement("div");
    page.className = "cal howto-page";

    const label = document.createElement("p");
    label.className = "cal-label";
    const heading = document.createElement("h1");
    heading.className = "cal-heading";
    const text = document.createElement("p");
    text.className = "cal-text";
    text.setAttribute("aria-live", "polite");

    const progress = document.createElement("div");
    progress.className = "cal-progress";
    const bars = list.map(() => progress.appendChild(document.createElement("span")));

    const actions = document.createElement("div");
    actions.className = "cal-actions";
    const back = button(t("howto.back"), "secondary");
    const next = button("", "primary");
    const skip = button(t("howto.skip"), "secondary howto-skip");
    actions.append(back, next, skip);

    page.append(label, heading, text, progress, actions);
    overlay.appendChild(page);
    document.body.appendChild(overlay);

    function paint(): void {
      const card = list[index]!;
      const last = index === list.length - 1;
      label.textContent = t("howto.label", { i: index + 1, n: list.length });
      heading.textContent = t(card.title);
      text.textContent = t(card.text);
      bars.forEach((bar, i) => bar.classList.toggle("on", i <= index));
      back.hidden = index === 0;
      skip.hidden = last;
      next.textContent = last ? t(beforePlay ? "howto.play" : "howto.done") : t("howto.next");
    }

    function go(delta: number): void {
      const target = index + delta;
      if (target >= list.length) return close();
      index = Math.max(0, target);
      paint();
      next.focus({ preventScroll: true });
    }

    function close(): void {
      markSeen();
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve();
    }

    // Captured, and kept from the page underneath: home's own Enter (play) and Escape
    // (settings) must not fire while the cards are up.
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight" || event.key === "Enter") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    back.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    skip.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    paint();
    next.focus({ preventScroll: true });
  });
}

function button(label: string, kind: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `cal-button ${kind}`;
  el.textContent = label;
  return el;
}

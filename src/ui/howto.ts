// "How to play": five short cards, shown before the first exercise (whatever it is) and from
// the home screen's button. One framed card of a fixed size, so nothing moves between cards:
// a pixel drawing of the idea, a title, a few lines, and the buttons always in the same place.

import { t, type Key } from "../i18n";
import { kbd, setTextWithKeys } from "./keys";
import { rhythmIcon } from "./pixelIcons";

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
  art: () => HTMLElement;
}

const div = (cls: string, html = ""): HTMLElement => {
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = html;
  return el;
};

/** Four quarter notes; the one to play next is lit. */
function artTap(): HTMLElement {
  const art = div("howto-art art-tap");
  for (let i = 0; i < 4; i++) art.appendChild(div(`art-note${i === 1 ? " lit" : ""}`, rhythmIcon("quarters")));
  return art;
}

/** A half note held over two beats, then a rest with nothing under it. */
function artHold(): HTMLElement {
  const art = div("howto-art art-hold");
  const held = div("art-note lit", rhythmIcon("halves"));
  held.appendChild(div("art-bar"));
  art.append(held, div("art-note", rhythmIcon("rests")));
  return art;
}

/** The two halves of the screen, with their keys. */
function artHands(): HTMLElement {
  const art = div("howto-art art-hands");
  for (const [label, key] of [[t("play.zoneLeft"), "F"], [t("play.zoneRight"), "J"]] as const) {
    const half = div("art-half");
    half.append(document.createTextNode(label), kbd(key));
    art.appendChild(half);
  }
  return art;
}

/** The three lesson steps, in order. */
function artModes(): HTMLElement {
  const art = div("howto-art art-modes");
  (["step.learn", "step.practice", "step.countIn"] as const).forEach((key, i) => {
    if (i > 0) art.appendChild(div("art-arrow", "→"));
    art.appendChild(div(`art-step${i === 0 ? " lit" : ""}`, t(key)));
  });
  return art;
}

/** A sand figure: the nodal lines of a vibrating square plate, drawn in pixels inside a circle. */
function artSand(): HTMLElement {
  const W = 41;
  const H = 21;
  let cells = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * 2 - 1;
      const v = (y / (H - 1)) * 2 - 1;
      if (u * u + v * v > 1) continue;
      const f = Math.cos(3 * Math.PI * u * 0.5) * Math.cos(Math.PI * v * 0.5) - Math.cos(Math.PI * u * 0.5) * Math.cos(3 * Math.PI * v * 0.5);
      if (Math.abs(f) < 0.3) cells += `<rect x="${x}" y="${y}" width="1" height="1" class="${(x * 7 + y * 3) % 5 === 0 ? "warm" : ""}"/>`;
    }
  }
  return div("howto-art art-sand", `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" shape-rendering="crispEdges">${cells}</svg>`);
}

function cards(): Card[] {
  const touch = usesTouch();
  return [
    { title: "howto.tap.title", text: touch ? "howto.tap.touch" : "howto.tap.keys", art: artTap },
    { title: "howto.hold.title", text: touch ? "howto.hold.touch" : "howto.hold.keys", art: artHold },
    { title: "howto.hands.title", text: touch ? "howto.hands.touch" : "howto.hands.keys", art: artHands },
    { title: "howto.modes.title", text: "howto.modes.text", art: artModes },
    { title: "howto.sand.title", text: "howto.sand.text", art: artSand },
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

    const overlay = div("howto");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", t("howto.button"));
    const card = div("howto-card");

    // Top: the name in the pixel face, a square per card, and Skip.
    const top = div("howto-top");
    const name = div("howto-name", "");
    name.textContent = t("howto.button");
    const pips = div("howto-pips");
    const pipEls = list.map(() => pips.appendChild(div("howto-pip")));
    const skip = button(t("howto.skip"), "howto-skip", "Esc");
    top.append(name, pips, skip);

    const artSlot = div("howto-art-slot");
    const heading = document.createElement("h1");
    heading.className = "howto-title";
    const text = document.createElement("p");
    text.className = "howto-text";
    text.setAttribute("aria-live", "polite");

    const actions = div("howto-actions");
    const back = button(t("howto.back"), "cal-button secondary", "←");
    const next = button("", "cal-button primary", "→");
    actions.append(back, next);

    card.append(top, artSlot, heading, text, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function paint(): void {
      const current = list[index]!;
      const last = index === list.length - 1;
      artSlot.replaceChildren(current.art());
      heading.textContent = t(current.title);
      setTextWithKeys(text, t(current.text));
      pipEls.forEach((pip, i) => pip.classList.toggle("on", i <= index));
      // Hidden, but still holding their place, so nothing shifts between cards.
      back.style.visibility = index === 0 ? "hidden" : "";
      skip.style.visibility = last ? "hidden" : "";
      next.firstChild!.textContent = last ? t(beforePlay ? "howto.play" : "howto.done") : t("howto.next");
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

function button(label: string, cls: string, key: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = cls;
  el.append(document.createTextNode(label), kbd(key, "howto-key"));
  return el;
}

// Keyboard keys shown as small boxes (<kbd class="kbd">). Translated text marks a key as [F];
// setTextWithKeys turns those marks into boxes, safely (everything else stays plain text).

/** Enter and the arrows as drawn icons: the font's own glyphs come out tiny and low. */
const KEY_ICONS: Record<string, { name: string; path: string }> = {
  "↵": { name: "Enter", path: "M12.5 3.5v4.75a1.75 1.75 0 0 1-1.75 1.75H3.5M6.5 7l-3 3 3 3" },
  "→": { name: "→", path: "M3 8h10M9.5 4.5 13 8l-3.5 3.5" },
  "←": { name: "←", path: "M13 8H3M6.5 4.5 3 8l3.5 3.5" },
};

export function kbd(key: string, extraClass = ""): HTMLElement {
  const el = document.createElement("kbd");
  el.className = `kbd ${extraClass}`.trim();
  const icon = KEY_ICONS[key];
  if (icon) {
    el.classList.add("kbd-icon");
    el.setAttribute("aria-label", icon.name);
    el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${icon.path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else {
    el.textContent = key;
  }
  return el;
}

/** Sets `el`'s text, with each [Key] drawn as a key box that stays visible on touch screens too. */
export function setTextWithKeys(el: HTMLElement, text: string): void {
  el.replaceChildren();
  for (const part of text.split(/(\[[^\]\s]{1,5}\])/)) {
    if (/^\[[^\]\s]{1,5}\]$/.test(part)) el.appendChild(kbd(part.slice(1, -1), "kbd-inline"));
    else if (part) el.appendChild(document.createTextNode(part));
  }
}

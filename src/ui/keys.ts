// Keyboard keys shown as small boxes (<kbd class="kbd">). Translated text marks a key as [F];
// setTextWithKeys turns those marks into boxes, safely (everything else stays plain text).

export function kbd(key: string, extraClass = ""): HTMLElement {
  const el = document.createElement("kbd");
  el.className = `kbd ${extraClass}`.trim();
  el.textContent = key;
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

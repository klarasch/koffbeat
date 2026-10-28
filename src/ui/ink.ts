// Tap feedback for controls: a soft purple wash spreads from the finger and fades, like ink
// soaking into paper. It replaces the browser's own grey tap flash. In-game taps have their own
// feedback (rings on the notes, waves in the sand), so the tap area is left alone.

const CONTROLS = "button, [role='button'], a, summary, label";

export function installInk(): void {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const el = event.target.closest<HTMLElement>(CONTROLS);
      if (!el || el.closest(".tap-area") || (el as HTMLButtonElement).disabled) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      // A clipping layer laid over the control in its own shape, so the wash never spills
      // outside it. It lives outside the control, which may rewrite its own contents on click.
      const layer = document.createElement("span");
      layer.className = "ink-layer";
      layer.style.left = `${rect.left}px`;
      layer.style.top = `${rect.top}px`;
      layer.style.width = `${rect.width}px`;
      layer.style.height = `${rect.height}px`;
      layer.style.borderRadius = getComputedStyle(el).borderRadius;
      const dot = document.createElement("span");
      dot.className = "ink-dot";
      const size = Math.hypot(rect.width, rect.height) * 2;
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${event.clientX - rect.left - size / 2}px`;
      dot.style.top = `${event.clientY - rect.top - size / 2}px`;
      layer.appendChild(dot);
      document.body.appendChild(layer);
      dot.addEventListener("animationend", () => layer.remove(), { once: true });
    },
    { passive: true },
  );
}

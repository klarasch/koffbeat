// Small form controls drawn by the app itself (no system widgets): a labelled field, a
// segmented control, a styled select with its own listbox, and a numeric stepper. All are
// keyboard and screen-reader friendly.

export interface Choice {
  value: string;
  label: string;
  /** Optional secondary text (shown in the select's list). */
  hint?: string;
}

let fieldCount = 0;

/** A field: a small label above its control. */
export function field(label: string, control: HTMLElement): HTMLElement {
  const id = `field-${++fieldCount}`;
  const wrap = document.createElement("div");
  wrap.className = "field";
  const labelEl = document.createElement("span");
  labelEl.className = "field-label";
  labelEl.id = id;
  labelEl.textContent = label;
  control.setAttribute("aria-labelledby", id);
  wrap.append(labelEl, control);
  return wrap;
}

export interface Segmented {
  el: HTMLElement;
  set(value: string): void;
}

/** A row of joined rectangular buttons, exactly one selected. Arrow keys move the selection. */
export function segmented(choices: Choice[], initial: string, onChange: (value: string) => void): Segmented {
  const el = document.createElement("div");
  el.className = "segmented";
  el.setAttribute("role", "radiogroup");
  let current = initial;
  const buttons = choices.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.textContent = choice.label;
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => pick(choice.value, true));
    el.appendChild(button);
    return button;
  });
  function paint(): void {
    choices.forEach((choice, i) => {
      const on = choice.value === current;
      const button = buttons[i]!;
      button.classList.toggle("selected", on);
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    });
  }
  function pick(value: string, notify: boolean): void {
    current = value;
    paint();
    if (notify) onChange(value);
  }
  el.addEventListener("keydown", (event) => {
    const index = choices.findIndex((c) => c.value === current);
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = choices[(index + delta + choices.length) % choices.length]!;
    pick(next.value, true);
    buttons[choices.indexOf(next)]?.focus();
  });
  paint();
  return { el, set: (value) => pick(value, false) };
}

export interface Select {
  el: HTMLElement;
  set(value: string): void;
  /** Marks options that can't be chosen right now (shown, but dimmed and skipped). */
  setDisabled(values: string[]): void;
}

/**
 * A styled select: a rectangular button showing the current choice, opening a list below (or
 * above, when there's no room). Arrow keys, Home/End, Enter/Space and Escape work as expected.
 */
export function select(choices: Choice[], initial: string, onChange: (value: string) => void): Select {
  const el = document.createElement("div");
  el.className = "select";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "select-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const valueEl = document.createElement("span");
  valueEl.className = "select-value";
  const chevron = document.createElement("span");
  chevron.className = "select-chevron";
  chevron.setAttribute("aria-hidden", "true");
  button.append(valueEl, chevron);

  const list = document.createElement("ul");
  list.className = "select-list";
  list.setAttribute("role", "listbox");
  list.tabIndex = -1;
  list.hidden = true;
  const listId = `select-list-${++fieldCount}`;
  list.id = listId;
  button.setAttribute("aria-controls", listId);

  let current = initial;
  let active = initial;
  let disabled = new Set<string>();
  const items = choices.map((choice, i) => {
    const li = document.createElement("li");
    li.className = "select-option";
    li.id = `${listId}-${i}`;
    li.setAttribute("role", "option");
    const label = document.createElement("span");
    label.className = "select-option-label";
    label.textContent = choice.label;
    li.appendChild(label);
    if (choice.hint) {
      const hint = document.createElement("span");
      hint.className = "select-option-hint";
      hint.textContent = choice.hint;
      li.appendChild(hint);
    }
    li.addEventListener("pointerdown", (event) => event.preventDefault());
    li.addEventListener("click", () => {
      if (disabled.has(choice.value)) return;
      commit(choice.value);
      close(true);
    });
    li.addEventListener("pointermove", () => setActive(choice.value));
    list.appendChild(li);
    return li;
  });
  el.append(button, list);

  function paint(): void {
    const choice = choices.find((c) => c.value === current);
    valueEl.textContent = choice?.label ?? "";
    choices.forEach((c, i) => {
      const item = items[i]!;
      item.setAttribute("aria-selected", String(c.value === current));
      item.classList.toggle("active", c.value === active);
      item.classList.toggle("disabled", disabled.has(c.value));
      item.setAttribute("aria-disabled", String(disabled.has(c.value)));
    });
    const activeIndex = choices.findIndex((c) => c.value === active);
    if (activeIndex >= 0) list.setAttribute("aria-activedescendant", items[activeIndex]!.id);
  }
  function setActive(value: string): void {
    active = value;
    paint();
    items[choices.findIndex((c) => c.value === value)]?.scrollIntoView({ block: "nearest" });
  }
  function commit(value: string): void {
    if (value !== current) {
      current = value;
      onChange(value);
    }
    paint();
  }
  function open(): void {
    if (!list.hidden) return;
    active = current;
    list.hidden = false;
    // Open upward when the list wouldn't fit below.
    const rect = button.getBoundingClientRect();
    el.classList.toggle("upward", window.innerHeight - rect.bottom < Math.min(320, list.scrollHeight + 12) && rect.top > window.innerHeight - rect.bottom);
    button.setAttribute("aria-expanded", "true");
    paint();
    list.focus({ preventScroll: true });
    items[choices.findIndex((c) => c.value === active)]?.scrollIntoView({ block: "nearest" });
    document.addEventListener("pointerdown", onOutside, true);
  }
  function close(refocus: boolean): void {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (refocus) button.focus({ preventScroll: true });
  }
  function onOutside(event: PointerEvent): void {
    if (!el.contains(event.target as Node)) close(false);
  }
  function move(delta: number): void {
    const enabled = choices.filter((c) => !disabled.has(c.value));
    const index = enabled.findIndex((c) => c.value === active);
    const next = enabled[Math.max(0, Math.min(enabled.length - 1, index + delta))];
    if (next) setActive(next.value);
  }

  button.addEventListener("click", () => (list.hidden ? open() : close(true)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    }
  });
  list.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        move(-choices.length);
        break;
      case "End":
        move(choices.length);
        break;
      case "Enter":
      case " ":
        if (!disabled.has(active)) commit(active);
        close(true);
        break;
      case "Escape":
      case "Tab":
        close(event.key === "Escape");
        if (event.key === "Tab") return;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  paint();
  return {
    el,
    set(value: string) {
      current = value;
      paint();
    },
    setDisabled(values: string[]) {
      disabled = new Set(values);
      paint();
    },
  };
}

export interface Stepper {
  el: HTMLElement;
  setText(text: string, emphasised: boolean): void;
}

/** A segmented − value + control; clicking the value calls `onReset`. */
export function stepper(onStep: (delta: number) => void, onReset: () => void, labels: { less: string; more: string; reset: string }): Stepper {
  const el = document.createElement("div");
  el.className = "segmented stepper";
  const less = document.createElement("button");
  less.type = "button";
  less.className = "segment step";
  less.textContent = "−";
  less.setAttribute("aria-label", labels.less);
  const value = document.createElement("button");
  value.type = "button";
  value.className = "segment step-value";
  value.title = labels.reset;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "segment step";
  more.textContent = "+";
  more.setAttribute("aria-label", labels.more);
  less.addEventListener("click", () => onStep(-1));
  more.addEventListener("click", () => onStep(1));
  value.addEventListener("click", onReset);
  el.append(less, value, more);
  return {
    el,
    setText(text: string, emphasised: boolean) {
      value.textContent = text;
      value.classList.toggle("custom", emphasised);
    },
  };
}

export interface Chips {
  el: HTMLElement;
  set(values: string[]): void;
  /** Disables a chip (shown off, with `reason` as its title), or enables it again with null. */
  setDisabled(value: string, reason: string | null): void;
}

/**
 * A wrap of rectangular toggle chips, any number selected. `locked` values are always on (and
 * can't be switched off).
 */
export function chips(choices: Choice[], initial: string[], onChange: (values: string[]) => void, locked: string[] = []): Chips {
  const el = document.createElement("div");
  el.className = "chips";
  el.setAttribute("role", "group");
  let selected = new Set([...initial, ...locked]);
  const buttons = choices.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = choice.label;
    if (locked.includes(choice.value)) {
      button.disabled = true;
      button.title = "Always included";
    }
    button.addEventListener("click", () => {
      if (locked.includes(choice.value)) return;
      if (selected.has(choice.value)) selected.delete(choice.value);
      else selected.add(choice.value);
      paint();
      onChange(choices.map((c) => c.value).filter((v) => selected.has(v)));
    });
    el.appendChild(button);
    return button;
  });
  const unavailable = new Set<string>();
  function paint(): void {
    choices.forEach((choice, i) => {
      const on = selected.has(choice.value) && !unavailable.has(choice.value);
      buttons[i]!.classList.toggle("selected", on);
      buttons[i]!.setAttribute("aria-pressed", String(on));
    });
  }
  paint();
  return {
    el,
    set(values: string[]) {
      selected = new Set([...values, ...locked]);
      paint();
    },
    setDisabled(value: string, reason: string | null) {
      const i = choices.findIndex((c) => c.value === value);
      const button = buttons[i];
      if (!button || locked.includes(value)) return;
      if (reason) unavailable.add(value);
      else unavailable.delete(value);
      button.disabled = reason !== null;
      button.title = reason ?? "";
      paint();
    },
  };
}

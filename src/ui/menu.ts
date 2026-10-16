import { h } from "../lib/dom";
import { icon, type IconName } from "../lib/icons";

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider before this item. */
  separator?: boolean;
  hint?: string;
  run: () => void | Promise<void>;
}

let current: { close: () => void } | null = null;

export function closeMenu(): void {
  current?.close();
}

/** Compact context menu positioned at the pointer, kept inside the window. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const buttons: HTMLButtonElement[] = [];
  const menu = h("div", { class: "context-menu", role: "menu" });
  for (const item of items) {
    if (item.separator) menu.append(h("hr"));
    const button = h(
      "button",
      {
        class: `menu-item${item.danger ? " danger" : ""}`,
        role: "menuitem",
        type: "button",
        disabled: item.disabled,
        onclick: () => {
          close();
          void item.run();
        },
      },
      item.icon ? icon(item.icon, 15) : h("span", { class: "icon-spacer" }),
      h("span", { class: "menu-label" }, item.label),
      item.hint ? h("kbd", null, item.hint) : null,
    );
    buttons.push(button);
    menu.append(button);
  }
  document.querySelector("#overlay-root")?.append(menu);

  const margin = 8;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;

  const enabled = buttons.filter((button) => !button.disabled);
  let focused = -1;
  const focusAt = (index: number) => {
    if (enabled.length === 0) return;
    focused = (index + enabled.length) % enabled.length;
    enabled[focused].focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(focused + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(focused - 1);
    }
  };
  const onOutside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("wheel", close, true);
    menu.remove();
    if (current?.close === close) current = null;
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("wheel", close, { capture: true, passive: true });
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  current = { close };
}

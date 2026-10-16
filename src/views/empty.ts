import { h } from "../lib/dom";
import { icon, type IconName } from "../lib/icons";

/** Thin icon, one sentence, at most one action. No illustrations. */
export function emptyState(iconName: IconName, title: string, text: string, action?: { label: string; run: () => void }): HTMLElement {
  return h(
    "div",
    { class: "empty-state" },
    icon(iconName, 40),
    h("h2", null, title),
    h("p", null, text),
    action ? h("button", { class: "subtle", type: "button", onclick: action.run }, action.label) : null,
  );
}

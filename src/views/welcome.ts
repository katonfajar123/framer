import { addFolder } from "../actions";
import { h, mount } from "../lib/dom";
import { icon } from "../lib/icons";
import type { View } from "./view";

/** First launch: no account, no setup, one button. */
export function createWelcomeView(scroller: HTMLElement): View {
  mount(
    scroller,
    h(
      "div",
      { class: "welcome" },
      h("div", { class: "welcome-mark" }, icon("images", 36)),
      h("h1", null, "Welcome to Framer"),
      h(
        "p",
        { class: "welcome-lead" },
        "All your moments, beautifully in one place.",
      ),
      h(
        "button",
        {
          class: "primary large",
          type: "button",
          onclick: () => void addFolder(),
        },
        icon("folder-plus", 18),
        "Choose your photo folders",
      ),
      h(
        "p",
        { class: "welcome-note" },
        icon("shield", 14),
        "Your original files will stay where they are.",
      ),
      h(
        "div",
        { class: "welcome-points" },
        h(
          "div",
          null,
          h("strong", null, "Local-first"),
          h("span", null, "No account, no cloud upload"),
        ),
        h(
          "div",
          null,
          h("strong", null, "No import required"),
          h("span", null, "Framer indexes files in place"),
        ),
        h(
          "div",
          null,
          h("strong", null, "You stay in control"),
          h("span", null, "Remove a folder without deleting a file"),
        ),
      ),
    ),
  );
  return { gallery: false, dispose: () => mount(scroller) };
}

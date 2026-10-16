import { h } from "../lib/dom";

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  const element = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message.replace(/^Error:\s*/, ""));
  root.append(element);
  window.setTimeout(() => {
    element.classList.add("leaving");
    window.setTimeout(() => element.remove(), 200);
  }, kind === "error" ? 6000 : 3600);
}

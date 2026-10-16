import { h } from "../lib/dom";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions get a red button and start with Cancel focused. */
  danger?: boolean;
}

let open: HTMLElement | null = null;

/** Modal confirmation. Resolves `true` only when the user explicitly confirms. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  open?.remove();
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      open = null;
      previousFocus?.focus?.();
      resolve(value);
    };
    const cancel = h("button", { class: "subtle", type: "button", onclick: () => finish(false) }, options.cancelLabel ?? "Cancel");
    const confirm = h(
      "button",
      { class: options.danger ? "primary danger" : "primary", type: "button", onclick: () => finish(true) },
      options.confirmLabel,
    );
    const backdrop = h(
      "div",
      {
        class: "dialog-backdrop",
        onmousedown: (event: MouseEvent) => {
          if (event.target === backdrop) finish(false);
        },
      },
      h(
        "div",
        { class: "dialog", role: "alertdialog", aria: { modal: true, labelledby: "dialog-title", describedby: "dialog-message" } },
        h("h2", { id: "dialog-title" }, options.title),
        h("p", { id: "dialog-message" }, options.message),
        h("div", { class: "dialog-actions" }, cancel, confirm),
      ),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === cancel ? confirm : cancel).focus();
      } else if (event.key === "Enter" && document.activeElement === cancel) {
        // Enter on the focused button must not leak to the gallery shortcuts behind the dialog.
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.querySelector("#overlay-root")?.append(backdrop);
    open = backdrop;
    (options.danger ? cancel : confirm).focus();
  });
}

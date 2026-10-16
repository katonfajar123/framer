export type Child = Node | string | number | null | undefined | false | Child[];

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style" | "dataset" | "children" | "className">
> & {
  class?: string;
  style?: string;
  data?: Record<string, string | number | undefined>;
  aria?: Record<string, string | number | boolean | undefined>;
  [attribute: `on${string}`]: unknown;
};

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    child.forEach((item) => append(parent, item));
    return;
  }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/** Tiny hyperscript helper: `h("button", { class: "primary", onclick }, icon, "Save")`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = String(value);
      else if (key === "style") element.setAttribute("style", String(value));
      else if (key === "data") {
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
          if (item !== undefined) element.dataset[name] = String(item);
        }
      } else if (key === "aria") {
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
          if (item !== undefined) element.setAttribute(`aria-${name}`, String(item));
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in element) {
        (element as unknown as Record<string, unknown>)[key] = value;
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  children.forEach((child) => append(element, child));
  return element;
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function mount(parent: Element, ...children: Child[]): void {
  clear(parent);
  children.forEach((child) => append(parent, child));
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let timer = 0;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

/** True when the user is typing somewhere, so global shortcuts should stay out of the way. */
export function isTyping(target: EventTarget | null = document.activeElement): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

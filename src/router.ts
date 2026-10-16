import { bus, routeKey, state, type Route } from "./state";

/** Back/forward history across views, like a browser, so Alt+← returns to where you were. */
const history: Route[] = [];
let position = -1;
let mounter: ((route: Route) => void) | null = null;

export function setMounter(fn: (route: Route) => void): void {
  mounter = fn;
}

function sameRoute(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b) && a.focusId === b.focusId;
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const current = history[position];
  if (current && sameRoute(current, route) && !route.focusId) return;
  if (options.replace && position >= 0) {
    history[position] = route;
  } else {
    history.splice(position + 1);
    history.push(route);
    position = history.length - 1;
  }
  apply(route);
}

function apply(route: Route): void {
  state.route = route;
  bus.emit("route");
  mounter?.(route);
}

export function canGoBack(): boolean {
  return position > 0;
}

export function canGoForward(): boolean {
  return position < history.length - 1;
}

export function goBack(): void {
  if (!canGoBack()) return;
  position -= 1;
  apply(history[position]);
}

export function goForward(): void {
  if (!canGoForward()) return;
  position += 1;
  apply(history[position]);
}

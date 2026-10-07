import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * The few pages beside the game (sign in, account, history, a game's replay,
 * the admin pages) are plain paths. No router library: the History API, and a
 * hook that re-renders on navigation.
 */

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== "undefined") window.addEventListener("popstate", notify);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current path; re-renders on navigate() and Back/Forward. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  notify();
}

/** A path from `?next=` worth going to: one on this site, never another's. */
export function nextPath(fallback = "/"): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}

/** A link that navigates in place (a new tab, or a modifier click, as usual). */
export function Link({ to, newTab, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; newTab?: boolean }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (newTab || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return createElement("a", { ...rest, href: to, onClick, ...(newTab ? { target: "_blank", rel: "noopener" } : {}) });
}

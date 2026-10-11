// The installed app (the PWA, opened from its icon) keeps the player's seat.
//
// In a browser tab, a player is that tab (see api.ts): the identity token lives
// in sessionStorage under the tab's window.name, and a refresh re-enters the
// room through the ?join= in the URL. A phone, though, closes an installed app
// whenever it likes, and the next launch is a new window at the manifest's
// start_url ("/"): no window.name, no session storage, no ?join=. So the
// installed app keeps both in localStorage instead: the token, and the room it
// was last in, put back in the URL at launch. Storage can be unavailable
// (private mode, blocked site data); then it works like a tab.

const TOKEN_KEY = "skyteam.app.token";
const ROOM_KEY = "skyteam.app.room";

/** Opened as the installed app (Chrome/Edge/Android: display-mode; iOS: navigator.standalone). */
export function isInstalled(): boolean {
  const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return standalone || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // not kept: the next launch starts at the start page
  }
}

export const installedToken = (): string | null => read(TOKEN_KEY);
export const storeInstalledToken = (token: string): void => write(TOKEN_KEY, token);

/** The room the installed app is in (its invite code), or none. A tab keeps nothing. */
export function rememberRoom(inviteCode: string | null): void {
  if (isInstalled()) write(ROOM_KEY, inviteCode);
}

/**
 * At launch, before the app renders: on the start page, go back into the
 * remembered room (App's ?join= path does the rest, with the kept token). A
 * launch that already has ?join= (an invite link) keeps it, and that room is
 * the one remembered from now on.
 */
export function resumeRoom(): void {
  if (!isInstalled()) return;
  const join = new URLSearchParams(window.location.search).get("join");
  if (join) return rememberRoom(join);
  const room = read(ROOM_KEY);
  if (room && window.location.pathname === "/") window.history.replaceState(null, "", `/?join=${encodeURIComponent(room)}`);
}

import { SERVER_URL } from "./config";
import { uuid } from "./uuid";

// Each browser TAB must be an independent player. Storage alone can't guarantee
// this: localStorage is shared across all tabs, and sessionStorage is *copied*
// into any tab opened from another (clicking the invite link, "open in new tab",
// duplicate) — so the new tab inherits the host's token and becomes the host.
//
// `window.name` is the fix: it is unique per tab, survives reloads/navigations
// within the same tab (so reconnect-to-same-seat still works), but a newly
// opened tab starts blank rather than inheriting it. We mint a per-tab id there
// and namespace the identity token by it, so two tabs are always two players.
const TAB_PREFIX = "skyteam-tab:";

function tabId(): string {
  if (!window.name.startsWith(TAB_PREFIX)) {
    window.name = TAB_PREFIX + uuid();
  }
  return window.name;
}

const tokenKey = () => `${tabId()}.token`;

export function getStoredToken(): string | null {
  return sessionStorage.getItem(tokenKey());
}

export function storeToken(token: string): void {
  sessionStorage.setItem(tokenKey(), token);
}

interface RoomResponse {
  roomId: string;
  inviteCode: string;
  token: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function createRoom(): Promise<RoomResponse> {
  const data = await post<RoomResponse>("/rooms", { token: getStoredToken() });
  storeToken(data.token);
  return data;
}

export async function joinRoom(code: string): Promise<RoomResponse> {
  const data = await post<RoomResponse>(`/rooms/${code}/join`, { token: getStoredToken() });
  storeToken(data.token);
  return data;
}

// Shared, environment-agnostic tunables.
//
// These are plain constants so they can be safely imported by both the server
// (Node) and the client (browser bundle). The server may OVERRIDE the grace
// window via the RECONNECT_GRACE_MS env var — see packages/server/src/env.ts.

/** Default time a disconnected player's seat is held before the game is abandoned. */
export const DEFAULT_RECONNECT_GRACE_MS = 60_000;

/** How long an inactive room is kept in Redis before it expires (seconds). */
export const ROOM_TTL_SECONDS = 60 * 60; // 1 hour

/** Maximum number of seated players in a room. Observers are unlimited. */
export const MAX_PLAYERS = 2;

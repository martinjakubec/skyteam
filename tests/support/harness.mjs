// A live server for end-to-end tests: HTTP and Socket.IO on a localhost port,
// clients that can carry the sign-in cookie, and helpers to play.
//
// The test file mocks ioredis and pg and sets process.env (DATABASE_URL,
// TRUST_PROXY=1, …) before importing this — modules read env when they load.
import { expect } from "vitest";
import { io as connect } from "socket.io-client";

const http = await import("node:http");
const { createApp } = await import("../../packages/server/src/http.ts");
const { attachSocket } = await import("../../packages/server/src/socket.ts");
const { initGameLogs } = await import("../../packages/server/src/gameLog.ts");
const { stopThinking } = await import("../../packages/server/src/think.ts");
const { actorFor, quickMove, mulberry32 } = await import("../../packages/shared/src/index.ts");

/** Start the server; `close()` stops it and every client. */
export async function startServer() {
  const server = http.createServer(createApp());
  attachSocket(server);
  await initGameLogs();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  let nextAddress = 1;
  const freshAddress = () => `10.9.${nextAddress >> 8}.${nextAddress++ & 255}`;

  /** One HTTP request: status, JSON body, and the session cookie it set. */
  async function api(method, path, { body, cookie, from = freshAddress() } = {}) {
    const headers = { "content-type": "application/json", "x-forwarded-for": from };
    if (cookie) headers.cookie = `skyteam_session=${cookie}`;
    const res = await fetch(url + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie ? /^skyteam_session=([^;]*)/.exec(setCookie)?.[1] : undefined };
  }

  /** A registered user's session cookie (and the user). */
  async function signUp(username, password = "ten chars!") {
    const r = await api("POST", "/api/auth/register", { body: { username, password } });
    expect(r.status).toBe(201);
    return { cookie: r.cookie, user: r.body.user };
  }

  /** A socket client (signed in with `cookie`, if given) that keeps every
   *  room:state and game:event. */
  async function client(cookie) {
    const sock = connect(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      ...(cookie ? { extraHeaders: { cookie: `skyteam_session=${cookie}` } } : {}),
    });
    sockets.push(sock);
    sock.states = [];
    sock.events = [];
    sock.game = null;
    sock.version = -1;
    sock.on("room:state", (s) => (sock.states.push(s), (sock.game = s.game), (sock.version = s.version)));
    sock.on("game:event", (e) => (sock.events.push(e), (sock.game = e.game), (sock.version = e.version)));
    await new Promise((resolve, reject) => (sock.once("connect", resolve), sock.once("connect_error", reject)));
    return sock;
  }

  /** A host (and a guest unless solo) seated and joined; cookies sign them in. */
  async function room({ hostCookie, guestCookie, solo, sameDiceAs } = {}) {
    const host = await api("POST", "/rooms", { body: { ...(solo ? { solo } : {}), ...(sameDiceAs ? { sameDiceAs } : {}) } });
    expect(host.status).toBe(200);
    const h = await client(hostCookie);
    expect(await emit(h, "room:join", { roomId: host.body.roomId, token: host.body.token })).toEqual({ ok: true });
    let g = null, guestToken = null;
    if (!solo) {
      const guest = await api("POST", `/rooms/${host.body.inviteCode}/join`, {});
      guestToken = guest.body.token;
      g = await client(guestCookie);
      expect(await emit(g, "room:join", { roomId: guest.body.roomId, token: guestToken })).toEqual({ ok: true });
    }
    return { h, g, roomId: host.body.roomId, hostToken: host.body.token, guestToken };
  }

  /** Both ready (a solo room's bot always is), then the host starts. */
  async function start(r) {
    await emit(r.h, "seat:ready", { ready: true });
    if (r.g) await emit(r.g, "seat:ready", { ready: true });
    expect(await emit(r.h, "game:start")).toEqual({ ok: true });
    await until(() => latest(r.h)?.status === "in_progress", 5000, "game start");
  }

  /** Play quick legal moves (and press Ready between rounds) until the game ends. */
  async function playToEnd(r, rand = mulberry32(11)) {
    const socks = { pilot: r.h, copilot: r.g };
    const hostCrew = latest(r.h).hostCrew;
    if (hostCrew === "copilot") [socks.pilot, socks.copilot] = [r.g, r.h];
    for (let i = 0; i < 2000 && latest(r.h).status === "in_progress"; i++) {
      const snap = latest(r.h);
      if (snap.debrief) {
        for (const s of [r.h, r.g].filter(Boolean)) await emit(s, "round:ready", { ready: true });
        await until(() => latest(r.h).debrief === null || latest(r.h).status !== "in_progress", 3000, "the deal");
        continue;
      }
      const crew = actorFor(r.h.game);
      const sock = crew && socks[crew];
      if (!sock) {
        await new Promise((res) => setTimeout(res, 20));
        continue;
      }
      const v = sock.version;
      const res = await emit(sock, "game:command", { commandId: `c${Math.random()}`, command: quickMove(sock.game, crew, rand) });
      expect(res).toEqual({ ok: true });
      await until(() => sock.version > v, 2000, "move broadcast");
      await new Promise((res2) => setTimeout(res2, 55)); // under the flood limit
    }
    await until(() => latest(r.h).status === "finished", 3000, "the end");
  }

  return {
    url,
    api,
    signUp,
    client,
    room,
    start,
    playToEnd,
    async close() {
      for (const s of sockets) s.disconnect();
      await stopThinking();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const emit = (sock, event, payload) =>
  new Promise((resolve) => (payload === undefined ? sock.emit(event, resolve) : sock.emit(event, payload, resolve)));

/** Wait until `pred` holds (polled; it may be async), or fail after `ms`. */
export async function until(pred, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const latest = (sock) => sock.states.at(-1);

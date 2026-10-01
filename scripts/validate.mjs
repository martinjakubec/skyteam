// End-to-end flow validation against a running server (compose network).
//   node:22-alpine, repo bind-mounted, targeting the `server` service.
import { io } from "socket.io-client";

const BASE = process.env.BASE ?? "http://server:3001";
let failures = 0;

function check(label, cond) {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}`);
  if (!cond) failures++;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function connect() {
  const s = io(BASE, { transports: ["websocket"], reconnection: false, forceNew: true });
  s.state = null; // latest room:state snapshot
  s.on("room:state", (snap) => (s.state = snap));
  return s;
}

function waitFor(socket, event, pred = () => true, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    function handler(payload) {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

const emit = (socket, event, ...args) =>
  new Promise((resolve) => socket.emit(event, ...args, resolve));

async function main() {
  console.log("1) HTTP: create + join");
  const host = await post("/rooms");
  check("host got roomId + inviteCode + token", !!host.roomId && !!host.inviteCode && !!host.token);
  const guest = await post(`/rooms/${host.inviteCode}/join`);
  check("guest joined, got own token", !!guest.token && guest.roomId === host.roomId);

  console.log("2) Sockets: both join the room");
  const a = connect();
  const b = connect();
  await waitFor(a, "connect");
  await waitFor(b, "connect");
  const aTwoSeats = waitFor(a, "room:state", (s) => s.seats.length === 2);
  await emit(a, "room:join", { roomId: host.roomId, token: host.token });
  await emit(b, "room:join", { roomId: guest.roomId, token: guest.token });
  const lobby = await aTwoSeats;
  check("host sees 2 seats in lobby", lobby.seats.length === 2 && lobby.status === "lobby");

  console.log("2b) Game setup: host-only, validated, broadcast in the snapshot");
  check("lobby snapshot carries the default setup", lobby.setup?.scenarioId === "YUL" && lobby.setup.modules.length === 0);
  check("guest setup change rejected", (await emit(b, "room:setup", { scenarioId: "YUL", modules: [] })).ok === false);
  check("unimplemented module rejected", (await emit(a, "room:setup", { scenarioId: "YUL", modules: ["intern"] })).ok === false);
  check("Ice Brakes + Kerosene Leak accepted", (await emit(a, "room:setup", { scenarioId: "YUL", modules: ["keroseneLeak", "iceBrakes"] })).ok === true);
  check("Kerosene + Kerosene Leak together rejected", (await emit(a, "room:setup", { scenarioId: "YUL", modules: ["kerosene", "keroseneLeak"] })).ok === false);
  check("unknown airport rejected", (await emit(a, "room:setup", { scenarioId: "XXX", modules: [] })).ok === false);
  check("host setup accepted", (await emit(a, "room:setup", { scenarioId: "YUL", modules: [] })).ok === true);

  console.log("3) Ready up (both) -> status ready");
  await emit(a, "seat:ready", { ready: true });
  const ready = waitFor(a, "room:state", (s) => s.status === "ready");
  await emit(b, "seat:ready", { ready: true });
  check("status becomes 'ready'", (await ready).status === "ready");

  console.log("3b) Host enables Kerosene -> guest is un-readied and must confirm");
  const unreadied = waitFor(b, "room:state", (s) => s.setup.modules.includes("kerosene"));
  check("host enables Kerosene", (await emit(a, "room:setup", { scenarioId: "YUL", modules: ["kerosene"] })).ok === true);
  const afterSetup = await unreadied;
  const guestSeat = afterSetup.seats.find((s) => s.role === "guest");
  const hostSeat = afterSetup.seats.find((s) => s.role === "host");
  check("guest un-readied, host still ready", !guestSeat.ready && hostSeat.ready && afterSetup.status === "lobby");
  check("host can't start until the guest re-confirms", (await emit(a, "game:start")).ok === false);
  const readyAgain = waitFor(a, "room:state", (s) => s.status === "ready");
  await emit(b, "seat:ready", { ready: true });
  check("guest re-readies -> status 'ready'", (await readyAgain).status === "ready");

  console.log("4) Only host can start; game initialises");
  check("guest start rejected", (await emit(b, "game:start")).ok === false);
  const aStarted = waitFor(a, "room:state", (s) => s.status === "in_progress" && !!s.game);
  const bStarted = waitFor(b, "room:state", (s) => s.status === "in_progress" && !!s.game);
  check("host start accepted", (await emit(a, "game:start")).ok === true);
  const hostGame = (await aStarted).game;
  const guestGame = (await bStarted).game;
  check("guest sees an in-progress SkyTeam game", guestGame.round === 1 && guestGame.phase === "placement");
  check("pilot (host) leads round 1", guestGame.turn === "pilot");
  check("game has Kerosene in play, tank full", guestGame.scenario.modules?.includes("kerosene") && guestGame.kerosene === 20);

  console.log("5) Hidden dice: each player only sees their own dice values");
  check("host sees its own (pilot) dice values", hostGame.dice.pilot.every((d) => typeof d.value === "number"));
  check("guest CANNOT see pilot's unplaced dice", guestGame.dice.pilot.every((d) => d.hidden === true && d.value === undefined));
  check("guest sees its own (copilot) dice values", guestGame.dice.copilot.every((d) => typeof d.value === "number"));

  console.log("6) Realtime: pilot places a die on the Axis -> guest sees it");
  const guestSawEvent = waitFor(b, "game:event", (m) => m.game.axis.pilot !== null);
  const ack = await emit(a, "game:command", {
    commandId: "c1",
    command: { type: "placeDie", dieId: 0, target: { kind: "axis" } },
  });
  check("placeDie ack ok", ack.ok === true);
  const evt = await guestSawEvent;
  check("guest received the axis placement", evt.game.axis.pilot !== null && evt.version === 1);
  check("turn passed to the co-pilot", evt.game.turn === "copilot");

  console.log("7) Observers / out-of-turn / invalid input rejected");
  const obs = await post(`/rooms/${host.inviteCode}/join`); // 3rd participant -> observer
  const o = connect();
  await waitFor(o, "connect");
  await emit(o, "room:join", { roomId: obs.roomId, token: obs.token });
  const obsCmd = await emit(o, "game:command", { commandId: "x", command: { type: "placeDie", dieId: 0, target: { kind: "axis" } } });
  check("observer command rejected", obsCmd.ok === false);
  const outOfTurn = await emit(a, "game:command", { commandId: "y", command: { type: "placeDie", dieId: 1, target: { kind: "engine" } } });
  check("pilot acting out of turn rejected", outOfTurn.ok === false);

  console.log("7b) Kerosene: the co-pilot burns a die's value");
  const keroDie = evt.game.dice.copilot.find((d) => !d.placed);
  const hostSawKero = waitFor(a, "game:event", (m) => m.game.keroseneSlot !== null);
  const keroAck = await emit(b, "game:command", { commandId: "k1", command: { type: "placeDie", dieId: keroDie.id, target: { kind: "kerosene" } } });
  check("kerosene placement ack ok", keroAck.ok === true);
  const keroEvt = await hostSawKero;
  check("tank dropped by the die's value", keroEvt.game.kerosene === 20 - keroDie.value);
  check("seated die is public to the pilot", keroEvt.game.keroseneSlot.value === keroDie.value && keroEvt.game.keroseneSlot.crew === "copilot");

  console.log("8) Reconnect: guest drops and resyncs with game intact");
  const hostSeesDisconnect = waitFor(a, "room:state", (s) =>
    s.seats.some((seat) => seat.role === "guest" && seat.connection === "disconnected"),
  );
  b.disconnect();
  await hostSeesDisconnect;
  check("host sees guest disconnected", true);

  const b2 = connect();
  await waitFor(b2, "connect");
  await emit(b2, "room:join", { roomId: guest.roomId, token: guest.token });
  const snap = await waitFor(b2, "room:state", (s) => !!s.game);
  check("resync preserves the game (axis still set, round 1)", snap.game.axis.pilot !== null && snap.game.round === 1);
  check("resync still hides pilot's unplaced dice", snap.game.dice.pilot.some((d) => d.hidden));

  for (const s of [a, b2, o]) s.close();
  console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});

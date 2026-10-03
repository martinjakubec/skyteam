// End-to-end: the solo bot is woken by a Real-Time time-up.
//
// Starts its own server (port 3101) with Real-Time rounds shortened to
// TEST_REAL_TIME_SECONDS — the dev server and real games keep 60 s — then
// plays a solo game: we fly Pilot, the bot flies Co-Pilot. In round 1 we place
// our Axis, Engine and Radio dice and hold our last die until time runs out.
// If the bot has placed its own Axis and Engine dice by then, the time-up ends
// the round and round 2 opens — led by the Co-Pilot, so the bot must wake and
// play with no command from us. (If it hasn't, the time-up loses the game;
// the bot chooses its own dice, so we retry with a fresh room.)
//
// Run inside the dev stack's client container (Redis at redis://redis:6379):
//   docker compose -f docker-compose.dev.yml exec client node scripts/validate-realtime-bot.mjs
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

/** The test's Real-Time round length — overrides the server's 60 s. */
const TEST_REAL_TIME_SECONDS = 3;
const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const ATTEMPTS = 8;

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("npx", ["tsx", "packages/server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    REDIS_URL: process.env.REDIS_URL ?? "redis://redis:6379",
    CLIENT_ORIGIN: "*",
    REAL_TIME_SECONDS: String(TEST_REAL_TIME_SECONDS),
    NPC_DELAY_MS: "100",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = (code) => {
  server.kill();
  process.exit(code);
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const emit = (s, event, ...args) => new Promise((resolve) => s.emit(event, ...args, resolve));

/** One solo game: true if a time-up opened round 2 and the bot played in it,
 *  false if the time-up lost the game (retry), throws on anything else. */
async function attempt(n) {
  const room = await post("/rooms", { solo: { crew: "pilot", level: "navigator" } });
  const s = io(BASE, { transports: ["websocket"], reconnection: false, forceNew: true });
  let game = null;
  let status = "lobby";
  let botInRound2 = false;
  s.on("room:state", (snap) => {
    status = snap.status;
    if (snap.game) game = snap.game;
  });
  const reason = () => game?.outcome?.reason ?? "";
  s.on("game:event", (m) => {
    game = m.game;
    if (m.byPlayerId.startsWith("bot:") && m.game.round === 2) botInRound2 = true;
  });
  await new Promise((r) => s.on("connect", r));
  await emit(s, "room:join", { roomId: room.roomId, token: room.token });
  await emit(s, "room:setup", { scenarioId: "YUL", modules: ["realTime"], abilities: [] });
  await emit(s, "seat:ready", { ready: true });
  await emit(s, "game:start");

  // Round 1: our Axis, Engine and Radio on our turns; then hold the last die.
  const plan = [{ kind: "axis" }, { kind: "engine" }, { kind: "radio", slot: 0 }];
  const deadline = Date.now() + 15000;
  while (plan.length && Date.now() < deadline) {
    if (game?.round === 1 && game.turn === "pilot" && game.phase === "placement" && !game.pendingReroll && !game.pendingSwap) {
      const die = game.dice.pilot.find((d) => !d.placed);
      const ack = await emit(s, "game:command", { commandId: `${n}-${plan.length}`, command: { type: "placeDie", dieId: die.id, target: plan[0] } });
      if (ack.ok) plan.shift();
    }
    await sleep(30);
  }
  if (plan.length) throw new Error(`couldn't place our round-1 dice (status ${status}, turn ${game?.turn})`);

  // Wait out the round: a time-up either opens round 2 or loses the game.
  const until = Date.now() + (TEST_REAL_TIME_SECONDS + 6) * 1000;
  while (Date.now() < until && !botInRound2 && status !== "finished") await sleep(50);
  s.close();
  if (botInRound2) return true;
  if (status === "finished") {
    if (process.env.DEBUG) console.log(`    attempt ${n}: ${reason()} — copilot axis ${game?.axis.copilot}, engine ${game?.engines.copilot}, placed ${game?.dice.copilot.filter((d) => d.placed).length}`);
    return false;
  }
  throw new Error(`no time-up outcome (status ${status}, round ${game?.round}, turn ${game?.turn})`);
}

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await (await fetch(`${BASE}/health`)).json()).ok) break;
    } catch {}
    await sleep(500);
  }
  console.log(`Real-Time time-up wakes the solo bot (rounds of ${TEST_REAL_TIME_SECONDS} s, own server on :${PORT})`);
  let woke = false;
  let losses = 0;
  for (let n = 1; n <= ATTEMPTS && !woke; n++) {
    if (await attempt(n)) woke = true;
    else losses++;
  }
  console.log(`  (time-ups that lost the game first, as the bot hadn't placed its Axis and Engine: ${losses})`);
  check("after a time-up opens round 2, the bot (Co-Pilot, leading) plays without any command from us", woke);
  check("the server logged no bot errors", !/\[npc\]/.test(serverLog));
  console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  stop(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message, "\n--- server log ---\n", serverLog.slice(-2000));
  stop(1);
});

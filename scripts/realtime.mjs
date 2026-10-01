// Real-Time module against the running dev stack, in real time (~2.5 min):
//   A) nobody places a die → when the 60s run out, the game is lost;
//   B) Axis + Engines set, then time's up → the next round, a fresh 60s;
//   C) a seat drops mid-round → the clock pauses (no placing meanwhile) and
//      resumes from the same time left when the player is back.
// Run via scripts/realtime.sh.
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "  ✅" : "  ❌"} ${label}${extra ? ` (${extra})` : ""}`); if (!cond) failures++; };
const browser = await chromium.launch();

async function player(ctx) {
  const page = await ctx.newPage();
  const me = { ctx, page, game: null, room: null };
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    if (typeof payload !== "string" || !payload.startsWith("42")) return;
    const [ev, d] = JSON.parse(payload.slice(2));
    if (ev === "room:state") { me.room = d; if (d.game) me.game = d.game; }
    if (ev === "game:event") me.game = d.game;
  }));
  return me;
}
async function startGame() {
  const a = await player(await browser.newContext({ viewport: { width: 1280, height: 1000 } }));
  const bctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const b = await player(bctx);
  await a.page.goto(BASE);
  await a.page.getByRole("button", { name: "Create a room" }).click();
  const link = await a.page.locator(".panel input").first().inputValue();
  await b.page.goto(link);
  await b.page.getByRole("button", { name: "Ready up" }).waitFor();
  await a.page.getByLabel("Real Time", { exact: true }).click();
  await b.page.waitForFunction(() => [...document.querySelectorAll(".setup-modules label")].some((l) => l.textContent === "Real Time" && l.querySelector("input").checked));
  await a.page.getByRole("button", { name: "Ready up" }).click();
  await b.page.getByRole("button", { name: "Ready up" }).click();
  await a.page.getByRole("button", { name: "Start game" }).click();
  await a.page.locator(".realtime").waitFor();
  await b.page.locator(".realtime").waitFor();
  return { a, b, link };
}
const crewOf = (p) => (p.game.pilotId === p.room.you.playerId ? "pilot" : "copilot");
async function placeOn(p, kind) {
  const crew = crewOf(p);
  const v0 = JSON.stringify(p.game.dice[crew]) + p.game.turn;
  const dice = p.page.locator(".hand .dice > button.die:not(.intern-die):not(.traffic-die)");
  // Axis: match the partner's die (or aim for the middle) so the plane stays
  // level; Engines: the lowest die, so the plane doesn't race into traffic.
  const other = p.game.axis[crew === "pilot" ? "copilot" : "pilot"];
  const cost = (v) => (kind === "axis" ? Math.abs(v - (other ?? 3.5)) : v);
  const order = p.game.dice[crew].map((d, i) => ({ d, i })).filter(({ d }) => !d.placed).sort((x, y) => cost(x.d.value) - cost(y.d.value));
  for (const { i } of order) {
    if (await dice.nth(i).isDisabled()) continue;
    await dice.nth(i).click();
    const slot = p.page.locator(`.slot[data-open="1"][data-target*='"kind":"${kind}"']`).first();
    if (await slot.count()) { await slot.click(); break; }
  }
  for (let k = 0; k < 60 && JSON.stringify(p.game.dice[crew]) + p.game.turn === v0; k++) await sleep(50);
}
const text = (p) => p.page.locator(".rt-text").textContent();

console.log("A) nobody places a die → time's up loses");
{
  const { a, b } = await startGame();
  const secs = parseInt(await text(a));
  check("countdown shows ~60s on both screens", secs >= 57 && Math.abs(secs - parseInt(await text(b))) <= 1, `${await text(a)} / ${await text(b)}`);
  await sleep(61_500);
  check("the game is lost when time runs out", a.game.phase === "lost" && /time ran out/i.test(a.game.outcome?.reason ?? ""), a.game.outcome?.reason);
  check("both screens agree", (await a.page.locator(".callout").textContent()) === (await b.page.locator(".callout").textContent()));
  await a.ctx.close(); await b.ctx.close();
}

console.log("B) Axis + Engines set, then time's up → next round, fresh countdown");
{
  const { a, b } = await startGame();
  const first = a.game.turn === "pilot" ? [a, b] : [b, a];
  await placeOn(first[0], "axis"); await placeOn(first[1], "axis");
  await placeOn(first[0], "engine"); await placeOn(first[1], "engine");
  check("Axis and Engines placed", a.game.axis.pilot !== null && a.game.axis.copilot !== null && a.game.engines.pilot !== null && a.game.engines.copilot !== null);
  const round = a.game.round;
  for (let k = 0; k < 140 && a.game.round === round && !a.game.outcome; k++) await sleep(500);
  if (a.game.outcome) console.log("     ↳ ended:", a.game.outcome.reason);
  check("time's up moves on to the next round", a.game.round === round + 1 && a.game.phase === "placement", `round ${a.game.round}, ${a.game.phase}`);
  await sleep(1200);
  const secs = parseInt(await text(a));
  check("the new round's countdown starts again at ~60s", secs >= 57, await text(a));
  check("the log says time ran out", a.game.log.some((l) => /Time's up/.test(l)));
  await a.ctx.close(); await b.ctx.close();
}

console.log("C) a disconnect pauses the clock; reconnecting resumes it");
{
  const { a, b, link } = await startGame();
  await sleep(5_000);
  await b.page.goto("about:blank"); // the Co-Pilot's tab loses its connection
  for (let k = 0; k < 40 && a.game.timerRemainingMs === null; k++) await sleep(100);
  const left = a.game.timerRemainingMs;
  check("the Pilot's screen shows the clock paused", /Paused/.test(await text(a)) && /Co-Pilot/.test(await text(a)), await text(a));
  check("about 55s were left", left !== null && left > 52_000 && left <= 56_000, `${left}ms`);
  if (a.game.turn === "pilot") {
    const before = a.game.axis.pilot;
    await placeOn(a, "axis");
    await sleep(500);
    check("placing a die while paused is refused", a.game.axis.pilot === before);
  }
  await sleep(6_000);
  check("still paused 6s later, same time left", a.game.timerRemainingMs === left && /Paused/.test(await text(a)));
  await b.page.goto(link); // …and comes back in the same tab (same identity)
  for (let k = 0; k < 60 && a.game.timerEndsAt === null; k++) await sleep(100);
  check("the clock resumes when the Co-Pilot is back", a.game.timerEndsAt !== null && a.game.timerRemainingMs === null);
  await sleep(600);
  const secs = parseInt(await text(a));
  check("…from where it stopped (~55s, not ~44s)", secs >= 52 && secs <= 56, await text(a));
  check("both screens agree on the time", Math.abs(parseInt(await text(a)) - parseInt(await text(b))) <= 1, `${await text(a)} / ${await text(b)}`);
  await a.ctx.close(); await b.ctx.close();
}

await browser.close();
console.log(failures === 0 ? "\nALL REAL-TIME E2E CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures ? 1 : 0);

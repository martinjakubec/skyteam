// Two-browser end-to-end simulation of real games, one per module combination.
//
// Run with scripts/simulate.sh (Playwright's Docker image, against the running
// dev stack). The Pilot plays on a desktop-sized window, the Co-Pilot on a
// phone-sized one, both through the real UI.
//
// Every combination of the modules the lobby offers is played, except those the
// lobby refuses to tick together (e.g. Kerosene + Kerosene Leak) — so a new
// module is covered automatically. Each turn the active player taps every die
// to read which spaces the UI opens, scores only those moves with a simple
// heuristic, and plays the best one; Intern tokens are dragged (with edge
// auto-scroll). It plays to explore, not to win — losses are normal.
//
// A combination fails if the server rejects a move the UI offered (client and
// server disagree on legality), the game stalls, the two screens disagree on
// the outcome, a page throws, or a space filled by an Intern token isn't drawn
// in Intern colours.
//
// Env: BASE (client URL; an IP or host.docker.internal — Vite rejects other
// hostnames), ONLY (comma-separated combos of "+"-joined lobby labels, e.g.
// "Intern,Kerosene+Ice Brakes"; default: all), REPEAT (games per combo,
// default 1), OUT (dir for failure screenshots).
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://host.docker.internal:5173";
const REPEAT = Number(process.env.REPEAT ?? 1);
const OUT = process.env.OUT ?? ".";
const ONLY = process.env.ONLY?.split(",").map((c) => c.split("+").map((m) => m.trim()).filter(Boolean));
const MAX_MOVES = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

/** A player: a page plus the latest (redacted, per-player) state from its socket frames. */
async function player(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  const me = { page, ctx, game: null, version: -1, pageError: null };
  page.on("websocket", (ws) =>
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith("42")) return;
      const [ev, data] = JSON.parse(payload.slice(2));
      if (ev === "room:state" && data.game) {
        me.game = data.game;
        me.version = data.version;
      }
      if (ev === "game:event") {
        me.game = data.game;
        me.version = data.version;
      }
    }),
  );
  page.on("pageerror", (e) => (me.pageError = e.message));
  return me;
}

const ticked = (p) =>
  p.page.evaluate(() =>
    [...document.querySelectorAll(".setup-modules label")].filter((l) => l.querySelector("input").checked).map((l) => l.textContent),
  );

/** Move heuristic. Legality comes from the UI; this only ranks legal moves. */
function score(g, crew, v, t) {
  const other = crew === "pilot" ? "copilot" : "pilot";
  const mods = g.scenario.modules ?? [];
  const airport = g.scenario.approachTrack.findIndex((s) => s.airport);
  const final = g.round >= g.scenario.rounds;
  switch (t.kind) {
    case "axis": {
      const o = g.axis.offset;
      const theirs = g.axis[other];
      if (theirs !== null) {
        const n = o + (crew === "pilot" ? v - theirs : theirs - v);
        return Math.abs(n) >= g.scenario.axisSpinAt ? -1000 : 60 - Math.abs(n) * 15;
      }
      return 30 - Math.abs(v - (crew === "pilot" ? 3.5 - o : 3.5 + o)) * 6;
    }
    case "engine": {
      const theirs = g.engines[other];
      if (theirs === null) return 25 - v * 2;
      const speed = v + theirs;
      const leak = mods.includes("keroseneLeak") ? Math.abs(v - theirs) + 1 : 0;
      if (leak && g.kerosene <= leak) return -1000;
      if (final) return 50 - speed * 5 - leak * 3;
      const adv = speed <= g.aeroBlue ? 0 : speed > g.aeroOrange ? 2 : 1;
      for (let k = 0; k < adv; k++) {
        const at = g.position + k;
        if (g.airplanes[at] > 0 || at === airport) return -1000;
      }
      const want = (airport - g.position) / Math.max(1, g.scenario.rounds - g.round);
      return 50 - Math.abs(adv - want) * 20 - leak * 4;
    }
    case "radio":
      return g.airplanes[g.position + v - 1] > 0 ? 55 : 2;
    case "landingGear":
    case "flaps":
      return 45;
    case "brakes":
      return 40;
    case "iceBrakes": {
      const st = g.iceBrakeSlots[t.slot];
      return (t.space === "top" ? st.bottom : st.top) != null ? 52 : 28;
    }
    case "kerosene":
      return g.kerosene - v <= 0 ? -1000 : 20 + (6 - v) * 4;
    case "concentration":
      return g.coffee < 3 ? 12 : 3;
    case "intern":
      return 38;
    default:
      return 0;
  }
}

const openTargets = (p) =>
  p.page.evaluate(() => [...new Set([...document.querySelectorAll('.slot[data-open="1"]')].map((e) => e.dataset.target))]);

/** Drag the held Intern token onto `slot` like a person: hold at a screen edge
 *  until the page auto-scrolls the space into view, then aim where it is now. */
async function dragToken(p, slot) {
  await p.page.locator(".hand .intern-die").scrollIntoViewIfNeeded();
  const from = await p.page.locator(".hand .intern-die").boundingBox();
  const vw = p.page.viewportSize();
  await p.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await p.page.mouse.down();
  await p.page.mouse.move(from.x + from.width / 2 + 20, from.y, { steps: 4 });
  let to = await slot.boundingBox();
  if (to.y < 60 || to.y + to.height > vw.height - 60) {
    await p.page.mouse.move(vw.width / 2, to.y < 60 ? 8 : vw.height - 8, { steps: 8 });
    for (let k = 0; k < 120; k++) {
      await sleep(40);
      to = await slot.boundingBox();
      if (to.y > 150 && to.y + to.height < vw.height - 150) break;
    }
  }
  // Leave the auto-scroll zone and let the page settle before aiming.
  await p.page.mouse.move(vw.width / 2, vw.height / 2, { steps: 6 });
  for (let k = 0, prev = null; k < 20; k++) {
    await sleep(40);
    to = await slot.boundingBox();
    if (prev !== null && Math.abs(prev - to.y) < 0.5) break;
    prev = to.y;
  }
  await p.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await p.page.mouse.up();
}

/** Play the active crew's best legal move; throws if the server doesn't take it. */
async function act(p, crew, log) {
  const g = p.game;
  const v0 = p.version;
  let best = null;
  if (g.internHeld?.crew === crew) {
    for (const t of await openTargets(p)) {
      const s = score(g, crew, g.internHeld.value, JSON.parse(t));
      if (!best || s > best.s) best = { s, token: true, value: g.internHeld.value, t };
    }
    if (!best) throw new Error("an Intern token is held but the UI opens no space for it");
    await dragToken(p, p.page.locator(`.slot[data-open="1"][data-target='${best.t}']`).first());
  } else {
    const dice = p.page.locator(".hand .dice > button.die:not(.intern-die)");
    const n = await dice.count();
    // Hold back the lowest die for an open Engine and the most level-friendly
    // one for an open Axis, so spare spaces don't eat them (fewer early crashes).
    const hand = g.dice[crew].filter((d) => !d.placed);
    const lowest = g.engines[crew] === null ? hand.reduce((m, d) => (d.value < m.value ? d : m), hand[0]) : null;
    const axisIdeal = crew === "pilot" ? 3.5 - g.axis.offset : 3.5 + g.axis.offset;
    const levelest = g.axis[crew] === null ? hand.reduce((m, d) => (Math.abs(d.value - axisIdeal) < Math.abs(m.value - axisIdeal) ? d : m), hand[0]) : null;
    const reserve = (d, t) => (t.kind === "axis" || t.kind === "engine" ? 0 : (d === lowest ? 15 : 0) + (d === levelest ? 10 : 0));
    for (let i = 0; i < n; i++) {
      const d = g.dice[crew][i];
      if (d.placed || (await dice.nth(i).isDisabled())) continue;
      await dice.nth(i).click();
      for (const t of await openTargets(p)) {
        const s = score(g, crew, d.value, JSON.parse(t)) - reserve(d, JSON.parse(t));
        if (!best || s > best.s) best = { s, die: i, value: d.value, t };
      }
    }
    if (!best) throw new Error(`the UI offers no legal move (dice ${g.dice[crew].map((d) => (d.placed ? "_" : d.value))})`);
    await dice.nth(best.die).click();
    await p.page.locator(`.slot[data-open="1"][data-target='${best.t}']`).first().click();
  }
  for (let k = 0; k < 120 && p.version === v0; k++) await sleep(50);
  if (p.version === v0) {
    const err = (await p.page.locator("p.error").count()) ? await p.page.locator("p.error").textContent() : "no response";
    throw new Error(`${crew} ${best.token ? "Intern token" : "die"} ${best.value} → ${best.t} not applied: ${err}`);
  }
  log.push(`${crew === "pilot" ? "P" : "C"}${best.token ? "🎓" : ""}${best.value}→${JSON.parse(best.t).kind}`);
}

/** Play one game with `combo`; returns a result, or null if the lobby refuses the combination. */
async function playGame(combo, tag) {
  const a = await player(1280);
  const b = await player(390);
  try {
    await a.page.goto(BASE);
    await a.page.getByRole("button", { name: "Create a room" }).click();
    await b.page.goto(await a.page.locator(".panel input").first().inputValue());
    await b.page.getByRole("button", { name: "Ready up" }).waitFor();
    for (const m of combo) {
      await a.page.getByLabel(m, { exact: true }).click();
      await b.page.waitForFunction((m) => [...document.querySelectorAll(".setup-modules label")].some((l) => l.textContent === m && l.querySelector("input").checked), m);
    }
    await sleep(300);
    if ((await ticked(a)).length !== combo.length) return null; // an exclusive pair unticked one
    await a.page.getByRole("button", { name: "Ready up" }).click();
    await b.page.getByRole("button", { name: "Ready up" }).click();
    await a.page.getByRole("button", { name: "Start game" }).click();
    for (let k = 0; k < 100 && !(a.game && b.game); k++) await sleep(50);

    const log = [];
    let moves = 0;
    let tokens = 0;
    let unmarked = 0;
    try {
      while (!a.game.outcome && moves < MAX_MOVES) {
        const g = a.game;
        const crew = g.internHeld ? g.internHeld.crew : g.turn;
        const wasToken = !!g.internHeld;
        const round = g.round;
        await act(crew === "pilot" ? a : b, crew, log);
        moves++;
        for (let k = 0; k < 100 && b.version !== a.version; k++) await sleep(50);
        // A token placed mid-round must be drawn in Intern colours on both screens.
        // (If it ended the round, the next round has rightly cleared the marks.)
        if (wasToken && !a.game.outcome && a.game.round === round) {
          tokens++;
          await sleep(150);
          const marked = await Promise.all([a, b].map((x) => x.page.locator(".slot.taken.intern").count()));
          if (marked.some((c) => c < 1)) unmarked++;
        }
      }
    } catch (e) {
      await a.page.screenshot({ path: `${OUT}/sim-fail-${tag}-pilot.png`, fullPage: true }).catch(() => {});
      await b.page.screenshot({ path: `${OUT}/sim-fail-${tag}-copilot.png`, fullPage: true }).catch(() => {});
      return { ok: false, problem: e.message, tail: log.slice(-6).join(" ") };
    }
    await sleep(400);
    const g = a.game;
    const [ca, cb] = await Promise.all([a, b].map((x) => x.page.locator(".callout").textContent()));
    const problems = [
      !g.outcome && `stalled after ${moves} moves`,
      ca !== cb && `screens disagree: "${ca}" vs "${cb}"`,
      a.pageError && `pilot page error: ${a.pageError}`,
      b.pageError && `co-pilot page error: ${b.pageError}`,
      unmarked && `${unmarked} Intern-filled space(s) not drawn in Intern colours`,
    ].filter(Boolean);
    return {
      ok: problems.length === 0,
      problem: problems.join("; ") || undefined,
      outcome: g.outcome ? `${g.outcome.result}${g.outcome.reason ? ` — ${g.outcome.reason}` : ""}` : "none",
      round: g.round,
      moves,
      tokens,
    };
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
}

// Discover the selectable modules from the lobby, then build every combination.
const probe = await player(1280);
await probe.page.goto(BASE);
await probe.page.getByRole("button", { name: "Create a room" }).click();
await probe.page.locator(".setup-modules").waitFor();
const modules = await probe.page.evaluate(() =>
  [...document.querySelectorAll(".setup-modules label")].filter((l) => !l.querySelector("input").disabled).map((l) => l.textContent),
);
await probe.ctx.close();
const combos = ONLY ?? modules.reduce((acc, m) => [...acc, ...acc.map((c) => [...c, m])], [[]]);
console.log(`Modules offered: ${modules.join(", ")} — ${combos.length} combination(s) × ${REPEAT}`);

let ran = 0;
let failed = 0;
let refused = 0;
for (const combo of combos) {
  const name = combo.join(" + ") || "base game";
  for (let r = 1; r <= REPEAT; r++) {
    const res = await playGame(combo, `${name.replace(/[^a-z0-9]+/gi, "-")}-${r}`);
    if (res === null) {
      refused++;
      console.log(`⊘ ${name} — not allowed together (lobby unticked one)`);
      break;
    }
    ran++;
    if (!res.ok) failed++;
    const detail = res.ok ? `${res.outcome} · round ${res.round} · ${res.moves} moves${res.tokens ? ` · ${res.tokens} Intern tokens` : ""}` : `${res.problem}${res.tail ? ` | last: ${res.tail}` : ""}`;
    console.log(`${res.ok ? "✅" : "❌"} ${name}${REPEAT > 1 ? ` #${r}` : ""} — ${detail}`);
  }
}
console.log(`\n${ran - failed}/${ran} games clean${refused ? `, ${refused} combination(s) refused as exclusive` : ""}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);

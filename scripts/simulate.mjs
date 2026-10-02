// Two-browser end-to-end simulation of real games, one per module combination.
//
// Run with scripts/simulate.sh (Playwright's Docker image, against the running
// dev stack). The Pilot plays on a desktop-sized window, the Co-Pilot on a
// phone-sized one, both through the real UI.
//
// Every combination of the modules the lobby offers is played, except those the
// lobby refuses to tick together (e.g. Kerosene + Kerosene Leak) — so a new
// module is covered automatically. Each Special Ability is then played alone
// and alongside Kerosene + Ice Brakes + Intern; the bot uses the active ones
// (Anticipation, Adaptation, Working Together) and places the Traffic die. Each turn the active player taps every die
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
// default 1), OUT (dir for failure screenshots), AIRPORT (scenario id from the
// lobby's airport list, e.g. "green-HND"; default: the lobby's default), CARDS
// (set to play every scenario card instead: its printed modules, plus as many
// Special Abilities as its ★ allows, rotating through them; ONLY then filters
// card ids, e.g. "red-HND,black-KEF").
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://host.docker.internal:5173";
const REPEAT = Number(process.env.REPEAT ?? 1);
const OUT = process.env.OUT ?? ".";
const AIRPORT = process.env.AIRPORT;
const CARDS = !!process.env.CARDS;
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
    [...document.querySelectorAll(".setup-modules label, .setup-abilities label")].filter((l) => l.querySelector("input").checked).map((l) => l.textContent),
  );

// Wind module ring (shared WIND_RING; this script runs standalone in the
// Playwright image, so it carries its own copy).
const WIND_RING = [3, 3, 2, 2, 1, 0, -1, -2, -2, -3, -3, -3, -2, -2, -1, 0, 1, 2, 2, 3];

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
      // Aim level — or, on a turn space, at the permitted tilt nearest level.
      const turn = g.scenario.approachTrack[g.position]?.axisAllowed;
      const aim = turn ? turn.reduce((m, t) => (Math.abs(t) < Math.abs(m) ? t : m), turn[0]) : 0;
      if (theirs !== null) {
        const n = o + (crew === "pilot" ? v - theirs : theirs - v);
        return Math.abs(n) >= g.scenario.axisSpinAt ? -1000 : 60 - Math.abs(n - aim) * 15;
      }
      return 30 - Math.abs(v - (crew === "pilot" ? 3.5 + aim - o : 3.5 + o - aim)) * 6;
    }
    case "engine": {
      const theirs = g.engines[other];
      const wind = mods.includes("wind") ? WIND_RING[g.windPosition] : 0;
      if (theirs === null) {
        if (!wind || final) return 25 - v * 2;
        // With Wind, guess the partner's die (3.5) and aim for a safe advance.
        const est = v + 3.5 + wind;
        const adv = est <= g.aeroBlue ? 0 : est > g.aeroOrange ? 2 : 1;
        for (let k = 0; k < adv; k++) if (g.airplanes[g.position + k] > 0 || g.position + k === airport) return 5 - v;
        return 25 - v;
      }
      const speed = v + theirs + wind;
      const leak = mods.includes("keroseneLeak") ? Math.abs(v - theirs) + 1 : 0;
      if (leak && g.kerosene <= leak) return -1000;
      if (final) return 50 - speed * 5 - leak * 3;
      const adv = speed <= g.aeroBlue ? 0 : speed > g.aeroOrange ? 2 : 1;
      for (let k = 0; k < adv; k++) {
        const at = g.position + k;
        if (g.airplanes[at] > 0 || at === airport) return -1000;
        // Turns: every space advanced off must allow the current tilt.
        const turn = g.scenario.approachTrack[at]?.axisAllowed;
        if (turn && !turn.includes(g.axis.offset)) return -1000;
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

/** Drag a held extra (Intern token / Traffic die, `chip` selector) onto `slot`
 *  like a person: hold at a screen edge until the page auto-scrolls the space
 *  into view, then aim where it is now. */
async function dragToken(p, slot, chip = ".hand .intern-die") {
  await p.page.locator(chip).scrollIntoViewIfNeeded();
  const from = await p.page.locator(chip).boundingBox();
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

/**
 * Use an active Special Ability through its tray chip, once where it makes
 * sense, so their UI paths are exercised: Anticipation (First Player rerolls
 * its die furthest from 3.5), Adaptation (turn a 6 into a 1), Working Together
 * (offer the highest die, once per game). Returns true if it acted.
 */
async function useAbility(p, crew) {
  const g = p.game;
  const has = (id) => g.scenario.abilities?.includes(id);
  const hand = g.dice[crew].filter((d) => !d.placed);
  const dieBtn = (id) => p.page.locator(".hand .dice > button.die:not(.intern-die):not(.traffic-die)").nth(id);
  const tryButton = async (name, die, label) => {
    const btn = p.page.getByRole("button", { name, exact: true });
    if (!(await btn.count()) || (await btn.isDisabled())) return false;
    await btn.click();
    await dieBtn(die.id).click();
    p.lastAbility = { value: die.value, t: JSON.stringify({ kind: label }) };
    return true;
  };
  if (has("anticipation") && !g.anticipated && hand.length === 4) {
    const far = hand.reduce((m, d) => (Math.abs(d.value - 3.5) > Math.abs(m.value - 3.5) ? d : m), hand[0]);
    if (await tryButton("Reroll a die", far, "anticipate")) return true;
  }
  const six = hand.find((d) => d.value === 6);
  if (has("adaptation") && six && !g.adaptationUsed[crew] && g.engines[crew] === null) {
    if (await tryButton("Flip a die", six, "adapt")) return true;
  }
  if (has("workingTogether") && !g.swappedThisRound && !p.swapped && hand.length >= 2) {
    const high = hand.reduce((m, d) => (d.value > m.value ? d : m), hand[0]);
    if (await tryButton("Swap a die", high, "swap")) { p.swapped = true; return true; }
  }
  return false;
}

/** Play the active crew's best legal move; throws if the server doesn't take it. */
async function act(p, crew, log) {
  const g = p.game;
  const v0 = p.version;
  let best = null;
  const held = g.internHeld?.crew === crew ? { ...g.internHeld, chip: ".hand .intern-die", kind: "Intern token" }
    : g.trafficHeld && crew === "copilot" ? { ...g.trafficHeld, chip: ".hand .traffic-die", kind: "Traffic die" }
    : null;
  if (held) {
    for (const t of await openTargets(p)) {
      const target = JSON.parse(t);
      // Score from the space owner's point of view (the Traffic die may fill the Pilot's).
      const s = score(g, target.side ?? crew, held.value, target);
      if (!best || s > best.s) best = { s, token: true, value: held.value, t };
    }
    if (!best) throw new Error(`a ${held.kind} is held but the UI opens no space for it`);
    await dragToken(p, p.page.locator(`.slot[data-open="1"][data-target='${best.t}']`).first(), held.chip);
  } else if (g.pendingSwap && g.pendingSwap.from !== crew) {
    // Working Together: answer the offer with our lowest die (the tray is in pick mode).
    const hand = g.dice[crew].filter((d) => !d.placed);
    const die = hand.reduce((m, d) => (d.value < m.value ? d : m), hand[0]);
    await p.page.locator(".hand .dice > button.die:not(.intern-die):not(.traffic-die)").nth(die.id).click();
    best = { value: die.value, t: JSON.stringify({ kind: "swap" }) };
  } else if (await useAbility(p, crew)) {
    best = p.lastAbility;
  } else {
    const dice = p.page.locator(".hand .dice > button.die:not(.intern-die):not(.traffic-die)");
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
    throw new Error(`${crew} ${best.token ? "extra die" : "die"} ${best.value} → ${best.t} not applied: ${err}`);
  }
  log.push(`${crew === "pilot" ? "P" : "C"}${best.token ? "+" : ""}${best.value}→${JSON.parse(best.t).kind}`);
  return JSON.parse(best.t);
}

/** Pick a scenario card in the host's picker and wait for the guest to see it. */
async function pickScenario(a, b, id) {
  await a.page.locator(".picker-trigger").click();
  await a.page.locator(`.picker-option[data-value="${id}"]`).click();
  await b.page.waitForFunction((id) => document.querySelector(".picker")?.dataset.value === id, id);
}

/** Tick exactly the lobby boxes named in `labels` (modules and abilities). */
async function setTicks(a, b, labels) {
  const boxes = () => a.page.evaluate(() =>
    [...document.querySelectorAll(".setup-modules label, .setup-abilities label")].map((l) => [l.textContent, l.querySelector("input").checked]),
  );
  for (const [label, checked] of await boxes()) {
    if (checked === labels.includes(label)) continue;
    await a.page.getByLabel(label, { exact: true }).click();
    await b.page.waitForFunction(([m, on]) => [...document.querySelectorAll(".setup-modules label, .setup-abilities label")].some((l) => l.textContent === m && l.querySelector("input").checked === on), [label, !checked]);
  }
}

/** The board as drawn vs the state: planes, Traffic dice icons and Turn tabs per space. */
async function boardMismatch(p) {
  const drawn = await p.page.evaluate(() =>
    [...document.querySelector(".approach .approach-track").querySelectorAll(".appr-cell")].map((c) => [
      c.querySelectorAll(".traffic-plane").length,
      c.querySelectorAll(".traffic-dice svg").length,
    ]),
  );
  const tabs = await p.page.evaluate(() => [...document.querySelectorAll(".turn-slot")].map((s) => !!s.querySelector(".turn-tab")));
  const g = p.game;
  const bad = g.scenario.approachTrack.flatMap((sp, i) => {
    const want = [g.airplanes[i], sp.trafficDice ?? 0];
    const out = [];
    if (drawn[i]?.[0] !== want[0]) out.push(`space ${i}: ${drawn[i]?.[0]} planes drawn, ${want[0]} in play`);
    if (drawn[i]?.[1] !== want[1]) out.push(`space ${i}: ${drawn[i]?.[1]} dice drawn, ${want[1]} printed`);
    if ((tabs[i] ?? false) !== !!sp.axisAllowed) out.push(`space ${i}: turn tab ${tabs[i] ? "drawn" : "missing"}`);
    return out;
  });
  return bad.join(", ");
}

/** Play one game with `combo`; returns a result, or null if the lobby refuses the combination. */
async function playGame(combo, tag, airport = AIRPORT) {
  const a = await player(1280);
  const b = await player(390);
  try {
    await a.page.goto(BASE);
    await a.page.getByRole("button", { name: "Create a room" }).click();
    await b.page.goto(await a.page.locator(".panel input").first().inputValue());
    await b.page.getByRole("button", { name: "Ready up" }).waitFor();
    if (airport) await pickScenario(a, b, airport);
    await setTicks(a, b, combo);
    await sleep(300);
    if ((await ticked(a)).length !== combo.length) return null; // an exclusive pair unticked one
    await a.page.getByRole("button", { name: "Ready up" }).click();
    await b.page.getByRole("button", { name: "Ready up" }).click();
    await a.page.getByRole("button", { name: "Start game" }).click();
    for (let k = 0; k < 100 && !(a.game && b.game); k++) await sleep(50);
    await sleep(500); // let both screens draw round 1
    const boardProblem = (await boardMismatch(a)) || (await boardMismatch(b));

    const log = [];
    let moves = 0;
    let tokens = 0;
    let unmarked = 0;
    let windTurns = 0;
    let windMismatch = 0;
    const windOn = combo.includes("Wind");
    const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `\u2212${-v}` : "0");
    try {
      while (!a.game.outcome && moves < MAX_MOVES) {
        const g = a.game;
        const crew = g.internHeld ? g.internHeld.crew
          : g.trafficHeld ? "copilot"
          : g.pendingSwap ? (g.pendingSwap.from === "pilot" ? "copilot" : "pilot")
          : g.turn;
        const wasToken = !!g.internHeld || !!g.trafficHeld;
        const extraClass = g.internHeld ? "intern" : "traffic";
        const round = g.round;
        const windBefore = g.windPosition;
        const target = await act(crew === "pilot" ? a : b, crew, log);
        moves++;
        for (let k = 0; k < 100 && b.version !== a.version; k++) await sleep(50);
        // Wind: both screens' ring must point where the server says.
        if (windOn && !a.game.outcome) {
          if (a.game.windPosition !== windBefore) windTurns++;
          const want = `Wind ${signed(WIND_RING[a.game.windPosition])}`;
          const shown = await Promise.all([a, b].map((x) => x.page.locator(".wind-ring").getAttribute("aria-label")));
          if (shown.some((l) => l !== want)) windMismatch++;
        }
        // An extra placed mid-round must be drawn in its colours on both screens.
        // (If it ended the round, the next round has rightly cleared the marks.
        // A Traffic die on an Intern space trains it instead: no mark.)
        if (wasToken && target.kind !== "intern" && !a.game.outcome && a.game.round === round) {
          tokens++;
          await sleep(150);
          const marked = await Promise.all([a, b].map((x) => x.page.locator(`.slot.taken.${extraClass}`).count()));
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
      unmarked && `${unmarked} space(s) filled by an extra die not drawn in its colours`,
      windMismatch && `Wind ring disagreed with the server ${windMismatch} time(s)`,
      boardProblem && `board drawn wrong at the start: ${boardProblem}`,
    ].filter(Boolean);
    return {
      ok: problems.length === 0,
      problem: problems.join("; ") || undefined,
      outcome: g.outcome ? `${g.outcome.result}${g.outcome.reason ? ` — ${g.outcome.reason}` : ""}` : "none",
      round: g.round,
      moves,
      tokens,
      windTurns,
      abilitiesUsed: a.game.log.filter((l) => /Anticipation|Adaptation|work together|Synchronisation:|Mastery:|Control:/.test(l)).length,
    };
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
}

// Discover the selectable modules and Special Abilities from the lobby, then
// build every module combination plus each ability alone and with a full set.
const probe = await player(1280);
await probe.page.goto(BASE);
await probe.page.getByRole("button", { name: "Create a room" }).click();
await probe.page.locator(".setup-modules").waitFor();
const modules = await probe.page.evaluate(() =>
  [...document.querySelectorAll(".setup-modules label")].filter((l) => !l.querySelector("input").disabled).map((l) => l.textContent),
);
const abilities = await probe.page.evaluate(() =>
  [...document.querySelectorAll(".setup-abilities label")].map((l) => l.textContent),
);
// Every scenario card, as the picker lists it: id, label, and its ★ count
// (read off the lobby after picking it).
const cards = [];
if (CARDS) {
  const b0 = await player(390);
  await b0.page.goto(await probe.page.locator(".panel input").first().inputValue());
  await b0.page.getByRole("button", { name: "Ready up" }).waitFor();
  await probe.page.locator(".picker-trigger").click();
  const listed = await probe.page.evaluate(() =>
    [...document.querySelectorAll(".picker-option")].map((o) => [o.dataset.value, o.querySelector(".pick-code").textContent]),
  );
  await probe.page.keyboard.press("Escape");
  for (const [id, code] of listed) {
    if (ONLY && !ONLY.some((c) => c.join("+") === id)) continue;
    await pickScenario(probe, b0, id);
    const printed = await probe.page.evaluate(() =>
      [...document.querySelectorAll(".setup-modules label")].filter((l) => l.querySelector("input").checked).map((l) => l.textContent),
    );
    const stars = Number((await probe.page.locator(".setup-note").first().textContent()).match(/up to (\d+)/)?.[1] ?? 0);
    cards.push({ id, code, printed, stars });
  }
  await b0.ctx.close();
}
await probe.ctx.close();
const rich = ["Kerosene", "Ice Brakes", "Intern"].filter((m) => modules.includes(m));
let nextAbility = 0;
const combos = CARDS
  ? cards.map((c) => [...c.printed, ...Array.from({ length: c.stars }, () => abilities[nextAbility++ % abilities.length])])
  : ONLY ??
  [
    ...modules.reduce((acc, m) => [...acc, ...acc.map((c) => [...c, m])], [[]]),
    ...abilities.flatMap((ab) => [[ab], [...rich, ab]]),
  ];
console.log(`Modules offered: ${modules.join(", ")}; abilities: ${abilities.join(", ")} — ${combos.length} ${CARDS ? "card(s)" : "combination(s)"} × ${REPEAT}`);

let ran = 0;
let failed = 0;
let refused = 0;
for (const [k, combo] of combos.entries()) {
  const card = CARDS ? cards[k] : null;
  const name = `${card ? `${card.id}: ` : ""}${combo.join(" + ") || "base game"}`;
  for (let r = 1; r <= REPEAT; r++) {
    const res = await playGame(combo, `${name.replace(/[^a-z0-9]+/gi, "-")}-${r}`, card?.id);
    if (res === null) {
      refused++;
      console.log(`⊘ ${name} — not allowed together (lobby unticked one)`);
      break;
    }
    ran++;
    if (!res.ok) failed++;
    const detail = res.ok ? `${res.outcome} · round ${res.round} · ${res.moves} moves${res.tokens ? ` · ${res.tokens} extra dice` : ""}${res.windTurns ? ` · wind turned ${res.windTurns}×` : ""}${res.abilitiesUsed ? ` · ${res.abilitiesUsed} ability events` : ""}` : `${res.problem}${res.tail ? ` | last: ${res.tail}` : ""}`;
    console.log(`${res.ok ? "✅" : "❌"} ${name}${REPEAT > 1 ? ` #${r}` : ""} — ${detail}`);
  }
}
console.log(`\n${ran - failed}/${ran} games clean${refused ? `, ${refused} combination(s) refused as exclusive` : ""}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);

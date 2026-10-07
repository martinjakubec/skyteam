// Converted from scripts/test-bot.mjs by the Vitest codemod: each section is a test,
// each check(label, cond) a set of assertion helpers with the same verdict (see support/checks.mjs).
import { test } from "vitest";
import * as __c from "./support/checks.mjs";
// Bot and game-driving tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, randDice, shuffledInternTokens, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

/** Two moves lead to the same game: the same space (spelled with or without the
 *  crew's own side), a die of the same value, the same Coffee spent. */
const sameGame = (view, crew, a, b) => {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type !== "placeDie") return JSON.stringify(a) === JSON.stringify(b);
  const val = (m) => view.dice[crew].find((d) => d.id === m.dieId)?.value;
  const sp = (t) => `${t.kind}:${t.slot ?? ""}:${t.space ?? ""}:${t.side ?? crew}`;
  return sp(a.target) === sp(b.target) && val(a) === val(b) && (a.coffeeDelta ?? 0) === (b.coffeeDelta ?? 0);
};

/** The rules accept this move from `who` on `state` (the same move can be spelled differently). */
const accepts = (state, who, m) => { try { return !!m && !!applyIntent(state, m, who, mulberry32(1), () => 0); } catch { return false; } };

const P = "P", C = "C";

const clock = () => 0;


const { BOT_PROFILES: BOT_PROFILES_ALL } = await import("../packages/shared/src/index.ts");

test("4) Self-play: every card, every module combination, every ability", async () => {
  const { selfPlay, representativeSetups, cardSetups, ABILITY_IDS } = await import("../packages/shared/src/index.ts");
  (__c.begin("all 21 cards are covered"), __c.done(__c.cmp("all 21 cards are covered", (cardSetups().length), "===", (21))));
  const setups = representativeSetups();
  (__c.begin("every ability is played"), __c.done(__c.truthy("every ability is played", (ABILITY_IDS.every((a) => setups.some((s) => s.abilities.includes(a)))))));
  const label = (s) => `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  // (The same games as setups.map(...) — but yielding between them, so the test worker stays
  // responsive to Vitest during this ~45 s loop.)
  const results = [];
  for (const [i, s] of setups.entries()) {
    results.push({ s, r: selfPlay(s, 1000 + i, 400, { strategy: "quick" }) });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const stuck = results.filter(({ r }) => r.outcome === "stuck");
  (__c.begin(`${setups.length} setups each play to a finished game`), __c.done(__c.cmp(`${setups.length} setups each play to a finished game`, (stuck.length), "===", (0))));
  stuck.slice(0, 5).forEach(({ s, r }) => console.log(`     ↳ stuck: ${label(s)} — ${r.reason}`));
  const a = selfPlay(setups[0], 42, 400, { strategy: "quick" });
  const b = selfPlay(setups[0], 42, 400, { strategy: "quick" });
  (__c.begin("same seed, same game"), __c.done(__c.cmp("same seed, same game", (JSON.stringify(a)), "===", (JSON.stringify(b)))));
});

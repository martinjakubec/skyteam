import { Worker } from "node:worker_threads";
import { chooseMove, mulberry32, type BotLevel, type Crew, type GameCommand, type GameState } from "@skyteam/shared";
import { env } from "./env";

let worker: Worker | null = null;
let ready: Promise<void> = Promise.resolve();
let markReady = () => {};
let nextId = 0;
const pending = new Map<number, (m: GameCommand | null | Error) => void>();
/** Aviator answers that came from the worker vs. Navigator fallbacks (for logs and tests). */
export const thinkStats = { worker: 0, fallback: 0 };

/** Worker failures in a row; past this many, stop restarting it (Aviator plays as Navigator). */
const MAX_RESTARTS = 3;
let failures = 0;

function getWorker(): Worker {
  if (worker) return worker;
  // A plain-JS entry that registers tsx in the worker, then loads npcWorker.ts.
  const w = new Worker(new URL("./npcWorkerBoot.mjs", import.meta.url));
  worker = w;
  ready = new Promise((resolve) => (markReady = resolve));
  w.on("message", (msg) => {
    if (msg.ready) {
      markReady();
      return idleCheck();
    }
    failures = 0; // it answers: healthy again
    pending.get(msg.id)?.(msg.error ? new Error(msg.error) : msg.move);
  });
  w.on("error", (e) => lost(w, `crashed: ${e}`));
  w.on("exit", (code) => lost(w, `exited (code ${code})`));
  return w; // referenced while it loads (see idleCheck)
}

/** The worker died: answer what it owed with the fallback, and start a fresh
 *  one after a short pause — unless it keeps failing. */
function lost(w: Worker, why: string): void {
  if (worker !== w) return; // already handled (an error is followed by an exit)
  console.error(`[npc] search worker ${why}`);
  worker = null;
  markReady(); // nobody waits forever on a worker that's gone
  for (const r of pending.values()) r(new Error(`worker ${why}`));
  pending.clear();
  failures += 1;
  if (failures <= MAX_RESTARTS) setTimeout(() => void warmThinking(), 500).unref();
  else console.error("[npc] search worker keeps failing — Aviator plays as Navigator");
}

/** Keep the worker referenced only while it has work: an idle worker never
 *  keeps the process alive on its own. */
function idleCheck(): void {
  if (pending.size === 0) worker?.unref();
  else worker?.ref();
}

/** Start the worker ahead of the first Aviator move (it takes a few seconds to
 *  load); resolves once it's ready (or gone). */
export function warmThinking(): Promise<void> {
  if (failures > MAX_RESTARTS) return Promise.resolve();
  getWorker();
  return ready;
}

/** Stop the worker (tests). */
export async function stopThinking(): Promise<void> {
  const w = worker;
  worker = null; // a deliberate stop isn't a failure
  await w?.terminate();
}

/** Make the worker throw, as a real crash would (tests). */
export function crashWorkerForTest(): void {
  worker?.postMessage({ crash: true });
}

/** The bot's move. Aviator thinks in a worker (never blocking other rooms); any
 *  failure or timeout falls back to Navigator, so the bot always moves. Resolves
 *  null only if even the fallback fails (the caller then gives up on the room). */
export function think(
  view: GameState,
  crew: Crew,
  level: BotLevel,
  seed: number,
  test?: { simulateWorkerError?: boolean; timeoutMs?: number },
): Promise<GameCommand | null> {
  const navigator = (lv: BotLevel = "navigator") => {
    try {
      return chooseMove(view, crew, lv, mulberry32(seed));
    } catch (e) {
      console.error(`[npc] the ${lv} bot failed:`, e);
      return null;
    }
  };
  const fallback = (why = "simulated") => {
    thinkStats.fallback += 1;
    if (!test) console.warn(`[npc] Aviator fell back to Navigator (${why})`);
    return navigator();
  };
  if (level !== "aviator") return Promise.resolve(navigator(level));
  if (test?.simulateWorkerError || failures > MAX_RESTARTS) return Promise.resolve(fallback("no search worker"));
  const timeoutMs = test?.timeoutMs ?? env.NPC_THINK_MS + 400;
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      idleCheck();
      resolve(fallback("timed out"));
    }, timeoutMs); // the worker skips the request too once its deadline passes
    pending.set(id, (m) => {
      clearTimeout(timer);
      pending.delete(id);
      idleCheck();
      if (!(m instanceof Error)) thinkStats.worker += 1;
      resolve(m instanceof Error ? fallback(m.message) : m);
    });
    const deadline = Date.now() + timeoutMs;
    getWorker().postMessage({ id, view, crew, level, seed, budgetMs: env.NPC_THINK_MS, deadline });
    idleCheck();
  });
}

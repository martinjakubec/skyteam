import { Worker } from "node:worker_threads";
import { chooseMove, mulberry32, type BotLevel, type Crew, type GameCommand, type GameState } from "@skyteam/shared";
import { env } from "./env";

let worker: Worker | null = null;
let ready: Promise<void> = Promise.resolve();
/** Aviator answers that came from the worker vs. Navigator fallbacks (for logs and tests). */
export const thinkStats = { worker: 0, fallback: 0 };
let nextId = 0;
const pending = new Map<number, (m: GameCommand | null | Error) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  // A plain-JS entry that registers tsx in the worker, then loads npcWorker.ts.
  worker = new Worker(new URL("./npcWorkerBoot.mjs", import.meta.url));
  let markReady = () => {};
  ready = new Promise((resolve) => (markReady = resolve));
  worker.on("message", (msg) => {
    if (msg.ready) {
      markReady();
      return idleCheck();
    }
    pending.get(msg.id)?.(msg.error ? new Error(msg.error) : msg.move);
  });
  worker.on("error", (e) => {
    console.error("[npc] search worker crashed:", e);
    for (const r of pending.values()) r(new Error("worker crashed"));
    pending.clear();
    worker = null;
  });
  return worker; // referenced while it loads (see idleCheck)
}

/** Keep the worker referenced only while it has work: an idle worker never
 *  keeps the process alive on its own. */
function idleCheck(): void {
  if (pending.size === 0) worker?.unref();
  else worker?.ref();
}

/** Start the worker ahead of the first Aviator move (it takes a few seconds to
 *  load); resolves once it's ready. */
export function warmThinking(): Promise<void> {
  getWorker();
  return ready;
}

/** Stop the worker (tests). */
export async function stopThinking(): Promise<void> {
  await worker?.terminate();
  worker = null;
}

/** The bot's move. Aviator thinks in a worker (never blocking other rooms); any
 *  failure or timeout falls back to Navigator, so the bot always moves. */
export function think(view: GameState, crew: Crew, level: BotLevel, seed: number, test?: { simulateWorkerError?: boolean }): Promise<GameCommand | null> {
  const fallback = (why = "simulated") => {
    thinkStats.fallback += 1;
    if (!test) console.warn(`[npc] Aviator fell back to Navigator (${why})`);
    return chooseMove(view, crew, "navigator", mulberry32(seed));
  };
  if (level !== "aviator") return Promise.resolve(chooseMove(view, crew, level, mulberry32(seed)));
  if (test?.simulateWorkerError) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      idleCheck();
      resolve(fallback("timed out"));
    }, env.NPC_THINK_MS + 400); // the worker skips the request too once this passes
    pending.set(id, (m) => {
      clearTimeout(timer);
      pending.delete(id);
      idleCheck();
      if (!(m instanceof Error)) thinkStats.worker += 1;
      resolve(m instanceof Error ? fallback(m.message) : m);
    });
    const deadline = Date.now() + env.NPC_THINK_MS + 400;
    getWorker().postMessage({ id, view, crew, level, seed, budgetMs: env.NPC_THINK_MS, deadline });
    idleCheck();
  });
}

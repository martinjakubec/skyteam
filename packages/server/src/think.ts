import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { chooseMove, mulberry32, type BotLevel, type Crew, type GameCommand, type GameState } from "@skyteam/shared";
import { env } from "./env";

/** One search worker: its thread, whether it has loaded, and its requests in flight. */
interface Slot {
  w: Worker;
  ready: Promise<void>;
  markReady: () => void;
  /** Loaded and answering (a loading worker would hold a request for seconds). */
  isReady: boolean;
  inFlight: Set<number>;
}

/** Search workers: one per spare core, at most 4 (NPC_WORKERS overrides). */
const POOL_SIZE = Math.max(1, Number(process.env.NPC_WORKERS) || Math.min(4, availableParallelism() - 1));
let pool: Slot[] = [];
let nextId = 0;
const pending = new Map<number, (m: GameCommand | null | Error) => void>();
/** Aviator answers that came from a worker vs. Navigator fallbacks (for logs and tests). */
export const thinkStats = { worker: 0, fallback: 0 };

/** Worker failures in a row (each worker of the pool counts); past this many,
 *  stop restarting them (Aviator plays as Navigator). */
const MAX_RESTARTS = 3 * POOL_SIZE;
let failures = 0;

function startSlot(): Slot {
  // A plain-JS entry that registers tsx in the worker, then loads npcWorker.ts.
  const w = new Worker(new URL("./npcWorkerBoot.mjs", import.meta.url));
  let markReady = () => {};
  const slot: Slot = { w, ready: new Promise((resolve) => (markReady = resolve)), markReady: () => markReady(), isReady: false, inFlight: new Set() };
  w.on("message", (msg) => {
    if (msg.ready) {
      slot.isReady = true;
      slot.markReady();
      return idleCheck(slot);
    }
    failures = 0; // it answers: healthy again
    slot.inFlight.delete(msg.id);
    idleCheck(slot);
    pending.get(msg.id)?.(msg.error ? new Error(msg.error) : msg.move);
  });
  w.on("error", (e) => lost(slot, `crashed: ${e}`));
  w.on("exit", (code) => lost(slot, `exited (code ${code})`));
  pool.push(slot);
  return slot;
}

/** A worker died: answer what it owed with the fallback, and start a fresh one
 *  after a short pause — unless they keep failing. */
function lost(slot: Slot, why: string): void {
  if (!pool.includes(slot)) return; // already handled (an error is followed by an exit), or stopped
  console.error(`[npc] search worker ${why}`);
  pool = pool.filter((x) => x !== slot);
  slot.markReady(); // nobody waits forever on a worker that's gone
  for (const id of slot.inFlight) pending.get(id)?.(new Error(`worker ${why}`));
  failures += 1;
  if (failures <= MAX_RESTARTS) setTimeout(() => void warmThinking(), 500).unref();
  else console.error("[npc] search workers keep failing — Aviator plays as Navigator");
}

/** Keep a worker referenced only while it has work: idle workers never keep
 *  the process alive on their own. */
function idleCheck(slot: Slot): void {
  if (slot.inFlight.size === 0) slot.w.unref();
  else slot.w.ref();
}

/** Fill the pool ahead of the first Aviator move (workers take a few seconds to
 *  load); resolves once they're all ready (or gone). */
export function warmThinking(): Promise<void> {
  if (failures > MAX_RESTARTS) return Promise.resolve();
  while (pool.length < POOL_SIZE) startSlot();
  return Promise.all(pool.map((s) => s.ready)).then(() => {});
}

/** Stop the workers (tests). */
export async function stopThinking(): Promise<void> {
  const slots = pool;
  pool = []; // a deliberate stop isn't a failure
  await Promise.all(slots.map((s) => s.w.terminate()));
}

/** Make every worker throw, as a real crash would (tests). */
export function crashWorkerForTest(): void {
  for (const s of pool) s.w.postMessage({ crash: true });
}

/** The bot's move. Aviator thinks in a pooled worker (never blocking other
 *  rooms); any failure or timeout falls back to Navigator, so the bot always
 *  moves. Resolves null only if even the fallback fails (the room gives up). */
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
  if (pool.length === 0) void warmThinking();
  // The least busy worker that has loaded (a loading one only if none has).
  const ready = pool.filter((s) => s.isReady);
  const slot = (ready.length ? ready : pool).reduce((a, b) => (b.inFlight.size < a.inFlight.size ? b : a));
  const timeoutMs = test?.timeoutMs ?? env.NPC_THINK_MS + 400;
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      slot.inFlight.delete(id);
      idleCheck(slot);
      resolve(fallback("timed out"));
    }, timeoutMs); // the worker skips the request too once its deadline passes
    pending.set(id, (m) => {
      clearTimeout(timer);
      pending.delete(id);
      if (!(m instanceof Error)) thinkStats.worker += 1;
      resolve(m instanceof Error ? fallback(m.message) : m);
    });
    slot.inFlight.add(id);
    slot.w.postMessage({ id, view, crew, level, seed, budgetMs: env.NPC_THINK_MS, deadline: Date.now() + timeoutMs });
    idleCheck(slot);
  });
}

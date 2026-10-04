import { Worker } from "node:worker_threads";
import { mulberry32, pickBest, quickMove, type Crew, type GameCommand, type GameState, type SearchStats } from "@skyteam/shared";
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

/** How many search workers to run (env NPC_WORKERS; tests may set it). */
let poolSize = env.NPC_WORKERS;
export function setPoolSizeForTests(n: number): void {
  poolSize = n;
}
let pool: Slot[] = [];
let nextId = 0;
const pending = new Map<number, (m: SearchStats | Error) => void>();
/** Aviator answers that came from workers vs. quick-strategy fallbacks, and how many
 *  workers the last decision searched on (for logs and tests). */
export const thinkStats = { worker: 0, fallback: 0, lastWorkers: 0 };

/** Worker failures in a row (each worker of the pool counts); past this many,
 *  stop restarting them (Aviator plays its quick strategy). */
const maxRestarts = () => 3 * poolSize;
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
    pending.get(msg.id)?.(msg.error ? new Error(msg.error) : msg.stats);
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
  if (failures <= maxRestarts()) setTimeout(() => void warmThinking(), 500).unref();
  else console.error("[npc] search workers keep failing — Aviator plays its quick strategy");
}

/** Keep a worker referenced only while it has work: idle workers never keep
 *  the process alive on their own. */
function idleCheck(slot: Slot): void {
  if (slot.inFlight.size === 0) slot.w.unref();
  else slot.w.ref();
}

/** Fill the pool ahead of the first Aviator move (workers take a few seconds to
 *  load); resolves once they're all ready (or gone). */
/** How many search workers have loaded, of the pool's size (served on /health). */
export function searchWorkers(): { ready: number; of: number } {
  return { ready: pool.filter((s) => s.isReady).length, of: poolSize };
}

export function warmThinking(): Promise<void> {
  if (failures > maxRestarts()) return Promise.resolve();
  while (pool.length < poolSize) startSlot();
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

/** The bot's move. Aviator searches in pooled workers (never blocking other
 *  rooms); any failure or timeout falls back to its quick strategy, so the bot
 *  always moves. Resolves null only if even that fails (the room gives up). */
export function think(
  view: GameState,
  crew: Crew,
  seed: number,
  test?: { simulateWorkerError?: boolean; timeoutMs?: number },
): Promise<GameCommand | null> {
  const fallback = (why = "simulated") => {
    thinkStats.fallback += 1;
    if (!test) console.warn(`[npc] Aviator fell back to its quick strategy (${why})`);
    try {
      return quickMove(view, crew, mulberry32(seed));
    } catch (e) {
      console.error("[npc] the quick strategy failed:", e);
      return null;
    }
  };
  if (test?.simulateWorkerError || failures > maxRestarts()) return Promise.resolve(fallback("no search worker"));
  if (pool.length === 0) void warmThinking();
  // Search on the idle workers that have loaded — each samples its own share of
  // the same candidates — and merge. One idle worker stays in reserve, so
  // another room deciding at the same moment starts at once; if none is idle,
  // the least busy one.
  const ready = pool.filter((s) => s.isReady);
  const idle = ready.filter((s) => s.inFlight.size === 0);
  const share = idle.slice(0, Math.max(1, idle.length - 1));
  const slots = share.length ? share : [(ready.length ? ready : pool).reduce((a, b) => (b.inFlight.size < a.inFlight.size ? b : a))];
  thinkStats.lastWorkers = slots.length;
  const timeoutMs = test?.timeoutMs ?? env.NPC_THINK_MS + 400;
  const deadline = Date.now() + timeoutMs;
  return Promise.all(slots.map((slot, k) => ask(slot, { view, crew, seed: seed + 1 + k, candidateSeed: seed, budgetMs: env.NPC_THINK_MS, deadline }, timeoutMs))).then(
    (results) => {
      const stats = results.filter((r): r is SearchStats => !("error" in r));
      const why = results.find((r): r is { error: string } => "error" in r)?.error ?? "timed out";
      const skipped = stats.reduce((a, st) => a + (st.errors ?? 0), 0);
      if (skipped) console.warn(`[npc] Aviator skipped ${skipped} sample(s) the rules refused — a gap in placementCheck?`);
      const move = stats.length ? pickBest(stats) : null;
      if (!move) return fallback(stats.length ? "no move in the merged search" : why);
      thinkStats.worker += 1;
      return move;
    },
  );
}

/** One worker's share of a search: its stats, or why there are none (a timeout or error). */
function ask(slot: Slot, request: Record<string, unknown>, timeoutMs: number): Promise<SearchStats | { error: string }> {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      slot.inFlight.delete(id);
      idleCheck(slot);
      resolve({ error: "timed out" });
    }, timeoutMs); // the worker skips the request too once its deadline passes
    pending.set(id, (m) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(m instanceof Error ? { error: m.message } : m);
    });
    slot.inFlight.add(id);
    slot.w.postMessage({ id, ...request });
    idleCheck(slot);
  });
}

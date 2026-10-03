import { parentPort } from "node:worker_threads";
import { chooseMove, mulberry32 } from "@skyteam/shared";

// The Aviator's search, off the server's main thread (see think.ts). A request
// past its deadline is skipped and the budget trimmed to the time left, so
// requests that timed out (e.g. while this worker was starting) can't pile up.
parentPort!.on("message", ({ id, view, crew, level, seed, budgetMs, deadline }) => {
  const left = deadline - Date.now() - 100;
  if (left <= 0) return parentPort!.postMessage({ id, error: "stale request" });
  try {
    parentPort!.postMessage({ id, move: chooseMove(view, crew, level, mulberry32(seed), { budgetMs: Math.min(budgetMs, left) }) });
  } catch (e) {
    parentPort!.postMessage({ id, error: String(e) });
  }
});
parentPort!.postMessage({ ready: true });

import { parentPort } from "node:worker_threads";
import { chooseMove, mulberry32, searchStats } from "@skyteam/shared";

// The Aviator's search, off the server's main thread (see think.ts). A request
// past its deadline is skipped and the budget trimmed to the time left, so
// requests that timed out (e.g. while this worker was starting) can't pile up.
parentPort!.on("message", ({ id, view, crew, seed, budgetMs, deadline, crash, candidateSeed }) => {
  if (crash) throw new Error("crash requested (test)"); // uncaught, like a real bug
  const left = deadline - Date.now() - 100;
  if (left <= 0) return parentPort!.postMessage({ id, error: "stale request" });
  try {
    const budget = Math.min(budgetMs, left);
    // A share of a parallel search: this worker's samples, merged by the server.
    if (candidateSeed !== undefined) {
      return parentPort!.postMessage({ id, stats: searchStats(view, crew, mulberry32(seed), { budgetMs: budget, candidateSeed }) });
    }
    parentPort!.postMessage({ id, move: chooseMove(view, crew, mulberry32(seed), { budgetMs: budget }) });
  } catch (e) {
    parentPort!.postMessage({ id, error: String(e) });
  }
});
parentPort!.postMessage({ ready: true });

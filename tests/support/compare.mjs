// Check-by-check comparison of the old suites (scripts/test-*.mjs) with the converted
// Vitest suites: every check must report the same verdict. Used while migrating, and to
// show that a planted bug is caught by exactly the same checks in both.
//
// Usage (repo root, node:22 container): node tests/support/compare.mjs [out-dir]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";

const dir = process.argv[2] ?? "/tmp/compare";
mkdirSync(dir, { recursive: true });

// Old suites: "  ✅ label" / "  ❌ label" lines (expectThrow adds " (expected an error)").
const old = [];
let crashed = [];
for (const f of ["rules", "units", "bot"]) {
  const r = spawnSync("node_modules/.bin/tsx", [`scripts/test-${f}.mjs`], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (!/TESTS PASSED|TEST\(S\) FAILED/.test(r.stdout)) crashed.push(f);
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^ {2}(✅|❌) (.*)$/);
    if (m) old.push({ suite: f, label: m[2].replace(/ \(expected an error\)$/, ""), ok: m[1] === "✅" });
  }
}

// New suites: the verdict trace.
const trace = `${dir}/trace.jsonl`;
rmSync(trace, { force: true });
spawnSync("node_modules/.bin/vitest", ["run"], { env: { ...process.env, CHECK_TRACE: trace }, encoding: "utf8", maxBuffer: 64 << 20 });
const neu = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Match each old verdict to a new one with the same label (multiset).
const key = (c) => `${c.label}\u0000${c.ok}`;
const pool = new Map();
for (const c of neu) pool.set(key(c), (pool.get(key(c)) ?? 0) + 1);
const unmatched = [];
for (const c of old) {
  const k = key(c);
  if (pool.get(k)) pool.set(k, pool.get(k) - 1);
  else unmatched.push(c);
}
const extraNew = [...pool].filter(([, n]) => n > 0).flatMap(([k, n]) => Array(n).fill(k.replace("\u0000", " → ")));
const oldFail = old.filter((c) => !c.ok).length, newFail = neu.filter((c) => !c.ok).length;
console.log(JSON.stringify({ oldChecks: old.length, newChecks: neu.length, oldFailing: oldFail, newFailing: newFail, oldCrashed: crashed, verdictMismatches: unmatched.length }));
for (const c of unmatched.slice(0, 20)) console.log(`  old ${c.ok ? "✅" : "❌"} ${c.suite}: ${c.label} — no new check with that label and verdict`);
// New checks without an old twin are expected only when an old suite crashed (it stops there).
if (crashed.length) console.log(`  (old suite crashed: ${crashed.join(", ")} — its later checks never ran; ${extraNew.length} new verdicts have no old twin)`);
else for (const k of extraNew.slice(0, 20)) console.log(`  new only: ${k}`);

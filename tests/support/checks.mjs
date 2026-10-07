// Assertion helpers for the converted test suites.
//
// Each helper decides pass/fail exactly as the original `check(label, cond)`
// did — with plain JavaScript semantics, evaluating its arguments once — and
// returns that verdict, so `a && b` chains short-circuit as before. Only a
// failure records a Vitest assertion, chosen to show expected vs actual.
// Soft assertions: a failing check doesn't stop the test, like the old suites.
//
// CHECK_TRACE=<file> appends every verdict ({ label, ok }) as a JSON line, so
// a run can be compared check by check against the old suites.
import { appendFileSync } from "node:fs";
import { expect } from "vitest";

const TRACE = process.env.CHECK_TRACE;
/** One verdict per original check: a chain's last helper call (or its first failure) decides it. */
let open = null;
function trace(label, ok) {
  if (TRACE) appendFileSync(TRACE, JSON.stringify({ label, ok }) + "\n");
}

/** Starts an original check: everything until `done` belongs to it. */
export function begin(label) {
  open = { label, ok: true };
}
/** Ends an original check with its verdict. */
export function done(ok) {
  trace(open?.label, !!ok);
  open = null;
  return ok;
}

const OPS = {
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};
const numeric = (a, b) => (typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint");

/** `l op r`, as JavaScript decides it; on failure, a matcher that shows both sides. */
export function cmp(label, l, op, r) {
  const ok = OPS[op](l, r);
  if (ok) return true;
  const e = expect.soft(l, label);
  if (op === "===" && !Object.is(l, r)) e.toBe(r);
  else if (op === "!==") e.not.toBe(r);
  else if (op === "<" && numeric(l, r)) e.toBeLessThan(r);
  else if (op === "<=" && numeric(l, r)) e.toBeLessThanOrEqual(r);
  else if (op === ">" && numeric(l, r)) e.toBeGreaterThan(r);
  else if (op === ">=" && numeric(l, r)) e.toBeGreaterThanOrEqual(r);
  // Loose equality, mixed types, NaN: spell the comparison out.
  else expect.soft(`${fmt(l)} ${op} ${fmt(r)}`, label).toBe("true");
  return false;
}

/** A condition that must hold (anything not broken down further). */
export function truthy(label, v) {
  if (v) return true;
  expect.soft(v, label).toBeTruthy();
  return false;
}

/** `!v`. */
export function falsy(label, v) {
  if (!v) return true;
  expect.soft(v, label).toBeFalsy();
  return false;
}

/** `coll.includes(x)`. */
export function contains(label, coll, x) {
  if (coll.includes(x)) return true;
  expect.soft(coll, label).toContain(x);
  return false;
}

/** `re.test(s)`. */
export function matches(label, re, s) {
  if (re.test(s)) return true;
  expect.soft(s, label).toMatch(re);
  return false;
}

/** The old `expectThrow(label, fn)`: fn must throw. */
export function throws(label, fn) {
  begin(label);
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) expect.soft(fn, `${label} (expected an error)`).toThrow();
  return done(threw);
}

function fmt(v) {
  try {
    return typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v) ?? v);
  } catch {
    return String(v);
  }
}

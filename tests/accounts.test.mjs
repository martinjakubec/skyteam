// Accounts: password hashing, recovery codes, users, sessions and the first
// SUPERADMIN. The database is the in-memory fake (tests/support/fakePg.mjs);
// the same SQL runs against a real PostgreSQL in pg-real.test.mjs.
import { expect, test } from "vitest";

const { hashPassword, verifyPassword, DUMMY_HASH, newRecoveryCode, normalizeCode, sha256 } = await import("../packages/server/src/passwords.ts");

// --- passwords and recovery codes ---------------------------------------------------

test("a password verifies against its own hash, and nothing else does", async () => {
  const h = await hashPassword("correct horse battery");
  expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  expect(await verifyPassword("correct horse battery", h)).toBe(true);
  expect(await verifyPassword("correct horse batterY", h)).toBe(false);
  expect(await hashPassword("correct horse battery")).not.toBe(h); // salted
});

test("a malformed stored hash verifies nothing, and doesn't throw", async () => {
  const bad = ["", "plain", "scrypt$1$2$3$x$y", "scrypt$1024$8$1$AAAA$AAAA", "scrypt$33000$8$1$AAAA$AAAA", "bcrypt$2b$10$abc"];
  for (const stored of bad) expect(await verifyPassword("whatever123456", stored)).toBe(false);
  expect(await verifyPassword("whatever123456", DUMMY_HASH)).toBe(false);
  expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
});

test("recovery codes: 4 groups of 5 Crockford letters, never the same twice", () => {
  const codes = new Set(Array.from({ length: 1000 }, newRecoveryCode));
  expect(codes.size).toBe(1000);
  for (const c of codes) expect(c).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/);
});

test("a recovery code typed loosely still reads as the code", () => {
  expect(normalizeCode("abcde fghjk-mnpqr-stvwo")).toBe("ABCDE-FGHJK-MNPQR-STVW0");
  expect(normalizeCode(" 1i2l3-45678 9abcd efghj ")).toBe("11213-45678-9ABCD-EFGHJ");
  expect(normalizeCode("short")).toBe("SH0RT");
  expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
});

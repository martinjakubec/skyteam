import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Passwords are hashed with scrypt (memory-hard, built into Node). The stored
 * string carries its parameters — "scrypt$N$r$p$salt$hash" — so they can be
 * raised later without breaking older hashes.
 */

const scrypt = (pw: string, salt: Buffer, keylen: number, o: ScryptOptions) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw, salt, keylen, o, (e, key) => (e ? fail(e) : ok(key))));

const N = 32768, R = 8, P = 1, KEYLEN = 32;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const [n, r, p] = [m[1], m[2], m[3]].map(Number);
  // Only sane parameters: a tampered row must not make the server burn memory.
  if (n < 16384 || n > 1 << 20 || (n & (n - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  const want = Buffer.from(m[5], "base64");
  if (want.length !== KEYLEN) return false;
  try {
    const got = await scrypt(pw, Buffer.from(m[4], "base64"), KEYLEN, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Checked when the username is unknown, so a miss takes as long as a wrong
 *  password and the timing doesn't tell which usernames exist. Matches nothing. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEYLEN).toString("base64")}`;

/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A one-time recovery code: 20 symbols (100 bits) as XXXXX-XXXXX-XXXXX-XXXXX. */
export function newRecoveryCode(): string {
  const symbols = [...randomBytes(20)].map((b) => CROCKFORD[b & 31]).join("");
  return symbols.match(/.{5}/g)!.join("-");
}

/** A code as the user typed it, read as Crockford does: any case, O as 0, I and
 *  L as 1, spaces and dashes ignored. */
export function normalizeCode(input: string): string {
  const s = input.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");
  return (s.match(/.{1,5}/g) ?? []).join("-");
}

/** For secrets with enough entropy of their own (recovery codes, reset tokens),
 *  a plain hash is enough: nothing to guess from it. */
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

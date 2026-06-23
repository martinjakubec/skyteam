import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "./env";

interface IdentityClaims {
  playerId: string;
}

/** Issue a signed token for a new or existing anonymous identity. */
export function issueToken(playerId: string = nanoid()): { token: string; playerId: string } {
  const token = jwt.sign({ playerId } satisfies IdentityClaims, env.JWT_SECRET, {
    expiresIn: "30d",
  });
  return { token, playerId };
}

/** Verify a token and return its playerId, or null if invalid/expired. */
export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as IdentityClaims;
    return decoded.playerId ?? null;
  } catch {
    return null;
  }
}

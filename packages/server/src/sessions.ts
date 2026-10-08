import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import type { Privilege, PublicUser } from "@skyteam/shared";
import { userById } from "./accounts";
import { db } from "./db";
import { env } from "./env";

/**
 * Sign-in sessions: a JWT signed with SESSION_SECRET (never JWT_SECRET, which
 * signs the players' anonymous identity tokens) in an HttpOnly, SameSite=Strict
 * cookie — page scripts can't read it and other sites can't send it.
 *
 * Every request loads the account: a removed or disabled account, or one whose
 * sessions were ended (a password change, "sign out everywhere"), is signed out
 * at once, and privileges follow the account's role as it is now.
 */

const AUDIENCE = "skyteam-session";
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "skyteam_session";

interface SessionClaims {
  /** When it was issued, in ms (a JWT's own iat has only seconds). */
  ims: number;
}

export function issueSession(userId: string): string {
  return jwt.sign({ ims: Date.now() } satisfies SessionClaims, env.SESSION_SECRET, {
    algorithm: "HS256",
    audience: AUDIENCE,
    subject: userId,
    expiresIn: `${SESSION_DAYS}d`,
  });
}

/** The signed-in user, or null: no token, a bad, expired or foreign one, a
 *  missing or disabled account, or a session that was ended. */
export async function sessionUser(token: string | undefined): Promise<PublicUser | null> {
  if (!token || !db()) return null;
  let claims: jwt.JwtPayload & Partial<SessionClaims>;
  try {
    claims = jwt.verify(token, env.SESSION_SECRET, { algorithms: ["HS256"], audience: AUDIENCE }) as jwt.JwtPayload;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || typeof claims.ims !== "number") return null;
  const user = await userById(claims.sub);
  if (!user || user.disabled || claims.ims < user.sessionsAfter.getTime()) return null;
  return { id: user.id, username: user.username, role: user.role, privileges: user.privileges };
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearedCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

/** A cookie's value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** res.locals.user: the signed-in user, or null for a guest. */
export const currentUser: RequestHandler = (req, res, next) => {
  sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE)).then((user) => {
    res.locals.user = user;
    next();
  }, next);
};

/** Only signed-in users whose role grants `privilege` (after currentUser). */
export function requirePrivilege(privilege: Privilege): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as PublicUser | null;
    if (!user) return void res.status(401).json({ error: "Please sign in." });
    if (!user.privileges.includes(privilege)) return void res.status(403).json({ error: "You don't have access to this." });
    next();
  };
}

import express, { type Router } from "express";
import type { ZodType } from "zod";
import {
  ChangePasswordPayload,
  LoginPayload,
  PasswordPayload,
  RecoverPayload,
  RegisterPayload,
  ResetPayload,
  type PublicUser,
} from "@skyteam/shared";
import {
  AccountError,
  changePassword,
  deleteOwnAccount,
  endSessions,
  login,
  newRecoveryCodeFor,
  recover,
  register,
  resetWithToken,
  type AccountErrorCode,
} from "./accounts";
import { db } from "./db";
import { clearedCookie, currentUser, issueSession, sessionCookie } from "./sessions";
import { failureLimiter, limit, route } from "./routing";

/**
 * The JSON API under /api: accounts now; history, game records and the admin
 * pages join it later. Every answer is `no-store`. Anything but GET must be
 * JSON — with the SameSite=Strict session cookie, that keeps other sites from
 * acting for a signed-in user (a cross-site form can't send JSON without a
 * CORS preflight the server refuses).
 */

const STATUS: Record<AccountErrorCode, number> = {
  taken: 409,
  reserved: 409,
  invalid: 400,
  disabled: 403,
  not_found: 404,
  forbidden: 409,
  no_db: 503,
};

const LOCKED_NAME = "Too many failed sign-ins for this name — try again in 15 minutes.";
const LATER = "Too many requests — try again later.";

export function apiRouter(): Router {
  const r = express.Router();
  const loginFailures = failureLimiter(10, 15 * 60_000);
  const recoverFailures = failureLimiter(5, 15 * 60_000);

  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  r.use((req, res, next) => {
    if (req.method === "GET" || req.is("application/json")) return next();
    res.status(415).json({ error: "Send the request as JSON." });
  });
  r.use((_req, res, next) => {
    if (db()) return next();
    res.status(503).json({ error: "Accounts need the database." });
  });
  r.use(currentUser);

  /** The parsed body, or a 400 with the first problem (null: answered). */
  const parse = <T>(schema: ZodType<T>, body: unknown, res: express.Response): T | null => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    return null;
  };
  /** Sign the user in on this response. */
  const signIn = (res: express.Response, user: PublicUser) => res.set("Set-Cookie", sessionCookie(issueSession(user.id)));
  const me = (res: express.Response) => res.locals.user as PublicUser | null;

  // --- signing in and out --------------------------------------------------------------

  r.get("/auth/me", (_req, res) => void res.json({ user: me(res) }));

  r.post("/auth/register", limit(5, 3600_000, LATER), route(async (req, res) => {
    const body = parse(RegisterPayload, req.body, res);
    if (!body) return;
    const out = await register(body.username, body.password);
    signIn(res, out.user).status(201).json(out);
  }));

  r.post("/auth/login", limit(10), route(async (req, res) => {
    const body = parse(LoginPayload, req.body, res);
    if (!body) return;
    if (loginFailures.blocked(body.username)) return void res.status(429).json({ error: LOCKED_NAME });
    const user = await login(body.username, body.password);
    if (!user) {
      loginFailures.fail(body.username);
      return void res.status(401).json({ error: "Wrong username or password." });
    }
    signIn(res, user).json({ user });
  }));

  r.post("/auth/logout", (_req, res) => void res.set("Set-Cookie", clearedCookie()).status(204).end());

  r.post("/auth/recover", limit(10), route(async (req, res) => {
    const body = parse(RecoverPayload, req.body, res);
    if (!body) return;
    if (recoverFailures.blocked(body.username)) return void res.status(429).json({ error: "Too many tries for this name — try again in 15 minutes." });
    const out = await recover(body.username, body.recoveryCode, body.newPassword);
    if (!out) {
      recoverFailures.fail(body.username);
      return void res.status(401).json({ error: "That recovery code doesn't match." });
    }
    signIn(res, out.user).json(out);
  }));

  r.post("/auth/reset", limit(10), route(async (req, res) => {
    const body = parse(ResetPayload, req.body, res);
    if (!body) return;
    const out = await resetWithToken(body.token, body.newPassword);
    if (!out) return void res.status(410).json({ error: "This reset link has expired or was already used." });
    signIn(res, out.user).json(out);
  }));

  // --- the signed-in user's own account ------------------------------------------------

  const account = express.Router();
  account.use(limit(10), (_req, res, next) => (me(res) ? next() : void res.status(401).json({ error: "Please sign in." })));
  const WRONG = { error: "That password isn't right." };

  account.post("/password", route(async (req, res) => {
    const body = parse(ChangePasswordPayload, req.body, res);
    if (!body) return;
    if (!(await changePassword(me(res)!.id, body.currentPassword, body.newPassword))) return void res.status(401).json(WRONG);
    signIn(res, me(res)!).json({ user: me(res) }); // every other session has ended; this one goes on
  }));

  account.post("/recovery-code", route(async (req, res) => {
    const body = parse(PasswordPayload, req.body, res);
    if (!body) return;
    const recoveryCode = await newRecoveryCodeFor(me(res)!.id, body.password);
    if (!recoveryCode) return void res.status(401).json(WRONG);
    res.json({ recoveryCode });
  }));

  account.post("/sign-out-everywhere", route(async (_req, res) => {
    await endSessions(me(res)!.id);
    res.set("Set-Cookie", clearedCookie()).status(204).end();
  }));

  account.delete("/", route(async (req, res) => {
    const body = parse(PasswordPayload, req.body, res);
    if (!body) return;
    if (!(await deleteOwnAccount(me(res)!.id, body.password))) return void res.status(401).json(WRONG);
    res.set("Set-Cookie", clearedCookie()).status(204).end();
  }));
  r.use("/account", account);

  // An account error the route didn't answer: its status and message.
  r.use(((err, _req, res, next) => {
    if (!(err instanceof AccountError)) return next(err);
    res.status(STATUS[err.code]).json({ error: err.message });
  }) as express.ErrorRequestHandler);

  return r;
}

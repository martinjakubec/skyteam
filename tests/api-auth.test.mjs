// The accounts API over HTTP: register, sign in and out, recover, reset, and the
// account's own settings — with the session cookie, the rate limits and the
// JSON-only rule that keeps other sites from acting for a signed-in user.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("pg", () => import("./support/fakePg.mjs"));
process.env.TRUST_PROXY = "1";
process.env.DATABASE_URL = "postgres://fake/skyteam";

const http = await import("node:http");
const { createApp } = await import("../packages/server/src/http.ts");
const { initDb } = await import("../packages/server/src/db.ts");
const { createResetLink } = await import("../packages/server/src/accounts.ts");
const { issueToken } = await import("../packages/server/src/identity.ts");
const { Pool: FakePg } = await import("./support/fakePg.mjs");

let server, url;
beforeAll(async () => {
  initDb();
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let nextAddress = 1;
const freshAddress = () => `10.1.${nextAddress >> 8}.${nextAddress++ & 255}`;

/** One request: its status, JSON body, headers and the session cookie it set. */
async function api(method, path, { body, cookie, from = freshAddress(), type = "application/json" } = {}) {
  const headers = { "x-forwarded-for": from };
  if (type) headers["content-type"] = type;
  if (cookie) headers.cookie = `skyteam_session=${cookie}`;
  const res = await fetch(url + path, { method, headers, body: body === undefined ? (method === "GET" ? undefined : "{}") : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
    setCookie,
    cookie: setCookie ? /^skyteam_session=([^;]*)/.exec(setCookie)?.[1] : undefined,
  };
}

const register = (username, password = "ten chars!") => api("POST", "/api/auth/register", { body: { username, password } });

test("register: 201 with the user, a recovery code and the session cookie; me then knows them", async () => {
  const r = await register("alice");
  expect(r.status).toBe(201);
  expect(r.body).toEqual({ user: { id: expect.any(String), username: "alice", role: "USER", privileges: ["history"] }, recoveryCode: expect.stringMatching(/^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/) });
  expect(r.setCookie).toMatch(/^skyteam_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect((await api("GET", "/api/auth/me", { cookie: r.cookie })).body).toEqual({ user: r.body.user });
  expect((await api("GET", "/api/auth/me")).body).toEqual({ user: null });
});

test("register: a bad name, a short password, a taken or reserved name", async () => {
  expect(await register("Al ice")).toMatchObject({ status: 400, body: { error: "Use 3–24 letters, digits, dots, dashes or underscores." } });
  expect(await register("carol", "short")).toMatchObject({ status: 400, body: { error: "Use at least 10 characters for the password." } });
  await register("bob");
  expect(await register("BOB")).toMatchObject({ status: 409, body: { error: "That username is taken." } });
  expect(await register("admin")).toMatchObject({ status: 409, body: { error: "That username is reserved." } });
  expect((await api("POST", "/api/auth/register", { body: "not json" })).status).toBe(400);
});

test("sign in and out: a wrong password and an unknown name answer alike", async () => {
  await register("dora");
  const wrong = await api("POST", "/api/auth/login", { body: { username: "dora", password: "wrong one!" } });
  const unknown = await api("POST", "/api/auth/login", { body: { username: "nobody", password: "wrong one!" } });
  expect(wrong).toMatchObject({ status: 401, body: { error: "Wrong username or password." } });
  expect(unknown).toMatchObject({ status: wrong.status, body: wrong.body, setCookie: null });
  const ok = await api("POST", "/api/auth/login", { body: { username: " Dora ", password: "ten chars!" } });
  expect(ok).toMatchObject({ status: 200, body: { user: { username: "dora" } } });
  const out = await api("POST", "/api/auth/logout", { cookie: ok.cookie });
  expect(out.status).toBe(204);
  expect(out.setCookie).toMatch(/^skyteam_session=; .*Max-Age=0/);
});

test("a disabled account can't sign in", async () => {
  await register("dave");
  FakePg.last.users.find((u) => u.username === "dave").disabled_at = new Date();
  expect(await api("POST", "/api/auth/login", { body: { username: "dave", password: "ten chars!" } })).toMatchObject({ status: 403, body: { error: "This account is disabled." } });
});

test("recover: the code sets a new password and gives a new code; a wrong code is refused", async () => {
  const { body } = await register("emma");
  const bad = await api("POST", "/api/auth/recover", { body: { username: "emma", recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA", newPassword: "new password!" } });
  expect(bad).toMatchObject({ status: 401, body: { error: "That recovery code doesn't match." } });
  const ok = await api("POST", "/api/auth/recover", { body: { username: "emma", recoveryCode: body.recoveryCode, newPassword: "new password!" } });
  expect(ok).toMatchObject({ status: 200, body: { user: { username: "emma" }, recoveryCode: expect.any(String) } });
  expect(ok.cookie).toBeTruthy();
  expect((await api("POST", "/api/auth/login", { body: { username: "emma", password: "new password!" } })).status).toBe(200);
});

test("reset link: sets a password once; a used or malformed link is refused", async () => {
  const { body } = await register("finn");
  const { token } = await createResetLink(body.user.id, body.user.id);
  const ok = await api("POST", "/api/auth/reset", { body: { token, newPassword: "new password!" } });
  expect(ok).toMatchObject({ status: 200, body: { user: { username: "finn" }, recoveryCode: expect.any(String) } });
  expect(await api("POST", "/api/auth/reset", { body: { token, newPassword: "new password!" } })).toMatchObject({ status: 410, body: { error: "This reset link has expired or was already used." } });
  expect((await api("POST", "/api/auth/reset", { body: { token: "short", newPassword: "new password!" } })).status).toBe(400);
});

test("account: change password (other sessions end, this one goes on), new recovery code", async () => {
  const { cookie } = await register("gina");
  const other = (await api("POST", "/api/auth/login", { body: { username: "gina", password: "ten chars!" } })).cookie;
  await new Promise((r) => setTimeout(r, 5));
  expect((await api("POST", "/api/account/password", { cookie, body: { currentPassword: "wrong one!", newPassword: "new password!" } })).status).toBe(401);
  const changed = await api("POST", "/api/account/password", { cookie, body: { currentPassword: "ten chars!", newPassword: "new password!" } });
  expect(changed.status).toBe(200);
  expect((await api("GET", "/api/auth/me", { cookie: other })).body).toEqual({ user: null });
  expect((await api("GET", "/api/auth/me", { cookie: changed.cookie })).body.user.username).toBe("gina");

  expect((await api("POST", "/api/account/recovery-code", { cookie: changed.cookie, body: { password: "ten chars!" } })).status).toBe(401);
  const code = await api("POST", "/api/account/recovery-code", { cookie: changed.cookie, body: { password: "new password!" } });
  expect(code.body.recoveryCode).toMatch(/^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
  expect((await api("POST", "/api/account/password", { body: { currentPassword: "x", newPassword: "new password!" } })).status).toBe(401);
});

test("account: sign out everywhere, delete my account", async () => {
  const { cookie } = await register("hugo");
  await new Promise((r) => setTimeout(r, 5));
  const out = await api("POST", "/api/account/sign-out-everywhere", { cookie });
  expect(out.status).toBe(204);
  expect((await api("GET", "/api/auth/me", { cookie })).body).toEqual({ user: null });

  const again = (await api("POST", "/api/auth/login", { body: { username: "hugo", password: "ten chars!" } })).cookie;
  expect((await api("DELETE", "/api/account", { cookie: again, body: { password: "wrong one!" } })).status).toBe(401);
  expect((await api("DELETE", "/api/account", { cookie: again, body: { password: "ten chars!" } })).status).toBe(204);
  expect((await api("POST", "/api/auth/login", { body: { username: "hugo", password: "ten chars!" } })).status).toBe(401);
});

test("a player's identity token is not a session", async () => {
  expect((await api("GET", "/api/auth/me", { cookie: issueToken().token })).body).toEqual({ user: null });
});

test("anything but GET must be JSON: a form post from another site is refused", async () => {
  const r = await api("POST", "/api/auth/login", { body: "username=a&password=b", type: "application/x-www-form-urlencoded" });
  expect(r).toMatchObject({ status: 415, body: { error: "Send the request as JSON." } });
  expect((await api("POST", "/api/auth/logout", { type: "text/plain" })).status).toBe(415);
});

test("rate limits: registrations per address per hour, failed sign-ins per name", async () => {
  const from = freshAddress();
  for (let i = 0; i < 5; i++) expect((await api("POST", "/api/auth/register", { from, body: { username: `rl${i}x`, password: "ten chars!" } })).status).toBe(201);
  expect(await api("POST", "/api/auth/register", { from, body: { username: "rl9x", password: "ten chars!" } })).toMatchObject({ status: 429, body: { error: "Too many requests — try again later." } });

  await register("ivan");
  for (let i = 0; i < 10; i++) expect((await api("POST", "/api/auth/login", { body: { username: "ivan", password: "wrong one!" } })).status).toBe(401);
  const locked = await api("POST", "/api/auth/login", { body: { username: "ivan", password: "ten chars!" } });
  expect(locked).toMatchObject({ status: 429, body: { error: "Too many failed sign-ins for this name — try again in 15 minutes." } });

  const from2 = freshAddress();
  for (let i = 0; i < 10; i++) await api("POST", "/api/auth/login", { from: from2, body: { username: `who${i}`, password: "wrong one!" } });
  expect((await api("POST", "/api/auth/login", { from: from2, body: { username: "who", password: "wrong one!" } })).status).toBe(429);
});

test("the database down: a server error, and the server goes on", async () => {
  FakePg.last.down = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await api("POST", "/api/auth/login", { body: { username: "alice", password: "ten chars!" } })).toMatchObject({ status: 500, body: { error: "Server error." } });
  error.mockRestore();
  FakePg.last.down = false;
  expect((await api("GET", "/health")).status).toBe(200);
});

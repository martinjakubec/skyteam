// @vitest-environment jsdom
// Accounts in the client: the account chip, sign in, register (and the recovery
// code it shows), forgot password, reset links and the account page. The server
// is faked: fetch answers from a route table.
import "../support/dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PublicUser } from "@skyteam/shared";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));

const { Root } = await import("../../packages/client/src/Root");
const { useAccount } = await import("../../packages/client/src/account/useAccount");
const { useGame } = await import("../../packages/client/src/store");

const ALICE: PublicUser = { id: "u1", username: "alice", role: "USER", privileges: ["history"] };
const CODE = "ABCDE-FGHJK-MNPQR-STVWX";

type Reply = { status?: number; body?: unknown };
type Handler = (body: Record<string, unknown>) => Reply;
let routes: Record<string, Handler>;
let calls: { key: string; body: Record<string, unknown>; init: RequestInit }[];

beforeEach(() => {
  routes = { "GET /api/auth/me": () => ({ body: { user: null } }) };
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ key, body, init: init ?? {} });
    const handler = routes[key];
    const { status = 200, body: out = {} } = handler ? handler(body) : { status: 404, body: { error: "No route" } };
    return new Response(status === 204 ? null : JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  });
  useAccount.setState({ user: undefined, available: true });
  useGame.setState({ socket: null });
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = async (path: string) => {
  window.history.replaceState(null, "", path);
  render(<Root />);
  await waitFor(() => expect(useAccount.getState().user).not.toBe(undefined));
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("the account chip on the landing page", () => {
  test("a guest sees Sign in and Register, and the landing page as before", async () => {
    await open("/");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin");
    expect(screen.getByRole("link", { name: "Register" }).getAttribute("href")).toBe("/register");
    expect(screen.getByRole("button", { name: "Create a room" })).toBeTruthy();
  });

  test("without accounts on the server (503) there's no chip, and playing works as before", async () => {
    routes["GET /api/auth/me"] = () => ({ status: 503, body: { error: "Accounts need the database." } });
    await open("/");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBe(null);
    expect(screen.getByRole("button", { name: "Create a room" })).toBeTruthy();
  });

  test("signed in: the name opens a menu; Statistics and Users only with their privileges", async () => {
    routes["GET /api/auth/me"] = () => ({ body: { user: ALICE } });
    await open("/");
    click("alice");
    expect(screen.getByRole("link", { name: "My games" }).getAttribute("href")).toBe("/history");
    expect(screen.getByRole("link", { name: "Account" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Statistics" })).toBe(null);
    expect(screen.queryByRole("link", { name: "Users" })).toBe(null);
    act(() => useAccount.setState({ user: { ...ALICE, privileges: ["history", "manage_users", "view_stats"] } }));
    expect(screen.getByRole("link", { name: "Statistics" }).getAttribute("href")).toBe("/admin");
    expect(screen.getByRole("link", { name: "Users" }).getAttribute("href")).toBe("/admin/users");
    routes["POST /api/auth/logout"] = () => ({ status: 204 });
    click("Sign out");
    await waitFor(() => expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy());
  });
});

describe("register", () => {
  test("shows the recovery code once; 'I've saved it' goes on, signed in", async () => {
    routes["POST /api/auth/register"] = (b) => ({ status: 201, body: { user: { ...ALICE, username: b.username }, recoveryCode: CODE } });
    await open("/register");
    type("Username", "alice");
    type("Password", "ten chars!");
    click("Register");
    await screen.findByText(CODE);
    expect(screen.getByText(/only way to reset your password yourself/)).toBeTruthy();
    expect(calls.at(-1)!.body).toEqual({ username: "alice", password: "ten chars!" });
    click("I've saved it");
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: "alice" })).toBeTruthy();
  });

  test("the server's refusal shows in an alert", async () => {
    routes["POST /api/auth/register"] = () => ({ status: 409, body: { error: "That username is taken." } });
    await open("/register");
    type("Username", "alice");
    type("Password", "ten chars!");
    click("Register");
    expect((await screen.findByRole("alert")).textContent).toBe("That username is taken.");
  });
});

describe("sign in", () => {
  test("a wrong password: the error, and the password field is cleared", async () => {
    routes["POST /api/auth/login"] = () => ({ status: 401, body: { error: "Wrong username or password." } });
    await open("/signin");
    type("Username", "alice");
    type("Password", "nope nope!");
    click("Sign in");
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  test("signed in, it goes where ?next says — only to a path on this site", async () => {
    routes["POST /api/auth/login"] = () => ({ body: { user: ALICE } });
    await open("/signin?next=/history");
    type("Username", "alice");
    type("Password", "ten chars!");
    click("Sign in");
    await waitFor(() => expect(window.location.pathname).toBe("/history"));
    cleanup();
    await open("/signin?next=//evil.example/x");
    type("Username", "alice");
    type("Password", "ten chars!");
    click("Sign in");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  test("every request carries the cookie (credentials: include)", async () => {
    routes["POST /api/auth/login"] = () => ({ body: { user: ALICE } });
    await open("/signin");
    type("Username", "alice");
    type("Password", "ten chars!");
    click("Sign in");
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/auth/login")).toBe(true));
    for (const c of calls) expect(c.init.credentials).toBe("include");
  });
});

describe("forgot password and reset links", () => {
  test("forgot: name, code and a new password give a new code", async () => {
    routes["POST /api/auth/recover"] = () => ({ body: { user: ALICE, recoveryCode: CODE } });
    await open("/forgot");
    type("Username", "alice");
    type("Recovery code", "zzzzz-zzzzz-zzzzz-zzzzz");
    type("New password", "new password!");
    click("Set new password");
    await screen.findByText(CODE);
    expect(calls.at(-1)!.body).toEqual({ username: "alice", recoveryCode: "zzzzz-zzzzz-zzzzz-zzzzz", newPassword: "new password!" });
  });

  test("reset link: the token leaves the address bar, and is sent with the new password", async () => {
    const token = "a".repeat(43);
    routes["POST /api/auth/reset"] = () => ({ body: { user: ALICE, recoveryCode: CODE } });
    await open(`/reset?token=${token}`);
    expect(window.location.search).toBe("");
    type("New password", "new password!");
    click("Set new password");
    await screen.findByText(CODE);
    expect(calls.at(-1)!.body).toEqual({ token, newPassword: "new password!" });
  });

  test("an expired link says so", async () => {
    routes["POST /api/auth/reset"] = () => ({ status: 410, body: { error: "This reset link has expired or was already used." } });
    await open(`/reset?token=${"b".repeat(43)}`);
    type("New password", "new password!");
    click("Set new password");
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired/);
  });
});

describe("the account page", () => {
  beforeEach(() => {
    routes["GET /api/auth/me"] = () => ({ body: { user: ALICE } });
  });

  test("a guest is sent to sign in first", async () => {
    routes["GET /api/auth/me"] = () => ({ body: { user: null } });
    await open("/account");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/signin?next=%2Faccount"));
  });

  test("change password", async () => {
    routes["POST /api/account/password"] = () => ({ body: { user: ALICE } });
    await open("/account");
    type("Current password", "ten chars!");
    type("New password", "new password!");
    click("Change password");
    expect(await screen.findByText("Password changed. You're signed out everywhere else.")).toBeTruthy();
    expect(calls.at(-1)!.body).toEqual({ currentPassword: "ten chars!", newPassword: "new password!" });
  });

  test("a new recovery code", async () => {
    routes["POST /api/account/recovery-code"] = () => ({ body: { recoveryCode: CODE } });
    await open("/account");
    type("Password for a new code", "ten chars!");
    click("New recovery code");
    await screen.findByText(CODE);
  });

  test("sign out everywhere", async () => {
    routes["POST /api/account/sign-out-everywhere"] = () => ({ status: 204 });
    await open("/account");
    click("Sign out everywhere");
    await waitFor(() => expect(window.location.pathname).toBe("/signin"));
    expect(useAccount.getState().user).toBe(null);
  });

  test("delete my account: needs the password and a confirmation", async () => {
    routes["DELETE /api/account"] = () => ({ status: 204 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open("/account");
    type("Password to delete", "ten chars!");
    click("Delete my account");
    expect(calls.some((c) => c.key === "DELETE /api/account")).toBe(false);
    confirm.mockReturnValue(true);
    click("Delete my account");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(calls.find((c) => c.key === "DELETE /api/account")!.body).toEqual({ password: "ten chars!" });
  });
});

test("in a room: a change of account (signed in in another tab) reconnects the room's socket", async () => {
  await open("/");
  const socket = { disconnect: vi.fn(), connect: vi.fn() };
  useGame.setState({ socket: socket as never });
  routes["GET /api/auth/me"] = () => ({ body: { user: ALICE } });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(socket.connect).toHaveBeenCalled());
  expect(socket.disconnect).toHaveBeenCalled();
  // The same account again: nothing to do.
  socket.connect.mockClear();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(socket.connect).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
// The admin pages: the statistics dashboard (view_stats) and the users page
// (manage_users). The server is faked: fetch answers from a route table.
import "../support/dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AdminStats, PublicUser } from "@skyteam/shared";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));

const { Root } = await import("../../packages/client/src/Root");
const { useAccount } = await import("../../packages/client/src/account/useAccount");

const user = (role: string, privileges: string[]): PublicUser => ({ id: `id-${role}`, username: role.toLowerCase(), role, privileges });
const ADMIN = user("ADMIN", ["history", "view_stats"]);
const SUPER = user("SUPERADMIN", ["history", "manage_users", "view_stats"]);
const PLAIN = user("USER", ["history"]);

const STATS: AdminStats = {
  generatedAt: "2026-10-08T12:00:00.000Z",
  includeSeeded: false,
  seededGames: 2,
  playRate: [
    { scenario: "YUL", games: 4, pct_of_all_games: 66.7, finished: 3, pct_of_finished_games: 100 },
    { scenario: "red-TGU", games: 2, pct_of_all_games: 33.3, finished: 0, pct_of_finished_games: 0 },
  ],
  crashCauses: [{ scenario: "YUL", cause: "Landing failed", losses: 2, pct_of_airport_losses: 100 }],
  failedLandings: [{ scenario: "YUL", condition: "Speed too high", failed_landings: 2 }],
  winRateByAirport: [{ scenario: "YUL", finished: 3, won: 1, lost: 2, win_pct: 33.3 }],
  winRateByAbility: [],
  winRateByModule: [{ module: "intern", finished: 1, win_pct: 100 }],
  humansVsBot: [{ scenario: "YUL", crew: "two humans", finished: 3, win_pct: 33.3 }],
  unfinished: [{ result: "exited", rounds_reached: 2, games: 1 }],
  recentGames: [
    { id: "g".repeat(21), scenario: "YUL", result: "won", loss_reason: null, rounds_reached: 7, pilot: "human", copilot: "bot:aviator", ended_at: "2026-10-08T11:00:00.000Z", seeded: true },
  ],
};

type Handler = (url: URL, body: Record<string, unknown>) => { status?: number; body?: unknown };
let routes: Record<string, Handler>;
let calls: { key: string; url: URL; body: Record<string, unknown> }[];
beforeEach(() => {
  routes = { "GET /api/auth/me": () => ({ body: { user: ADMIN } }), "GET /api/admin/stats": () => ({ body: STATS }) };
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ key, url, body });
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    const { status = 200, body: out = {} } = handler ? handler(url, body) : { status: 404, body: { error: "No route" } };
    return new Response(status === 204 ? null : JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  });
  useAccount.setState({ user: undefined, available: true });
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
const section = (name: RegExp) => screen.getByRole("region", { name });

describe("the statistics dashboard", () => {
  test("a guest is sent to sign in", async () => {
    routes["GET /api/auth/me"] = () => ({ body: { user: null } });
    await open("/admin");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/signin?next=%2Fadmin"));
  });

  test("a USER may not see it, and nothing is fetched", async () => {
    routes["GET /api/auth/me"] = () => ({ body: { user: PLAIN } });
    await open("/admin");
    expect(await screen.findByText("You don't have access to this.")).toBeTruthy();
    expect(calls.some((c) => c.key === "GET /api/admin/stats")).toBe(false);
  });

  test("an ADMIN sees the totals and every section", async () => {
    await open("/admin");
    expect(await screen.findByRole("heading", { name: "SkyTeam statistics" })).toBeTruthy();
    const totals = screen.getByRole("region", { name: "Totals" }).textContent!;
    expect(totals).toMatch(/6\s*games/);
    expect(totals).toMatch(/3\s*finished/);
    expect(totals).toMatch(/1\s*won/);
    expect(totals).toMatch(/33\.3\s*%\s*win rate/);
    for (const name of [/Play rate/, /Win rate per airport/, /Crash causes/, /Failed landings/, /Special Abilities/, /Modules/, /Humans and the bot/, /Unfinished games/, /Recent games/])
      expect(section(name)).toBeTruthy();
    const play = section(/Play rate/);
    expect(within(play).getByText("YUL Montréal-Trudeau")).toBeTruthy();
    expect(within(play).getAllByText("66.7 %").length).toBeGreaterThan(0);
    expect(within(section(/Special Abilities/)).getByText("No games yet.")).toBeTruthy();
    const recent = section(/Recent games/);
    expect(within(recent).getByRole("link", { name: /YUL/ }).getAttribute("href")).toBe(`/games/${"g".repeat(21)}`);
    expect(within(recent).getByText("same dice")).toBeTruthy();
  });

  test("the same-dice switch asks again with them counted", async () => {
    await open("/admin");
    const toggle = await screen.findByRole("checkbox", { name: /Include same-dice games \(2\)/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/admin/stats" && c.url.searchParams.get("includeSeeded") === "1")).toBe(true));
  });

  test("signed out meanwhile: Refresh goes to sign in", async () => {
    await open("/admin");
    await screen.findByRole("heading", { name: "SkyTeam statistics" });
    routes["GET /api/admin/stats"] = () => ({ status: 401, body: { error: "Please sign in." } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(window.location.pathname).toBe("/signin"));
  });

  test("nothing finished yet: the win rate is a dash", async () => {
    routes["GET /api/admin/stats"] = () => ({ body: { ...STATS, playRate: [], winRateByAirport: [] } });
    await open("/admin");
    const totals = (await screen.findByRole("region", { name: "Totals" })).textContent!;
    expect(totals).toMatch(/—\s*win rate/);
    expect(totals).toMatch(/0\s*games/);
  });
});

// @vitest-environment jsdom
// Where the browser finds the server: a pinned VITE_SERVER_URL wins; a
// production build uses the page's own origin (the site's proxy forwards the
// API and the WebSocket); development derives <host>:3001.
import { afterEach, expect, test, vi } from "vitest";

const { resolveServerUrl } = await import("../../packages/client/src/config");

afterEach(() => vi.unstubAllEnvs());

test("development: the page's host on port 3001", () => {
  vi.stubEnv("PROD", false);
  vi.stubEnv("VITE_SERVER_URL", "");
  expect(resolveServerUrl()).toBe(`${window.location.protocol}//${window.location.hostname}:3001`);
});

test("production: the page's own origin", () => {
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_SERVER_URL", "");
  expect(resolveServerUrl()).toBe(window.location.origin);
});

test("a pinned VITE_SERVER_URL wins, in production too", () => {
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_SERVER_URL", "https://api.example");
  expect(resolveServerUrl()).toBe("https://api.example");
});

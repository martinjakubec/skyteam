import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    // Each test file in its own process: some tests start worker threads (the bot's search).
    pool: "forks",
    // The bot's tests play whole games; a section can take a minute.
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
    // Point failures at the test's line, not inside the assertion helpers.
    onStackTrace: (_error, { file }) => !file.includes("tests/support/"),
  },
});

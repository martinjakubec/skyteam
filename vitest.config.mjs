import { defineConfig } from "vitest/config";

export default defineConfig({
  // The client's components use React's automatic JSX runtime (its tsconfig: react-jsx).
  esbuild: { jsx: "automatic" },
  test: {
    // Client tests (*.test.tsx) pick a browser-like DOM per file: @vitest-environment jsdom.
    include: ["tests/**/*.test.{mjs,tsx}"],
    // Each test file in its own process: some tests start worker threads (the bot's search).
    pool: "forks",
    // The bot's tests play whole games; a section can take a minute.
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
    // Point failures at the test's line, not inside the assertion helpers.
    onStackTrace: (_error, { file }) => !file.includes("tests/support/"),
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      // Entry points and declaration-only files: nothing to execute.
      exclude: ["**/*.d.ts", "packages/client/src/main.tsx", "packages/server/src/index.ts"],
      reporter: ["text-summary", "json-summary", "text"],
      reportsDirectory: "coverage",
      // The floor: a run below it fails (currently ~97% of lines).
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

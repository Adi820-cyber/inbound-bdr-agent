import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Resolves the `@/*` and `@tests/*` aliases from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    // `npm test` runs `vitest --run`, so the suite is non-watch by default.
    globals: true,
    // Node is the default environment. Component tests opt into jsdom with a
    // per-file docblock: `// @vitest-environment jsdom`
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    // Global setup files, run before every test file.
    // Task 1.5: the network/LLM isolation guard replaces global `fetch` with a
    // stub that throws, so no test can reach the network or a live model.
    setupFiles: ["./tests/setup/no-live-calls.ts"],
    passWithNoTests: true,
  },
});

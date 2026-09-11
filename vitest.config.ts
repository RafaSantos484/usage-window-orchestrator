import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Deterministic tests: no network, no real provider CLI, no wall-clock sleeps.
    testTimeout: 10_000,
  },
});

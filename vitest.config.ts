import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    // Real scrypt is slow by design; tests inject cheap parameters, but allow headroom.
    testTimeout: 20_000,
  },
});

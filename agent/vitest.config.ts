import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The P2-4 import tests exercise the real SQLite seam: each import creates
    // an isolated backup (VACUUM INTO), verifies integrity/FK, computes the
    // complete destination digest, and runs replay-drift assertions. On slower
    // CI runners a single import can exceed vitest's 5s default under parallel
    // load (observed: one import test at ~5.3s vs ~0.3s locally), so the
    // timeout is raised for the whole suite.
    testTimeout: 20_000,
  },
});

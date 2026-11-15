import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Some tests, and some hooks that prepare a file's tests, replay thousands of PEAR's cases. A hosted runner is
    // several times slower than a desk machine, and slower again while the other files run beside it, so both get
    // more time than vitest's defaults (5 s and 10 s).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

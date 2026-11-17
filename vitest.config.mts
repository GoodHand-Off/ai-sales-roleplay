import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      // Server code, the browser call client, persona data and the API routes.
      include: ["lib/**/*.ts", "content/**/*.ts", "app/api/**/*.ts"],
      exclude: [
        // React components and pages: verified in a real browser (see CONTRIBUTING.md,
        // "Checking the UI"); the logic they use lives in lib/ and is covered here.
        "components/**",
        "app/**/*.tsx",
      ],
      thresholds: { lines: 90 },
      reporter: ["text-summary", "text"],
    },
  },
});

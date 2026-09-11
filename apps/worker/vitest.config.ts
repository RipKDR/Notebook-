import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: {
      "@loom/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
});

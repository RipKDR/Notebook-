import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: {
      "@loom/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      // The sync round-trip test drives the real local database against the real
      // server store. Source rather than build output, so a stale dist cannot
      // make it pass.
      "@loom/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
});

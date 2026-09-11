import { defineConfig } from "vitest/config";

/**
 * Covers the app's pure logic only. Anything importing React Native belongs to
 * jest-expo, which needs the Metro-aligned Babel config and native module mocks.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});

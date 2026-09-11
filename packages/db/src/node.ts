/**
 * Node-only entry point.
 *
 * Kept separate from `index.ts` so that importing `@loom/db` from React Native
 * never reaches `node:sqlite`, which Metro cannot resolve.
 */
export { NodeSqliteAdapter } from "./node-adapter.js";

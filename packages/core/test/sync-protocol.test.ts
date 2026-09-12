import { describe, expect, it } from "vitest";
import {
  SYNC_PROTOCOL_VERSION,
  fragmentsDiffer,
  laterOf,
  syncOnce,
  type SyncLocal,
  type SyncResponse,
} from "../src/index.js";

describe("sync protocol ordering", () => {
  it("chooses the same version when equal timestamps are compared in either order", () => {
    const a = { id: "f1", updatedAt: 1000, text: "alpha", pinned: false };
    const b = { id: "f1", updatedAt: 1000, text: "beta", pinned: true };

    expect(laterOf(a, b)).toEqual(laterOf(b, a));
  });

  it("detects project assignment and pin metadata changes", () => {
    const base = {
      id: "f1",
      projectId: null,
      text: "a note",
      createdAt: 1,
      updatedAt: 2,
      source: "quick" as const,
      deletedAt: null,
      pinned: false,
    };
    expect(fragmentsDiffer(base, { ...base, projectId: "p1" })).toBe(true);
    expect(fragmentsDiffer(base, { ...base, pinned: true })).toBe(true);
  });

  it("forwards the abort signal to an active transport round", async () => {
    const controller = new AbortController();
    const local: SyncLocal = {
      dirtyFragments: async () => [],
      dirtyProjects: async () => [],
      markSynced: async () => undefined,
      applyRemoteFragments: async () => ({ applied: 0, skipped: 0 }),
      applyRemoteProjects: async () => ({ applied: 0, skipped: 0 }),
      saveConflictCopy: async () => undefined,
      syncState: async () => ({ cursor: 0, lastSyncedAt: null, lastError: null }),
      setSyncCursor: async () => undefined,
    };
    const response: SyncResponse = {
      protocol: SYNC_PROTOCOL_VERSION,
      cursor: 0,
      hasMore: false,
      fragments: [],
      projects: [],
      accepted: {},
      conflicts: { fragments: [], projects: [] },
    };

    await syncOnce({
      local,
      signal: controller.signal,
      transport: async (_request, signal) => {
        expect(signal).toBe(controller.signal);
        return response;
      },
    });
  });
});

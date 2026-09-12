import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sync, type SyncLocal, type SyncRequest, type SyncResponse } from "@loom/core";
import { LoomDatabase } from "@loom/db";
import { NodeSqliteAdapter } from "../../../packages/db/src/node-adapter.js";
import { SyncStore } from "../src/sync-store.js";

/**
 * Two devices and one server, all real.
 *
 * Every stage of this was unit-tested in isolation — the store's conflict rules,
 * the local database's dirty tracking, the engine's merge order — and none of
 * that proves the three agree. This is the test that runs the actual protocol
 * end to end, the same way `compile.e2e.test.ts` is what caught the three bugs
 * that per-stage testing could not reach.
 *
 * The question it exists to answer is the only one that matters here: can a word
 * the user typed be lost?
 */

const ACCOUNT = "acct-1";

class Device {
  readonly db: LoomDatabase;

  private constructor(db: LoomDatabase, readonly name: string) {
    this.db = db;
  }

  static async create(name: string): Promise<Device> {
    const db = new LoomDatabase(new NodeSqliteAdapter(new DatabaseSync(":memory:")));
    await db.migrate();
    return new Device(db, name);
  }

  /** Talks to the real store, through the real wire shape. */
  transport(store: SyncStore, account = ACCOUNT) {
    return async (request: SyncRequest): Promise<SyncResponse> => {
      // Round-trip through JSON, because that is what actually happens and it is
      // where an undefined or a Map would quietly turn into something else.
      const wire = JSON.parse(JSON.stringify(request)) as SyncRequest;
      const result = store.sync(account, {
        since: wire.since,
        fragments: wire.fragments,
        projects: wire.projects,
        ...(wire.limit !== undefined ? { limit: wire.limit } : {}),
      });
      return JSON.parse(JSON.stringify({ protocol: wire.protocol, ...result })) as SyncResponse;
    };
  }

  sync(store: SyncStore, account = ACCOUNT) {
    return sync({ local: this.db as unknown as SyncLocal, transport: this.transport(store, account) });
  }

  async texts(): Promise<string[]> {
    return (await this.db.listFragments({ limit: 500 })).map((f) => f.text).sort();
  }

  async liveTexts(): Promise<string[]> {
    return (await this.db.allUsableFragments()).map((f) => f.text).sort();
  }
}

let store: SyncStore;
let alice: Device;
let bob: Device;

beforeEach(async () => {
  store = SyncStore.open();
  alice = await Device.create("alice");
  bob = await Device.create("bob");
});

describe("two devices, one notebook", () => {
  it("carries a note from one device to the other", async () => {
    await alice.db.capture("She never once said my name.");
    await alice.sync(store);
    await bob.sync(store);

    expect(await bob.texts()).toEqual(["She never once said my name."]);
  });

  it("restores a whole notebook onto a device that has never seen it", async () => {
    for (let i = 0; i < 30; i++) await alice.db.capture(`note ${i}`);
    const project = await alice.db.createProject("The Kitchen Radio", "memoir", 40_000);
    await alice.sync(store);

    const outcome = await bob.sync(store);
    expect(outcome.pulled).toBe(31);
    expect((await bob.texts()).length).toBe(30);
    expect((await bob.db.listProjects())[0]?.title).toBe("The Kitchen Radio");
    expect((await bob.db.listProjects())[0]?.id).toBe(project.id);
  });

  it("converges when both devices have written separately", async () => {
    await alice.db.capture("from Alice");
    await bob.db.capture("from Bob");

    await alice.sync(store);
    await bob.sync(store);
    await alice.sync(store);

    expect(await alice.texts()).toEqual(["from Alice", "from Bob"]);
    expect(await bob.texts()).toEqual(["from Alice", "from Bob"]);
  });

  it("settles after one further round with nothing left to do", async () => {
    await alice.db.capture("a note");
    await alice.sync(store);
    await bob.sync(store);

    const quiet = await bob.sync(store);
    expect(quiet.pushed).toBe(0);
    expect(quiet.pulled).toBe(0);
    expect(quiet.conflicts).toBe(0);
  });

  it("propagates an edit made on the other device", async () => {
    const fragment = await alice.db.capture("original");
    await alice.sync(store);
    await bob.sync(store);

    await bob.db.updateText(fragment.id, "revised on Bob");
    await bob.sync(store);
    await alice.sync(store);

    expect(await alice.texts()).toEqual(["revised on Bob"]);
  });

  it("propagates a deletion as a tombstone rather than a resurrection", async () => {
    const fragment = await alice.db.capture("a note");
    await alice.sync(store);
    await bob.sync(store);

    await bob.db.softDelete(fragment.id);
    await bob.sync(store);
    await alice.sync(store);

    expect(await alice.liveTexts()).toEqual([]);
    // A later sync must not bring it back, which is what happens when a delete
    // is a row removal rather than a tombstone.
    await alice.sync(store);
    await bob.sync(store);
    expect(await alice.liveTexts()).toEqual([]);
    expect(await bob.liveTexts()).toEqual([]);
  });

  it("propagates a project assignment", async () => {
    const fragment = await alice.db.capture("a note");
    const project = await alice.db.createProject("A book", "memoir", 40_000);
    await alice.db.assignFragments([fragment.id], project.id);
    await alice.sync(store);
    await bob.sync(store);

    const onBob = await bob.db.allUsableFragments(project.id);
    expect(onBob.map((f) => f.text)).toEqual(["a note"]);
  });

  it("makes synced notes searchable on the receiving device", async () => {
    await alice.db.capture("Every drawer in that house had string in it.");
    await alice.sync(store);
    await bob.sync(store);

    expect((await bob.db.search("drawer")).map((f) => f.text)).toEqual([
      "Every drawer in that house had string in it.",
    ]);
  });

  it("does not make a device re-index the notes it just uploaded", async () => {
    // A push comes back in the same page, because the response is read after
    // the write. Re-applying it would clear the enrichment derived from the
    // text — so the device would pay the model again to derive what it already
    // knows, on every note, on every sync.
    const fragment = await alice.db.capture("a note about the kitchen radio");
    await alice.db.applyEnrichment(fragment.id, {
      enrichment: {
        kind: "scene",
        digest: "about the radio",
        entities: [],
        themes: [],
        valence: 0,
        standalone: 0.5,
        enricherVersion: "v1",
        enrichedAt: Date.now(),
      },
      embedding: Float32Array.from([0.1, 0.2, 0.3]),
      embeddingModel: "test",
    });
    expect(await alice.db.fragmentsNeedingEnrichment()).toHaveLength(0);

    const outcome = await alice.sync(store);
    expect(outcome.pushed).toBe(1);
    // Its own push does not come back as something to write.
    expect(outcome.pulled).toBe(0);
    expect((await alice.db.getFragment(fragment.id))?.enrichment?.digest).toBe("about the radio");
    expect((await alice.db.getFragment(fragment.id))?.embedding).not.toBeNull();
    expect(await alice.db.fragmentsNeedingEnrichment()).toHaveLength(0);
  });

  it("queues synced notes for indexing on the receiving device", async () => {
    // Enrichment does not travel — it is derived, and an embedding is 4KB a
    // note. The receiving device has to know to regenerate it, or its Threads
    // screen stays empty for everything it was sent.
    await alice.db.capture("a note about the kitchen radio");
    await alice.sync(store);
    await bob.sync(store);

    expect((await bob.db.fragmentsNeedingEnrichment()).map((f) => f.text)).toEqual([
      "a note about the kitchen radio",
    ]);
  });
});

describe("conflicts", () => {
  it("keeps both versions when two devices edit the same note offline", async () => {
    const fragment = await alice.db.capture("original");
    await alice.sync(store);
    await bob.sync(store);

    // Both go offline and edit the same note.
    await alice.db.updateText(fragment.id, "Alice's ending");
    await bob.db.updateText(fragment.id, "Bob's ending");

    await alice.sync(store);
    await bob.sync(store);

    // Bob loses the race for the canonical record — but not his words.
    const onBob = await bob.texts();
    expect(onBob).toContain("Alice's ending");
    expect(onBob.some((t) => t.startsWith("Bob's ending"))).toBe(true);
    expect(onBob.some((t) => t.includes("another device"))).toBe(true);
  });

  it("gives the conflict copy back to the other device too", async () => {
    const fragment = await alice.db.capture("original");
    await alice.sync(store);
    await bob.sync(store);

    await alice.db.updateText(fragment.id, "Alice's ending");
    await bob.db.updateText(fragment.id, "Bob's ending");
    await alice.sync(store);
    await bob.sync(store);
    await alice.sync(store);

    // Alice sees Bob's rejected text as well: nobody has to open the other
    // person's phone to find out what was written.
    expect((await alice.texts()).some((t) => t.startsWith("Bob's ending"))).toBe(true);
  });

  it("converges on the same notebook after a conflict", async () => {
    const fragment = await alice.db.capture("original");
    await alice.sync(store);
    await bob.sync(store);

    await alice.db.updateText(fragment.id, "Alice's ending");
    await bob.db.updateText(fragment.id, "Bob's ending");

    // Sync both repeatedly; they must reach the same state and stay there.
    for (let round = 0; round < 3; round++) {
      await alice.sync(store);
      await bob.sync(store);
    }

    expect(await alice.texts()).toEqual(await bob.texts());
    expect((await alice.texts()).length).toBe(2);
  });

  it("does not duplicate a note when the same push is retried", async () => {
    // A response lost on a flaky connection means the client pushes again from
    // the same base. Forking a copy there would fill a notebook with duplicates.
    await alice.db.capture("a note");
    const transport = alice.transport(store);
    const request = {
      protocol: 1,
      since: null,
      fragments: (await alice.db.dirtyFragments()).map((d) => ({
        record: {
          id: d.fragment.id as string,
          projectId: null,
          text: d.fragment.text,
          createdAt: d.fragment.createdAt,
          updatedAt: d.fragment.updatedAt,
          source: d.fragment.source,
          deletedAt: null,
          pinned: false,
        },
        baseRev: null,
      })),
      projects: [],
    } as SyncRequest;

    await transport(request);
    await transport(request);

    await bob.sync(store);
    expect(await bob.texts()).toEqual(["a note"]);
  });
});

describe("resilience", () => {
  it("does not lose a note captured while a sync was in flight", async () => {
    // The classic way a sync eats writing: the response arrives, the flag is
    // cleared wholesale, and the note typed a moment earlier is never uploaded.
    await alice.db.capture("first");

    const dirty = await alice.db.dirtyFragments();
    const captured = await alice.db.capture("typed during the request");
    expect(dirty.map((d) => d.fragment.id)).not.toContain(captured.id);

    await alice.sync(store);
    await bob.sync(store);

    expect(await bob.texts()).toEqual(["first", "typed during the request"]);
  });

  it("does not overwrite an unsent local edit with an older remote one", async () => {
    const fragment = await alice.db.capture("original");
    await alice.sync(store);
    await bob.sync(store);

    await alice.db.updateText(fragment.id, "Alice's newer text");
    await alice.sync(store);

    // Bob has his own unsent edit. The incoming record must not flatten it.
    await bob.db.updateText(fragment.id, "Bob's unsent text");
    await bob.sync(store);

    expect((await bob.texts()).some((t) => t.startsWith("Bob's unsent text"))).toBe(true);
  });

  it("recovers everything after a device resets its sync position", async () => {
    await alice.db.capture("one");
    await alice.db.capture("two");
    await alice.sync(store);
    await bob.sync(store);

    // Something went wrong and the device starts over.
    await bob.db.resetSync();
    expect((await bob.db.syncState()).cursor).toBe(0);

    await bob.sync(store);
    expect(await bob.texts()).toEqual(["one", "two"]);
    // Re-uploading what the server already has must not duplicate it.
    await alice.sync(store);
    expect(await alice.texts()).toEqual(["one", "two"]);
  });

  it("pages a large notebook through in several round trips", async () => {
    for (let i = 0; i < 120; i++) await alice.db.capture(`note ${i}`);
    await alice.sync(store);

    const rounds: number[] = [];
    await sync({
      local: bob.db as unknown as SyncLocal,
      transport: bob.transport(store),
      batchSize: 25,
      onProgress: (o) => rounds.push(o.pulled),
    });

    expect(rounds.length).toBeGreaterThan(1);
    expect((await bob.texts()).length).toBe(120);
  });

  it("advances the cursor only over records it has written", async () => {
    for (let i = 0; i < 10; i++) await alice.db.capture(`note ${i}`);
    await alice.sync(store);

    // One truncated page, then a crash before the next round.
    await sync({
      local: bob.db as unknown as SyncLocal,
      transport: bob.transport(store),
      batchSize: 3,
      maxRounds: 1,
    });

    const partial = (await bob.texts()).length;
    expect(partial).toBeLessThan(10);

    // Resuming from the saved cursor must reach the rest, not skip it.
    await bob.sync(store);
    expect((await bob.texts()).length).toBe(10);
  });

  it("keeps two accounts' notebooks apart", async () => {
    await alice.db.capture("Alice's private note");
    await alice.sync(store, "acct-1");

    const stranger = await Device.create("stranger");
    await stranger.sync(store, "acct-2");
    expect(await stranger.texts()).toEqual([]);
  });
});

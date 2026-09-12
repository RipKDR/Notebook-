import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFLICT_SUFFIX, type SyncFragment, type SyncProject } from "@loom/core";
import { LoomDatabase } from "../src/repository.js";
import { NodeSqliteAdapter } from "../src/node-adapter.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/schema.js";

/**
 * The local half of sync.
 *
 * Every test here is really the same question: can this lose writing? A cleared
 * dirty flag that strands an edit, a remote record that flattens an unsent one,
 * a conflict copy that never gets written — each one loses words the user typed
 * and cannot get back.
 */

let db: LoomDatabase;

beforeEach(async () => {
  db = new LoomDatabase(new NodeSqliteAdapter(new DatabaseSync(":memory:")));
  await db.migrate();
});

const remoteFragment = (
  id: string,
  text: string,
  over: Partial<SyncFragment> = {},
): SyncFragment => ({
  id,
  projectId: null,
  text,
  createdAt: 1000,
  updatedAt: 2000,
  source: "quick",
  deletedAt: null,
  pinned: false,
  ...over,
});

const remoteProject = (id: string, title: string, over: Partial<SyncProject> = {}): SyncProject => ({
  id,
  title,
  form: "memoir",
  targetWords: 40_000,
  createdAt: 1000,
  updatedAt: 2000,
  archivedAt: null,
  ...over,
});

describe("migrations", () => {
  it("reports the current schema version", async () => {
    expect(await db.migrate()).toBe(SCHEMA_VERSION);
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
  });

  it("upgrades a database that was created at version 1", async () => {
    // The migration path has never actually run in anger before this. A user's
    // notebook is the one database that cannot be recreated from scratch.
    const sqlite = new DatabaseSync(":memory:");
    const raw = new NodeSqliteAdapter(sqlite);
    await raw.exec(MIGRATIONS[0]!.sql);
    await raw.exec("PRAGMA user_version = 1;");

    await raw.run(
      `INSERT INTO projects (id, title, form, target_words, created_at, updated_at)
       VALUES ('p1', 'The Kitchen Radio', 'memoir', 40000, 1, 1)`,
    );
    await raw.run(
      `INSERT INTO fragments (id, text, created_at, updated_at, source)
       VALUES ('f1', 'She never once said my name.', 1, 1, 'quick')`,
    );

    const upgraded = new LoomDatabase(raw);
    expect(await upgraded.migrate()).toBe(SCHEMA_VERSION);

    // The writing survived, and the new columns exist with sane defaults.
    const fragments = await upgraded.listFragments();
    expect(fragments[0]?.text).toBe("She never once said my name.");
    expect((await upgraded.dirtyProjects())[0]?.project.title).toBe("The Kitchen Radio");
    expect(await upgraded.syncState()).toMatchObject({ cursor: 0, lastSyncedAt: null });

    // Search still works, which is what a botched trigger would break.
    expect((await upgraded.search("name")).length).toBe(1);
    sqlite.close();
  });

  it("is idempotent across repeated launches", async () => {
    expect(await db.migrate()).toBe(SCHEMA_VERSION);
    expect(await db.migrate()).toBe(SCHEMA_VERSION);
  });
});

describe("what needs pushing", () => {
  it("treats a new capture as dirty", async () => {
    await db.capture("She never once said my name.");
    const dirty = await db.dirtyFragments();

    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.baseRev).toBeNull();
    expect(dirty[0]?.fragment.text).toBe("She never once said my name.");
  });

  it("catches a pin, which the change log it replaced silently missed", async () => {
    const fragment = await db.capture("a note");
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: 1 },
    ]);
    expect(await db.countDirty()).toMatchObject({ fragments: 0 });

    await db.setPinned(fragment.id, true);
    expect(await db.countDirty()).toMatchObject({ fragments: 1 });
  });

  it("catches assigning a note to a book", async () => {
    const fragment = await db.capture("a note");
    const project = await db.createProject("A book", "memoir", 40_000);
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: 1 },
    ]);

    await db.assignFragments([fragment.id], project.id);
    expect(await db.countDirty()).toMatchObject({ fragments: 1 });
  });

  it("treats a soft delete as something to push", async () => {
    const fragment = await db.capture("a note");
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: 1 },
    ]);

    await db.softDelete(fragment.id);
    const dirty = await db.dirtyFragments();
    expect(dirty[0]?.fragment.deletedAt).not.toBeNull();
    expect(dirty[0]?.baseRev).toBe(1);
  });

  it("treats a new project as dirty", async () => {
    await db.createProject("The Kitchen Radio", "memoir", 40_000);
    expect(await db.countDirty()).toMatchObject({ projects: 1 });
  });
});

describe("acknowledging a push", () => {
  it("clears the flag and records the revision", async () => {
    const fragment = await db.capture("a note");
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 3, localRev: 1 },
    ]);

    expect(await db.countDirty()).toMatchObject({ fragments: 0 });
    // The next edit pushes from revision 3, so the server can tell whether this
    // device was up to date.
    await db.setPinned(fragment.id, true);
    expect((await db.dirtyFragments())[0]?.baseRev).toBe(3);
  });

  it("leaves a note edited while the request was in flight dirty", async () => {
    // Clearing it here would strand that edit on the device forever, which is
    // the quiet way a sync loses someone's writing.
    const fragment = await db.capture("first");
    await db.updateText(fragment.id, "second");
    const inFlight = (await db.dirtyFragments())[0]!;

    // The second edit lands in the same millisecond, which is why the guard
    // cannot be a timestamp.
    await db.updateText(fragment.id, "third");
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 2, localRev: inFlight.localRev },
    ]);

    expect(await db.countDirty()).toMatchObject({ fragments: 1 });
    // The revision is still recorded, so the next push is not rejected as stale.
    expect((await db.dirtyFragments())[0]?.baseRev).toBe(2);
  });

  it("does nothing when given an empty acknowledgement", async () => {
    await db.capture("a note");
    await db.markSynced("fragments", []);
    expect(await db.countDirty()).toMatchObject({ fragments: 1 });
  });
});

describe("applying what the server sent", () => {
  it("inserts a fragment this device has never seen, already clean", async () => {
    const result = await db.applyRemoteFragments([
      { record: remoteFragment("f-remote", "written on the other phone"), rev: 1 },
    ]);

    expect(result).toEqual({ applied: 1, skipped: 0 });
    // Writing it dirty would bounce it back to the server and between devices
    // for ever.
    expect(await db.countDirty()).toMatchObject({ fragments: 0 });
    expect((await db.listFragments())[0]?.text).toBe("written on the other phone");
  });

  it("updates a clean local copy", async () => {
    const fragment = await db.capture("original");
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: 1 },
    ]);

    await db.applyRemoteFragments([
      { record: remoteFragment(fragment.id as string, "revised elsewhere"), rev: 2 },
    ]);

    expect((await db.getFragment(fragment.id))?.text).toBe("revised elsewhere");
  });

  it("refuses to flatten a local edit that has not been pushed yet", async () => {
    const fragment = await db.capture("mine, unsent");

    const result = await db.applyRemoteFragments([
      { record: remoteFragment(fragment.id as string, "theirs"), rev: 2 },
    ]);

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect((await db.getFragment(fragment.id))?.text).toBe("mine, unsent");
  });

  it("re-queues a changed fragment for indexing", async () => {
    // Enrichment is derived from the text and does not travel with it. Leaving
    // a stale digest in place would mislead the outliner about what the note
    // now says.
    const fragment = await db.capture("original");
    await db.applyEnrichment(fragment.id, {
      enrichment: {
        kind: "scene",
        digest: "about the original",
        entities: [],
        themes: ["silence"],
        valence: 0,
        standalone: 0.5,
        enricherVersion: "v1",
        enrichedAt: Date.now(),
      },
    });
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: (await db.dirtyFragments())[0]!.localRev },
    ]);

    await db.applyRemoteFragments([
      { record: remoteFragment(fragment.id as string, "entirely different words"), rev: 2 },
    ]);

    const updated = await db.getFragment(fragment.id);
    expect(updated?.enrichment).toBeNull();
    expect((await db.fragmentsNeedingEnrichment()).map((f) => f.id)).toContain(fragment.id);
  });

  it("keeps the enrichment when the incoming text is identical", async () => {
    // A record can arrive with words this device already has — an echo of its
    // own push, or a note whose pinned flag moved elsewhere. Discarding a good
    // digest for that means paying the model again for the same answer.
    const fragment = await db.capture("unchanged words");
    await db.applyEnrichment(fragment.id, {
      enrichment: {
        kind: "scene",
        digest: "about the words",
        entities: [],
        themes: [],
        valence: 0,
        standalone: 0.5,
        enricherVersion: "v1",
        enrichedAt: Date.now(),
      },
    });
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: (await db.dirtyFragments())[0]!.localRev },
    ]);

    await db.applyRemoteFragments([
      {
        record: remoteFragment(fragment.id as string, "unchanged words", { pinned: true }),
        rev: 2,
      },
    ]);

    const updated = await db.getFragment(fragment.id);
    expect(updated?.pinned).toBe(true);
    expect(updated?.enrichment?.digest).toBe("about the words");
  });

  it("carries a tombstone through", async () => {
    await db.applyRemoteFragments([
      { record: remoteFragment("f1", "deleted elsewhere", { deletedAt: 3000 }), rev: 2 },
    ]);

    expect(await db.allUsableFragments()).toHaveLength(0);
    expect((await db.getFragment("f1" as never))?.deletedAt).toBe(3000);
  });

  it("makes an incoming fragment searchable", async () => {
    // The FTS triggers have to fire for records that arrive by sync, or a
    // restored notebook is silently unsearchable.
    await db.applyRemoteFragments([
      { record: remoteFragment("f1", "Every drawer had string in it."), rev: 1 },
    ]);

    expect((await db.search("drawer")).map((f) => f.id)).toEqual(["f1"]);
  });

  it("keeps search correct when an incoming record replaces one", async () => {
    await db.applyRemoteFragments([{ record: remoteFragment("f1", "lavender and gas"), rev: 1 }]);
    await db.applyRemoteFragments([
      { record: remoteFragment("f1", "the kitchen radio", { updatedAt: 3000 }), rev: 2 },
    ]);

    expect(await db.search("lavender")).toHaveLength(0);
    expect(await db.search("radio")).toHaveLength(1);
  });

  it("inserts and updates projects", async () => {
    await db.applyRemoteProjects([{ record: remoteProject("p1", "The Kitchen Radio"), rev: 1 }]);
    expect((await db.listProjects())[0]?.title).toBe("The Kitchen Radio");

    await db.applyRemoteProjects([
      { record: remoteProject("p1", "Silences", { updatedAt: 3000 }), rev: 2 },
    ]);
    expect((await db.listProjects())[0]?.title).toBe("Silences");
    expect(await db.countDirty()).toMatchObject({ projects: 0 });
  });

  it("refuses to flatten a local project edit that has not been pushed", async () => {
    const project = await db.createProject("Mine", "memoir", 40_000);
    const result = await db.applyRemoteProjects([
      { record: remoteProject(project.id as string, "Theirs"), rev: 2 },
    ]);

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect((await db.listProjects())[0]?.title).toBe("Mine");
  });
});

describe("conflict copies", () => {
  it("keeps rejected text as a real note rather than dropping it", async () => {
    const copy = await db.saveConflictCopy(
      remoteFragment("f1", "the version the server refused"),
      CONFLICT_SUFFIX,
    );

    expect(copy.text).toContain("the version the server refused");
    expect(copy.text).toContain("another device");
    // It is an ordinary fragment: searchable, compilable, deletable.
    expect((await db.search("refused")).map((f) => f.id)).toContain(copy.id);
    expect(await db.countDirty()).toMatchObject({ fragments: 1 });
  });

  it("gives the copy a new id so it does not collide with the original", async () => {
    const copy = await db.saveConflictCopy(remoteFragment("f1", "text"), CONFLICT_SUFFIX);
    expect(copy.id as string).not.toBe("f1");
  });

  it("keeps the copy in the same book as the original", async () => {
    const project = await db.createProject("A book", "memoir", 40_000);
    const copy = await db.saveConflictCopy(
      remoteFragment("f1", "text", { projectId: project.id as string }),
      CONFLICT_SUFFIX,
    );
    expect(copy.projectId).toBe(project.id);
  });
});

describe("the cursor", () => {
  it("starts at zero and moves forward", async () => {
    expect(await db.syncState()).toMatchObject({ cursor: 0, lastSyncedAt: null });

    await db.setSyncCursor(42);
    const state = await db.syncState();
    expect(state.cursor).toBe(42);
    expect(state.lastSyncedAt).not.toBeNull();
  });

  it("records the last failure so it can be shown rather than swallowed", async () => {
    await db.setSyncCursor(7, "Network request failed");
    expect((await db.syncState()).lastError).toBe("Network request failed");

    await db.setSyncCursor(9);
    expect((await db.syncState()).lastError).toBeNull();
  });

  it("re-uploads everything after a reset, without touching a word", async () => {
    const fragment = await db.capture("She never once said my name.");
    await db.createProject("A book", "memoir", 40_000);
    await db.markSynced("fragments", [
      { id: fragment.id as string, rev: 1, localRev: 1 },
    ]);
    await db.setSyncCursor(99);

    await db.resetSync();

    expect(await db.syncState()).toMatchObject({ cursor: 0, lastError: null });
    expect(await db.countDirty()).toEqual({ fragments: 1, projects: 1 });
    expect((await db.dirtyFragments())[0]?.baseRev).toBeNull();
    // The writing itself is untouched.
    expect((await db.getFragment(fragment.id))?.text).toBe("She never once said my name.");
  });
});

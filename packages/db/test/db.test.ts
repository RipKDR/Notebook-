import { beforeEach, describe, expect, it } from "vitest";
import { LoomDatabase, toFtsPhrase } from "../src/repository.js";
import { NodeSqliteAdapter } from "../src/node-adapter.js";
import { SCHEMA_VERSION } from "../src/schema.js";
import { asProjectId, normaliseVector } from "@loom/core";

let adapter: NodeSqliteAdapter;
let db: LoomDatabase;

beforeEach(async () => {
  adapter = NodeSqliteAdapter.open(":memory:");
  db = new LoomDatabase(adapter);
  await db.migrate();
});

describe("migrations", () => {
  it("brings a fresh database to the current version", async () => {
    const row = await adapter.first<{ user_version: number }>("PRAGMA user_version;");
    expect(row?.user_version).toBe(SCHEMA_VERSION);
  });

  it("is idempotent across repeated launches", async () => {
    expect(await db.migrate()).toBe(SCHEMA_VERSION);
    expect(await db.migrate()).toBe(SCHEMA_VERSION);
  });

  it("enforces foreign keys", async () => {
    const row = await adapter.first<{ foreign_keys: number }>("PRAGMA foreign_keys;");
    expect(row?.foreign_keys).toBe(1);
  });
});

describe("capture", () => {
  it("stores a fragment with no project and no metadata", async () => {
    const f = await db.capture("She never once said my name.");
    expect(f.projectId).toBeNull();
    expect(f.enrichment).toBeNull();

    const loaded = await db.getFragment(f.id);
    expect(loaded?.text).toBe("She never once said my name.");
  });

  it("records the capture source", async () => {
    const f = await db.capture("from the widget", "widget");
    expect((await db.getFragment(f.id))?.source).toBe("widget");
  });

  it("lists newest first", async () => {
    await db.capture("first");
    await new Promise((r) => setTimeout(r, 2));
    await db.capture("second");
    const list = await db.listFragments();
    expect(list.map((f) => f.text)).toEqual(["second", "first"]);
  });

  it("queues every capture for sync", async () => {
    await db.capture("a");
    await db.capture("b");
    expect(await db.pendingSync()).toHaveLength(2);
  });
});

describe("editing", () => {
  it("clears enrichment when the text changes, so no stale digest survives", async () => {
    const f = await db.capture("the kitchen radio was always on");
    await db.applyEnrichment(f.id, {
      enrichment: {
        kind: "memory",
        digest: "the kitchen radio",
        entities: [{ entityId: "person:nan" as never, surface: "Nan", kind: "person" }],
        themes: ["family"],
        valence: 0.2,
        standalone: 0.7,
        enricherVersion: "enrich-v1",
        enrichedAt: Date.now(),
      },
    });
    expect((await db.getFragment(f.id))?.enrichment).not.toBeNull();

    await db.updateText(f.id, "the kitchen radio was never on");
    const after = await db.getFragment(f.id);
    expect(after?.enrichment).toBeNull();
    expect(after?.text).toBe("the kitchen radio was never on");

    const orphans = await adapter.all(`SELECT * FROM fragment_entities WHERE fragment_id = ?`, [
      f.id,
    ]);
    expect(orphans).toHaveLength(0);
  });

  it("soft-deletes and restores without losing the text", async () => {
    const f = await db.capture("do not lose this");
    await db.softDelete(f.id);
    expect(await db.listFragments()).toHaveLength(0);
    expect((await db.getFragment(f.id))?.text).toBe("do not lose this");

    await db.restore(f.id);
    expect(await db.listFragments()).toHaveLength(1);
  });
});

describe("enrichment round-trip", () => {
  it("persists entities and restores them", async () => {
    const f = await db.capture("grandmother kept the letters");
    await db.applyEnrichment(f.id, {
      enrichment: {
        kind: "memory",
        digest: "grandmother kept letters",
        entities: [
          { entityId: "person:grandmother" as never, surface: "grandmother", kind: "person" },
          { entityId: "object:letters" as never, surface: "letters", kind: "object" },
        ],
        themes: ["memory", "family"],
        valence: -0.1,
        standalone: 0.8,
        enricherVersion: "enrich-v1",
        enrichedAt: 12345,
      },
    });

    const loaded = await db.getFragment(f.id);
    expect(loaded?.enrichment?.entities.map((e) => e.entityId).sort()).toEqual([
      "object:letters",
      "person:grandmother",
    ]);
    expect(loaded?.enrichment?.themes).toEqual(["memory", "family"]);
    expect(loaded?.enrichment?.valence).toBeCloseTo(-0.1, 5);
  });

  it("round-trips an embedding through the BLOB column without drift", async () => {
    const f = await db.capture("vector me");
    const vector = normaliseVector(Float32Array.from([0.2, -0.7, 0.4, 0.1]));
    await db.applyEnrichment(f.id, { embedding: vector, embeddingModel: "test" });

    const loaded = await db.getFragment(f.id);
    expect(loaded?.embedding).not.toBeNull();
    expect([...loaded!.embedding!]).toEqual([...vector]);
  });

  it("finds fragments still awaiting the indexer", async () => {
    const a = await db.capture("needs work");
    await db.capture("also needs work");
    await db.applyEnrichment(a.id, {
      enrichment: {
        kind: "aphorism",
        digest: "d",
        entities: [],
        themes: [],
        valence: 0,
        standalone: 0.5,
        enricherVersion: "enrich-v1",
        enrichedAt: 1,
      },
      embedding: normaliseVector(Float32Array.from([1, 0])),
    });

    const pending = await db.fragmentsNeedingEnrichment();
    expect(pending.map((f) => f.text)).toEqual(["also needs work"]);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await db.capture("the lighthouse keeper counted the ships each morning");
    await db.capture("she never once said my name");
    await db.capture("don't wait for me, she said");
  });

  it("finds fragments by word", async () => {
    const hits = await db.search("lighthouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("lighthouse");
  });

  it("stems, so a search for a plural finds the singular", async () => {
    expect((await db.search("ship")).length).toBeGreaterThan(0);
  });

  it("survives an apostrophe instead of throwing an FTS5 syntax error", async () => {
    await expect(db.search("don't")).resolves.toBeInstanceOf(Array);
  });

  it("treats FTS5 operators as literal words, not syntax", async () => {
    for (const q of ["AND", "NEAR", "OR NOT", '"', "*", "^x:y", "a OR b"]) {
      await expect(db.search(q)).resolves.toBeInstanceOf(Array);
    }
  });

  it("returns nothing for an empty query rather than everything", async () => {
    expect(await db.search("   ")).toEqual([]);
  });

  it("excludes soft-deleted fragments", async () => {
    const [hit] = await db.search("lighthouse");
    await db.softDelete(hit!.id);
    expect(await db.search("lighthouse")).toHaveLength(0);
  });

  it("keeps the index in step when text is edited", async () => {
    const [hit] = await db.search("lighthouse");
    await db.updateText(hit!.id, "the harbourmaster counted nothing at all");
    expect(await db.search("lighthouse")).toHaveLength(0);
    expect((await db.search("harbourmaster")).length).toBe(1);
  });
});

describe("toFtsPhrase", () => {
  it("quotes each token", () => {
    expect(toFtsPhrase("hello world")).toBe('"hello" "world"');
  });

  it("returns null when nothing searchable remains", () => {
    expect(toFtsPhrase("!!! ???")).toBeNull();
  });

  it("escapes embedded double quotes", () => {
    expect(toFtsPhrase('say "hi"')).toBe('"say" "hi"');
  });

  it("keeps apostrophes inside a token", () => {
    expect(toFtsPhrase("don't")).toBe(`"don't"`);
  });
});

describe("projects and scenes", () => {
  it("creates a project and scopes fragments to it", async () => {
    const project = await db.createProject("The Lighthouse", "fiction", 100_000);
    const f = await db.capture("unfiled note");
    await db.assignFragments([f.id], project.id);

    expect(await db.listFragments({ projectId: project.id })).toHaveLength(1);
    expect(await db.listFragments({ projectId: null })).toHaveLength(0);
  });

  it("upserts scenes so an incremental rebuild replaces in place", async () => {
    const project = await db.createProject("P", "memoir", 40_000);
    const scene = {
      sceneId: "s1" as never,
      chapterId: "c1" as never,
      prose: "First draft.",
      wordCount: 2,
      contentHash: "hash-1",
      passes: ["draft"] as never,
      usedFragments: [] as never,
      model: "claude-sonnet-5",
      costUsd: 0.01,
      draftedAt: 1,
    };
    await db.saveScenes(project.id, [scene]);
    await db.saveScenes(project.id, [{ ...scene, prose: "Revised draft.", contentHash: "hash-2" }]);

    const loaded = await db.loadScenes(project.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.prose).toBe("Revised draft.");
    expect(loaded[0]!.contentHash).toBe("hash-2");
  });

  it("preserves reading order", async () => {
    const project = await db.createProject("P", "fiction", 40_000);
    await db.saveScenes(
      project.id,
      ["a", "b", "c"].map((id) => ({
        sceneId: id as never,
        chapterId: "c1" as never,
        prose: id,
        wordCount: 1,
        contentHash: id,
        passes: [] as never,
        usedFragments: [] as never,
        model: "m",
        costUsd: 0,
        draftedAt: 1,
      })),
    );
    expect((await db.loadScenes(project.id)).map((s) => s.prose)).toEqual(["a", "b", "c"]);
  });

  it("prunes scenes dropped by a shorter recompile", async () => {
    const project = await db.createProject("P", "fiction", 40_000);
    await db.saveScenes(
      project.id,
      ["a", "b", "c"].map((id) => ({
        sceneId: id as never,
        chapterId: "c1" as never,
        prose: id,
        wordCount: 1,
        contentHash: id,
        passes: [] as never,
        usedFragments: [] as never,
        model: "m",
        costUsd: 0,
        draftedAt: 1,
      })),
    );
    expect(await db.pruneScenes(project.id, ["a", "b"])).toBe(1);
    expect((await db.loadScenes(project.id)).map((s) => s.prose)).toEqual(["a", "b"]);
  });

  it("round-trips compile state through JSON", async () => {
    const project = await db.createProject("P", "memoir", 40_000);
    await db.saveCompileState(project.id, {
      bible: { title: "X", version: 3 },
      outline: { chapters: [] },
      ledger: { deltas: [] },
      compiledAt: 999,
    });
    const loaded = await db.loadCompileState(project.id);
    expect(loaded?.compiledAt).toBe(999);
    expect((loaded?.bible as { version: number }).version).toBe(3);
  });

  it("returns null compile state for an uncompiled project", async () => {
    const project = await db.createProject("P", "fiction", 40_000);
    expect(await db.loadCompileState(project.id)).toBeNull();
  });

  it("cascades scene deletion when a project is removed", async () => {
    const project = await db.createProject("P", "fiction", 40_000);
    await db.saveScenes(project.id, [
      {
        sceneId: "s1" as never,
        chapterId: "c1" as never,
        prose: "x",
        wordCount: 1,
        contentHash: "h",
        passes: [] as never,
        usedFragments: [] as never,
        model: "m",
        costUsd: 0,
        draftedAt: 1,
      },
    ]);
    await adapter.run(`DELETE FROM projects WHERE id = ?`, [project.id]);
    expect(await db.loadScenes(project.id)).toHaveLength(0);
  });

  it("orphans fragments rather than deleting them when a project goes away", async () => {
    const project = await db.createProject("P", "fiction", 40_000);
    const f = await db.capture("the user's actual writing");
    await db.assignFragments([f.id], project.id);
    await adapter.run(`DELETE FROM projects WHERE id = ?`, [project.id]);

    const survivor = await db.getFragment(f.id);
    expect(survivor?.text).toBe("the user's actual writing");
    expect(survivor?.projectId).toBeNull();
  });
});

describe("transactions", () => {
  it("rolls back a failed multi-step write", async () => {
    const before = (await db.countFragments()).total;
    await expect(
      adapter.transaction(async () => {
        await adapter.run(
          `INSERT INTO fragments (id, text, created_at, updated_at, source) VALUES (?,?,?,?,?)`,
          ["x", "partial", 1, 1, "quick"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.countFragments()).total).toBe(before);
  });

  it("supports nesting via savepoints, which repository methods rely on", async () => {
    const result = await adapter.transaction(async () => {
      await adapter.run(
        `INSERT INTO fragments (id, text, created_at, updated_at, source) VALUES (?,?,?,?,?)`,
        ["outer", "outer", 1, 1, "quick"],
      );
      return adapter.transaction(async () => {
        await adapter.run(
          `INSERT INTO fragments (id, text, created_at, updated_at, source) VALUES (?,?,?,?,?)`,
          ["inner", "inner", 1, 1, "quick"],
        );
        return "done";
      });
    });
    expect(result).toBe("done");
    expect((await db.countFragments()).total).toBe(2);
  });

  it("rolls back only the inner savepoint when it fails", async () => {
    await adapter.transaction(async () => {
      await adapter.run(
        `INSERT INTO fragments (id, text, created_at, updated_at, source) VALUES (?,?,?,?,?)`,
        ["kept", "kept", 1, 1, "quick"],
      );
      await adapter
        .transaction(async () => {
          await adapter.run(
            `INSERT INTO fragments (id, text, created_at, updated_at, source) VALUES (?,?,?,?,?)`,
            ["dropped", "dropped", 1, 1, "quick"],
          );
          throw new Error("inner");
        })
        .catch(() => undefined);
    });

    const texts = (await db.listFragments()).map((f) => f.text);
    expect(texts).toContain("kept");
    expect(texts).not.toContain("dropped");
  });
});

describe("counts", () => {
  it("reports totals and enrichment progress", async () => {
    await db.capture("one two three");
    const b = await db.capture("four five");
    await db.applyEnrichment(b.id, {
      enrichment: {
        kind: "aphorism",
        digest: "d",
        entities: [],
        themes: [],
        valence: 0,
        standalone: 0.5,
        enricherVersion: "enrich-v1",
        enrichedAt: 1,
      },
    });
    const counts = await db.countFragments();
    expect(counts.total).toBe(2);
    expect(counts.enriched).toBe(1);
    expect(counts.words).toBe(5);
  });
});

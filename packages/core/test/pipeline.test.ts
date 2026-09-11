import { describe, expect, it } from "vitest";
import { clusterFragments } from "../src/retrieval/cluster.js";
import { LocalTrigramEmbeddings } from "../src/retrieval/embed.js";
import { cosine, dot, normalise, topK, encodeVector, decodeVector } from "../src/retrieval/vector.js";
import { sliceForScene, currentState, appendDeltas } from "../src/types/ledger.js";
import { firstWords, lastWords, replaceOpening } from "../src/pipeline/revise.js";
import { detectUsedFragments, stripPreamble } from "../src/pipeline/draft.js";
import { verifyExemplars, selectVoiceSamples } from "../src/pipeline/bible.js";
import { canonicalKey } from "../src/pipeline/enrich.js";
import { CostBudget, costUsd, BudgetExceededError } from "../src/llm/models.js";
import type { Fragment } from "../src/types/fragment.js";
import type { StateDelta } from "../src/types/ledger.js";
import { asEntityId, asFragmentId, asSceneId, newId } from "../src/types/ids.js";

function frag(id: string, text: string, opts: Partial<Fragment> = {}): Fragment {
  return {
    id: asFragmentId(id),
    projectId: null,
    text,
    createdAt: 1,
    updatedAt: 1,
    source: "quick",
    deletedAt: null,
    pinned: false,
    enrichment: null,
    embedding: null,
    ...opts,
  };
}

describe("vector maths", () => {
  it("normalises to unit length", () => {
    const v = normalise(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0]!, v[1]!)).toBeCloseTo(1, 6);
  });

  it("leaves a zero vector alone rather than producing NaN", () => {
    const v = normalise(Float32Array.from([0, 0]));
    expect([...v]).toEqual([0, 0]);
  });

  it("scores identical vectors at 1 and orthogonal at 0", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6);
  });

  it("refuses mismatched dimensions instead of silently truncating", () => {
    expect(() => dot(Float32Array.from([1]), Float32Array.from([1, 2]))).toThrow(RangeError);
  });

  it("round-trips through the SQLite blob encoding", () => {
    const original = normalise(Float32Array.from([0.1, -0.5, 0.9, 0.2]));
    const restored = decodeVector(encodeVector(original));
    expect([...restored]).toEqual([...original]);
  });

  it("survives a misaligned buffer, which SQLite can hand back", () => {
    const src = encodeVector(normalise(Float32Array.from([1, 2, 3, 4])));
    const padded = new Uint8Array(src.length + 1);
    padded.set(src, 1);
    expect(() => decodeVector(padded.subarray(1))).not.toThrow();
  });

  it("returns the k nearest in descending order", () => {
    const query = normalise(Float32Array.from([1, 0]));
    const items = [
      { id: "far", v: normalise(Float32Array.from([0, 1])) },
      { id: "near", v: normalise(Float32Array.from([1, 0.1])) },
      { id: "mid", v: normalise(Float32Array.from([1, 1])) },
    ];
    const got = topK(query, items, (x) => x.v, 2);
    expect(got.map((g) => g.item.id)).toEqual(["near", "mid"]);
    expect(got[0]!.score).toBeGreaterThan(got[1]!.score);
  });
});

describe("LocalTrigramEmbeddings", () => {
  it("scores related text above unrelated text", async () => {
    const e = new LocalTrigramEmbeddings(256);
    const [a, b, c] = await e.embed([
      "my grandmother kept every letter she ever received",
      "my grandmother kept the letters in a biscuit tin",
      "the quarterly revenue projections exceeded forecast",
    ]);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });

  it("is deterministic", async () => {
    const e = new LocalTrigramEmbeddings(128);
    const [a] = await e.embed(["same input"]);
    const [b] = await e.embed(["same input"]);
    expect([...a!]).toEqual([...b!]);
  });

  it("returns a zero vector for empty text instead of throwing", async () => {
    const e = new LocalTrigramEmbeddings(64);
    const [v] = await e.embed(["   "]);
    expect([...v!].every((x) => x === 0)).toBe(true);
  });
});

describe("clusterFragments", () => {
  it("separates two distinct topics", async () => {
    const embedder = new LocalTrigramEmbeddings(256);
    const texts = [
      "my grandmother kept every letter she ever received",
      "grandmother's letters were tied with string in the drawer",
      "the letters from grandmother smelled of lavender and dust",
      "the spacecraft entered orbit around the gas giant",
      "orbital mechanics around the gas giant were unforgiving",
      "the spacecraft's orbit decayed faster than the crew expected",
    ];
    const vectors = await embedder.embed(texts);
    const fragments = texts.map((t, i) =>
      frag(`f${i}`, t, { embedding: vectors[i]!, updatedAt: i }),
    );

    const { constellations } = clusterFragments(fragments, { mergeThreshold: 0.25, minSize: 2 });
    expect(constellations.length).toBeGreaterThanOrEqual(2);

    // Members of a cluster should come from the same half of the corpus.
    for (const c of constellations) {
      const indices = c.fragmentIds.map((id) => Number(String(id).slice(1)));
      const half = indices.map((i) => i < 3);
      expect(new Set(half).size).toBe(1);
    }
  });

  it("uses shared entities to group text that does not embed together", () => {
    const withEntity = (id: string, text: string, entity: string): Fragment =>
      frag(id, text, {
        embedding: normalise(Float32Array.from([Math.random(), Math.random(), Math.random()])),
        enrichment: {
          kind: "memory",
          digest: text.slice(0, 40),
          entities: [{ entityId: asEntityId(entity), surface: entity, kind: "person" }],
          themes: ["family"],
          valence: 0,
          standalone: 0.5,
          enricherVersion: "test",
          enrichedAt: 1,
        },
      });

    const fragments = [
      withEntity("a", "the kitchen radio was always on", "person:nan"),
      withEntity("b", "she drove a green estate car", "person:nan"),
      withEntity("c", "hospital corridors smell the same everywhere", "person:nan"),
    ];
    const { constellations } = clusterFragments(fragments, { minSize: 2, entityWeight: 0.6 });
    expect(constellations).toHaveLength(1);
    expect(constellations[0]!.fragmentIds).toHaveLength(3);
    expect(constellations[0]!.dominantEntities).toContain("person:nan");
  });

  it("never discards a fragment — everything is clustered or loose", async () => {
    const embedder = new LocalTrigramEmbeddings(128);
    const texts = Array.from({ length: 12 }, (_, i) => `fragment number ${i} about topic ${i % 3}`);
    const vectors = await embedder.embed(texts);
    const fragments = texts.map((t, i) => frag(`f${i}`, t, { embedding: vectors[i]! }));

    const { constellations, loose } = clusterFragments(fragments, { minSize: 2 });
    const accounted = new Set([...constellations.flatMap((c) => [...c.fragmentIds]), ...loose]);
    expect(accounted.size).toBe(fragments.length);
  });

  it("handles an empty corpus", () => {
    expect(clusterFragments([])).toEqual({ constellations: [], loose: [] });
  });

  it("ignores deleted fragments", () => {
    const fragments = [frag("a", "kept"), { ...frag("b", "gone"), deletedAt: 5 }];
    const { constellations, loose } = clusterFragments(fragments, { minSize: 1 });
    const all = [...constellations.flatMap((c) => [...c.fragmentIds]), ...loose];
    expect(all).not.toContain("b");
  });
});

describe("continuity ledger", () => {
  const delta = (
    order: number,
    subjects: string[],
    statement: string,
    kind: StateDelta["kind"] = "knowledge",
  ): StateDelta => ({
    kind,
    subjects: subjects.map(asEntityId),
    statement,
    sceneId: asSceneId(`s${order}`),
    order,
  });

  const ledger = {
    deltas: [
      delta(0, ["person:mara"], "Mara does not know about the letter"),
      delta(1, ["person:mara"], "Mara has read the letter"),
      delta(2, ["person:tom"], "Tom left for Leeds"),
      delta(3, [], "The mill closed in 1987", "world"),
    ],
  };

  it("only returns facts established before the scene", () => {
    const got = sliceForScene(ledger, [asEntityId("person:mara")], 1);
    expect(got.map((d) => d.statement)).toEqual(["Mara does not know about the letter"]);
  });

  it("filters to the scene's own cast", () => {
    const got = sliceForScene(ledger, [asEntityId("person:tom")], 10);
    expect(got.some((d) => d.statement.includes("Mara"))).toBe(false);
    expect(got.some((d) => d.statement.includes("Tom"))).toBe(true);
  });

  it("always includes world facts, which constrain everyone", () => {
    const got = sliceForScene(ledger, [asEntityId("person:mara")], 10);
    expect(got.some((d) => d.kind === "world")).toBe(true);
  });

  it("returns the latest state per subject and kind", () => {
    const got = currentState(ledger);
    const mara = got.filter((d) => d.subjects.includes(asEntityId("person:mara")));
    expect(mara).toHaveLength(1);
    expect(mara[0]!.statement).toBe("Mara has read the letter");
  });

  it("appends without mutating the original", () => {
    const next = appendDeltas(ledger, [delta(4, ["person:mara"], "Mara burned it")]);
    expect(ledger.deltas).toHaveLength(4);
    expect(next.deltas).toHaveLength(5);
  });
});

describe("prose excerpting", () => {
  const prose = "First paragraph here.\n\nSecond paragraph is longer than the first one.\n\nThird.";

  it("cuts firstWords on a paragraph boundary", () => {
    expect(firstWords(prose, 2)).toBe("First paragraph here.");
  });

  it("cuts lastWords on a paragraph boundary", () => {
    expect(lastWords(prose, 1)).toBe("Third.");
  });

  it("preserves paragraph breaks in the remainder when replacing the opening", () => {
    const out = replaceOpening(prose, "A new opening.", 2);
    expect(out).toBe("A new opening.\n\nSecond paragraph is longer than the first one.\n\nThird.");
    expect(out.split("\n\n")).toHaveLength(3);
  });

  it("does not collapse a multi-paragraph scene into one block", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} with several words in it.`).join(
      "\n\n",
    );
    const out = replaceOpening(long, "New start.", 8);
    expect(out.split("\n\n").length).toBeGreaterThan(1);
  });

  it("returns the replacement when it would consume the whole scene", () => {
    expect(replaceOpening("Only this.", "Replaced.", 100)).toBe("Replaced.");
  });

  it("leaves prose untouched when the replacement is empty", () => {
    expect(replaceOpening(prose, "   ", 2)).toBe(prose.trim());
  });
});

describe("stripPreamble", () => {
  it("removes a conversational lead-in", () => {
    expect(stripPreamble("Here is the scene:\n\nShe opened the door.")).toBe("She opened the door.");
  });

  it("removes a markdown heading", () => {
    expect(stripPreamble("## Chapter One\n\nShe opened the door.")).toBe("She opened the door.");
  });

  it("removes wrapping horizontal rules", () => {
    expect(stripPreamble("---\n\nShe opened the door.\n\n---")).toBe("She opened the door.");
  });

  it("leaves clean prose alone", () => {
    expect(stripPreamble("She opened the door.")).toBe("She opened the door.");
  });

  it("does not eat prose that merely starts with a capital H", () => {
    expect(stripPreamble("Here she stopped.")).toBe("Here she stopped.");
  });
});

describe("detectUsedFragments", () => {
  it("detects a fragment carried through close to verbatim", () => {
    const f = frag("f1", "She never once said my name.");
    const prose = "He waited by the window. She never once said my name, not in all those years.";
    expect(detectUsedFragments(prose, [f])).toEqual(["f1"]);
  });

  it("does not claim a fragment that was left out", () => {
    const f = frag("f1", "The lighthouse keeper counted the ships each morning.");
    expect(detectUsedFragments("An unrelated paragraph entirely.", [f])).toEqual([]);
  });

  it("matches across punctuation and curly quotes", () => {
    const f = frag("f1", "she said, “don't wait for me”");
    const prose = "Then she said don't wait for me and closed the door.";
    expect(detectUsedFragments(prose, [f])).toEqual(["f1"]);
  });

  it("handles a very short fragment via token overlap", () => {
    const f = frag("f1", "lavender dust");
    expect(detectUsedFragments("The room smelled of lavender and dust.", [f])).toEqual(["f1"]);
  });
});

describe("voice exemplars", () => {
  const corpus = [
    frag("a", "She never once said my name."),
    frag("b", "The kitchen radio was always on, even when nobody was listening to it."),
    frag("c", "I have no memory of the drive home, only of arriving."),
  ];

  it("keeps exemplars that genuinely appear in the corpus", () => {
    const got = verifyExemplars(
      ["She never once said my name.", "I have no memory of the drive home, only of arriving."],
      corpus,
    );
    expect(got).toContain("She never once said my name.");
  });

  it("drops a paraphrase and substitutes real sentences", () => {
    const got = verifyExemplars(["She rarely used my name at all."], corpus);
    expect(got).not.toContain("She rarely used my name at all.");
    expect(got.length).toBeGreaterThanOrEqual(3);
  });

  it("tolerates curly-quote and dash normalisation", () => {
    const withQuotes = [frag("d", "He said “no” — and meant it.")];
    expect(verifyExemplars(['He said "no" - and meant it.'], withQuotes)).toContain(
      'He said "no" - and meant it.',
    );
  });

  it("prefers mid-length fragments as voice samples", () => {
    const mixed = [
      frag("tiny", "Yes."),
      frag("good", Array.from({ length: 45 }, () => "word").join(" ")),
      frag("huge", Array.from({ length: 600 }, () => "word").join(" ")),
    ];
    expect(selectVoiceSamples(mixed, 1)[0]!.id).toBe("good");
  });
});

describe("canonicalKey", () => {
  it("collapses casing and punctuation to one id", () => {
    expect(canonicalKey("Grandma Rose", "person")).toBe(canonicalKey("grandma  rose!", "person"));
  });

  it("strips accents so spelling variants unify", () => {
    expect(canonicalKey("Renée", "person")).toBe("person:renee");
  });

  it("separates entities of different kinds", () => {
    expect(canonicalKey("Bath", "place")).not.toBe(canonicalKey("Bath", "object"));
  });

  it("never produces an empty slug", () => {
    expect(canonicalKey("!!!", "person")).toBe("person:unnamed");
  });
});

describe("cost accounting", () => {
  it("prices output tokens at the published rate", () => {
    const cost = costUsd("claude-sonnet-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(10, 6);
  });

  it("halves the bill for batched requests", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(costUsd("claude-sonnet-5", usage, { batch: true })).toBeCloseTo(
      costUsd("claude-sonnet-5", usage) / 2,
      6,
    );
  });

  it("charges cache reads at a tenth of base input", () => {
    const read = costUsd("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(read).toBeCloseTo(0.5, 6);
  });

  it("charges a 1h cache write more than a 5m one", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    };
    expect(costUsd("claude-opus-5", usage, { cacheTtl: "1h" })).toBeGreaterThan(
      costUsd("claude-opus-5", usage, { cacheTtl: "5m" }),
    );
  });

  it("tracks spend per stage", () => {
    const budget = new CostBudget(10);
    budget.record("draft", 3);
    budget.record("draft", 1);
    budget.record("revise", 2);
    expect(budget.breakdown()).toEqual({ draft: 4, revise: 2 });
    expect(budget.spentUsd).toBe(6);
    expect(budget.remainingUsd).toBe(4);
  });

  it("signals exhaustion rather than silently overspending", () => {
    const budget = new CostBudget(5);
    expect(budget.record("draft", 4)).toBe(true);
    expect(budget.record("draft", 2)).toBe(false);
  });

  it("throws before an unaffordable call, not after", () => {
    const budget = new CostBudget(5);
    budget.record("draft", 4);
    expect(() => budget.assertCanSpend("revise", 2)).toThrow(BudgetExceededError);
    expect(budget.spentUsd).toBe(4);
  });

  it("rejects a nonsensical budget", () => {
    expect(() => new CostBudget(0)).toThrow(RangeError);
  });
});

describe("newId", () => {
  it("sorts lexicographically by creation time", () => {
    const early = newId(1_000_000, () => 0.5);
    const late = newId(2_000_000, () => 0.5);
    expect(early < late).toBe(true);
  });

  it("produces distinct ids within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId(1_000_000)));
    expect(ids.size).toBe(500);
  });

  it("is 26 characters of Crockford base32", () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

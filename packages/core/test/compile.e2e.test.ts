import { describe, expect, it } from "vitest";
import {
  LocalTrigramEmbeddings,
  asFragmentId,
  asProjectId,
  compile,
  newId,
  toMarkdown,
  type CompileProgress,
  type CompileState,
  type Fragment,
  type Project,
} from "../src/index.js";
import { FakeBatch, FakeLlm } from "./fake-model.js";

/**
 * The end-to-end wiring test.
 *
 * Every stage was unit-tested in isolation long before `compile()` ever ran a
 * single line. This is the test that actually exercises the eight stages in
 * sequence: enrich, cluster, bible, outline, draft, ledger, revise, assemble —
 * plus the incremental rebuild path, which is the product's central claim and
 * therefore the thing most worth proving.
 */

const SOURCE_LINES = [
  "She never once said my name.",
  "The kitchen radio was always on, even when nobody was listening to it.",
  "I have no memory of the drive home, only of arriving.",
  "Every drawer in that house had string in it.",
  "She kept the good scissors in a place nobody was told about.",
  "The biscuit tins never had biscuits in them.",
  "There was a photograph on the stairs I was not allowed to ask about.",
  "My mother stopped speaking when we passed the hospital.",
  "He sent letters for eleven years and she answered none of them.",
  "The house smelled of lavender and gas.",
  "I found a second address in her handwriting, folded very small.",
  "Nobody explained the man in the garden photograph.",
  "She counted the stairs out loud, every time, until the last year.",
  "The radio was tuned to a station that had stopped broadcasting.",
  "I was thirty before I understood the silence was a decision.",
  "Her funeral was attended by four people I had never met.",
  "She wrote the year on everything, but never the reason.",
  "The garden went first, then the language, then the rest of it.",
  "I keep the scissors in the same drawer she did.",
  "There is a version of her I invented to be able to grieve.",
  "The hospital corridor smelled of the inside of a tin.",
  "She said the word home about a place I had never seen.",
  "I do not remember whether she was crying.",
  "The letters were tied with the same string from the drawer.",
];

function makeFragments(count: number = SOURCE_LINES.length): Fragment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: asFragmentId(newId(1_700_000_000_000 + i * 1000, () => (i % 7) / 7)),
    projectId: null,
    text: SOURCE_LINES[i % SOURCE_LINES.length]!,
    createdAt: 1_700_000_000_000 + i * 1000,
    updatedAt: 1_700_000_000_000 + i * 1000,
    source: "quick" as const,
    deletedAt: null,
    pinned: false,
    enrichment: null,
    embedding: null,
  }));
}

const project: Project = {
  id: asProjectId("proj-1"),
  title: "The Kitchen Radio",
  form: "memoir",
  targetWords: 12_000,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};

async function runCompile(
  overrides: {
    fragments?: Fragment[];
    previous?: CompileState;
    skipRevision?: boolean;
    budgetUsd?: number;
    progress?: CompileProgress[];
  } = {},
) {
  const llm = new FakeLlm();
  const batch = new FakeBatch();
  const progress = overrides.progress ?? [];

  const result = await compile({
    project,
    fragments: overrides.fragments ?? makeFragments(),
    embeddings: new LocalTrigramEmbeddings(128),
    budgetUsd: overrides.budgetUsd ?? 20,
    llm,
    batch,
    ...(overrides.previous ? { previous: overrides.previous } : {}),
    ...(overrides.skipRevision !== undefined ? { skipRevision: overrides.skipRevision } : {}),
    onProgress: (p) => progress.push(p),
  });

  return { result, llm, batch, progress };
}

describe("compile — end to end", () => {
  it("runs every stage and produces a manuscript", async () => {
    const { result, llm, batch } = await runCompile();

    expect(result.manuscript.scenes.length).toBeGreaterThan(0);
    expect(result.words).toBeGreaterThan(0);

    // All eight stages were actually reached.
    const stages = new Set(llm.calls.map((c) => c.stage));
    expect(stages).toContain("enrich");
    expect(stages).toContain("bible");
    expect(stages).toContain("outline:plan");
    expect(stages).toContain("outline:expand");
    expect(stages).toContain("ledger");
    expect(stages).toContain("revise:audit");
    expect(stages).toContain("revise:payoff");

    expect(batch.stages).toContain("draft");
    expect(batch.stages).toContain("revise:transitions");
    expect(batch.stages).toContain("revise:voice");
  }, 30_000);

  it("produces a Bible and outline that survive into the returned state", async () => {
    const { result } = await runCompile();
    expect(result.state.bible?.title).toBe("The Kitchen Radio");
    expect(result.state.bible?.version).toBe(1);
    expect(result.state.outline?.chapters.length).toBeGreaterThan(0);
    expect(result.state.ledger?.deltas.length).toBeGreaterThan(0);
  }, 30_000);

  it("verifies voice exemplars against the corpus rather than trusting the model", async () => {
    const { result } = await runCompile();
    const exemplars = result.state.bible?.voice.exemplars ?? [];
    expect(exemplars.length).toBeGreaterThanOrEqual(2);
    // Every exemplar the fake offered is genuinely present in the source lines.
    for (const e of exemplars) {
      expect(SOURCE_LINES.some((line) => line.includes(e) || e.includes(line))).toBe(true);
    }
  }, 30_000);

  it("uses the author's fragments and reports honest coverage", async () => {
    const { result } = await runCompile();
    // The outline is a consumption plan: with a planner that allocates
    // everything, coverage must be total.
    expect(result.coverage).toBe(1);
    expect(result.unusedFragments).toHaveLength(0);
  }, 30_000);

  it("keeps the drafting system prompt byte-identical across every scene", async () => {
    // This is the caching contract. One distinct system prompt means one cache
    // write and N cheap reads; two means the bill silently doubles.
    const { batch } = await runCompile();
    expect(batch.systemsByStage.get("draft")?.size).toBe(1);
  }, 30_000);

  it("reports monotonic progress that ends at 1", async () => {
    const { progress } = await runCompile();
    expect(progress.length).toBeGreaterThan(3);

    const fractions = progress.map((p) => p.fraction);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    expect(progress.at(-1)?.status).toBe("complete");
    expect(progress.at(-1)?.fraction).toBe(1);
  }, 30_000);

  it("applies the revision passes it was asked for", async () => {
    const { result, batch } = await runCompile();
    const passes = new Set(result.manuscript.scenes.flatMap((s) => s.passes));
    expect(passes).toContain("draft");
    expect(passes).toContain("voice");
    expect(batch.stages).toContain("revise:fix");
    expect(result.continuityIssues.length).toBeGreaterThan(0);
    expect(result.continuityAssessment).toBeTruthy();
  }, 30_000);

  it("skips revision when the tier does not include it", async () => {
    const { result, batch } = await runCompile({ skipRevision: true });
    expect(batch.stages).not.toContain("revise:voice");
    expect(batch.stages).not.toContain("revise:transitions");
    expect(result.continuityIssues).toHaveLength(0);
    expect(result.payoffs).toBeNull();
    // Scenes still exist — skipping revision produces a rougher book, not no book.
    expect(result.manuscript.scenes.length).toBeGreaterThan(0);
  }, 30_000);

  it("exports to markdown with chapter structure intact", async () => {
    const { result } = await runCompile();
    const markdown = toMarkdown({
      bible: result.state.bible!,
      outline: result.state.outline!,
      manuscript: result.manuscript,
    });
    expect(markdown).toContain("# The Kitchen Radio");
    expect(markdown).toContain("## 1. Chapter 1");
    expect(markdown.length).toBeGreaterThan(500);
  }, 30_000);
});

describe("incremental recompile", () => {
  it("reuses every scene when nothing has changed", async () => {
    const fragments = makeFragments();
    const first = await runCompile({ fragments });

    const second = await runCompile({ fragments, previous: first.result.state });

    expect(second.result.rebuiltScenes).toBe(0);
    expect(second.result.reusedScenes).toBe(second.result.manuscript.scenes.length);
    // No scene drafting batch at all — the expensive stage was skipped entirely.
    expect(second.batch.requestCounts.get("draft") ?? 0).toBe(0);
  }, 60_000);

  it("rebuilds only the scenes a new note actually touches", async () => {
    const fragments = makeFragments();
    const first = await runCompile({ fragments });
    const total = first.result.manuscript.scenes.length;

    const withNewNote: Fragment[] = [
      ...fragments,
      {
        ...fragments[0]!,
        id: asFragmentId(newId(1_800_000_000_000, () => 0.5)),
        text: "I found the second address again, in a different hand entirely.",
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000,
      },
    ];

    const second = await runCompile({
      fragments: withNewNote,
      previous: first.result.state,
    });

    // The whole point of content addressing: a new note is cheaper than a book.
    expect(second.result.rebuiltScenes).toBeGreaterThan(0);
    expect(second.result.rebuiltScenes).toBeLessThan(total);
    expect(second.result.reusedScenes).toBeGreaterThan(0);
  }, 60_000);

  it("actually gets a newly captured note into the book", async () => {
    // The regression this guards: the outline was reused whenever the Bible
    // version matched, so notes written after the first compile were never
    // allocated to any scene. Rebuilt-scene counts looked fine and the new
    // writing silently went nowhere.
    const fragments = makeFragments();
    const first = await runCompile({ fragments });

    const newNote: Fragment = {
      ...fragments[0]!,
      id: asFragmentId(newId(1_800_000_000_000, () => 0.5)),
      text: "I found the second address again, in a different hand entirely.",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    };

    const second = await runCompile({
      fragments: [...fragments, newNote],
      previous: first.result.state,
    });

    const assigned = new Set(
      (second.result.state.outline?.chapters ?? []).flatMap((c) =>
        c.scenes.flatMap((sc) => sc.fragmentIds as string[]),
      ),
    );
    expect(assigned.has(newNote.id as string)).toBe(true);
    expect(second.result.coverage).toBe(1);
  }, 60_000);

  it("does not replan merely because the planner set a fragment aside", async () => {
    // A fragment already considered and deliberately skipped is not new
    // material; replanning for it would rebuild the outline on every compile.
    const { outlineIsStale } = await import("../src/pipeline/compile.js");
    const fragments = makeFragments(3);
    const outline = {
      bibleVersion: 1,
      chapters: [
        {
          id: "c1",
          index: 0,
          title: "t",
          summary: "s",
          part: "p",
          scenes: [
            {
              id: "s1",
              chapterId: "c1",
              index: 0,
              goal: "g",
              pov: null,
              setting: "x",
              present: [],
              enteringState: "a",
              exitingState: "b",
              fragmentIds: [fragments[0]!.id, fragments[1]!.id],
              targetWords: 1000,
              valence: 0,
              motifs: [],
            },
          ],
        },
      ],
      unusedFragments: [{ fragmentId: fragments[2]!.id, reason: "Does not fit." }],
    } as never;

    expect(outlineIsStale(outline, 1, fragments)).toBe(false);
    expect(outlineIsStale(outline, 2, fragments)).toBe(true);
    expect(outlineIsStale(outline, 1, makeFragments(4))).toBe(true);
  }, 30_000);

  it("rebuilds everything when asked for a full recompile", async () => {
    const fragments = makeFragments();
    const first = await runCompile({ fragments });

    const llm = new FakeLlm();
    const batch = new FakeBatch();
    const result = await compile({
      project,
      fragments,
      embeddings: new LocalTrigramEmbeddings(128),
      budgetUsd: 20,
      llm,
      batch,
      previous: first.result.state,
      full: true,
    });

    expect(result.reusedScenes).toBe(0);
    expect(result.rebuiltScenes).toBe(result.manuscript.scenes.length);
  }, 60_000);

  it("reuses the Bible when the corpus has barely moved", async () => {
    const fragments = makeFragments();
    const first = await runCompile({ fragments });

    const second = await runCompile({ fragments, previous: first.result.state });
    // Bumping the Bible version would dirty every scene in the book, so it must
    // only happen when the corpus has genuinely shifted.
    expect(second.result.state.bible?.version).toBe(first.result.state.bible?.version);
  }, 60_000);
});

describe("failure modes", () => {
  it("refuses to compile an empty notebook", async () => {
    await expect(runCompile({ fragments: [] })).rejects.toThrow(/zero fragments/i);
  }, 30_000);

  it("aborts cleanly when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      compile({
        project,
        fragments: makeFragments(),
        embeddings: new LocalTrigramEmbeddings(128),
        budgetUsd: 20,
        llm: new FakeLlm(),
        batch: new FakeBatch(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

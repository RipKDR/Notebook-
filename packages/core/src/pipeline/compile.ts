import { BatchRunner } from "../llm/batch.js";
import { Llm, type UsageEvent } from "../llm/client.js";
import type { BatchLike, LlmLike } from "../llm/interfaces.js";
import { CostBudget } from "../llm/models.js";
import { dirtyScenes, sceneKey, tailOf } from "../cache/content-address.js";
import type { EmbeddingProvider } from "../retrieval/embed.js";
import type { Bible } from "../types/bible.js";
import type { Fragment } from "../types/fragment.js";
import type { ContinuityLedger } from "../types/ledger.js";
import { asCompileId, newId, type FragmentId, type ProjectId, type SceneId } from "../types/ids.js";
import type { DraftedScene, Manuscript } from "../types/manuscript.js";
import { manuscriptCost, manuscriptWords } from "../types/manuscript.js";
import { allScenes, assignedFragments, type Outline } from "../types/outline.js";
import type { CompileStatus, Project } from "../types/project.js";
import { buildBible } from "./bible.js";
import { collectTails, draftScenes, type DraftContext } from "./draft.js";
import { enrichFragments } from "./enrich.js";
import { buildLedger } from "./ledger.js";
import { buildOutline, coverage } from "./outline.js";
import {
  applyContinuityFixes,
  auditContinuity,
  auditPayoffs,
  smoothTransitions,
  unifyVoice,
  type ContinuityIssue,
  type PayoffReport,
  type ReviseContext,
} from "./revise.js";

/**
 * The compiler.
 *
 * `compile()` is `make` for prose. Given the notebook and whatever survived the
 * last build, it produces a manuscript, rebuilding only what actually changed.
 *
 * The incremental path is the feature, not an optimisation. "Your notes become a
 * book as you go along" is only true if adding a note in month seven costs three
 * scenes rather than a full $7.50 rebuild of a hundred thousand words. Scenes are
 * content-addressed on everything their drafting call sees, so an unchanged scene
 * is free and a changed one is cheap.
 */

export interface CompileState {
  readonly bible: Bible | null;
  readonly outline: Outline | null;
  readonly manuscript: Manuscript | null;
  readonly ledger: ContinuityLedger | null;
  readonly compiledAt: number;
}

export const emptyCompileState: CompileState = {
  bible: null,
  outline: null,
  manuscript: null,
  ledger: null,
  compiledAt: 0,
};

export interface CompileProgress {
  readonly status: CompileStatus;
  /** 0..1 across the whole compile. */
  readonly fraction: number;
  readonly detail: string;
  readonly spentUsd: number;
}

export interface CompileOptions {
  readonly project: Project;
  readonly fragments: readonly Fragment[];
  readonly previous?: CompileState;
  readonly apiKey?: string;
  readonly embeddings: EmbeddingProvider;
  /** Hard ceiling. The compile aborts rather than exceeding it. */
  readonly budgetUsd: number;
  /**
   * Force a full rebuild, ignoring the previous state. Used when the author
   * changes the form, the target length, or asks for a fresh take.
   */
  readonly full?: boolean;
  /** Skip the revision passes. Halves cost and time; used for the first look. */
  readonly skipRevision?: boolean;
  readonly onProgress?: (p: CompileProgress) => void;
  readonly onUsage?: (e: UsageEvent) => void;
  readonly signal?: AbortSignal;
  /**
   * Model clients, injectable for testing. Production callers omit these and get
   * real ones built from `apiKey`.
   */
  readonly llm?: LlmLike;
  readonly batch?: BatchLike;
}

export interface CompileResult {
  readonly compileId: string;
  readonly state: CompileState;
  readonly manuscript: Manuscript;
  /** Share of the author's fragments that made it into the book. */
  readonly coverage: number;
  readonly reusedScenes: number;
  readonly rebuiltScenes: number;
  readonly continuityIssues: readonly ContinuityIssue[];
  readonly continuityAssessment: string;
  readonly payoffs: PayoffReport | null;
  readonly unusedFragments: readonly { fragmentId: FragmentId; reason: string }[];
  readonly costUsd: number;
  readonly costBreakdown: Record<string, number>;
  readonly words: number;
}

/** Rough share of total work per stage, for a progress bar that does not lie. */
const WEIGHTS = {
  enrich: 0.05,
  bible: 0.08,
  outline: 0.12,
  draft: 0.45,
  ledger: 0.1,
  revise: 0.2,
} as const;

export async function compile(opts: CompileOptions): Promise<CompileResult> {
  const budget = new CostBudget(opts.budgetUsd);
  const llm: LlmLike =
    opts.llm ??
    new Llm({
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      budget,
      ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
    });
  const batch: BatchLike = opts.batch ?? new BatchRunner(opts.apiKey);
  const previous = opts.full === true ? emptyCompileState : (opts.previous ?? emptyCompileState);

  let progressBase = 0;
  const report = (status: CompileStatus, within: number, detail: string): void => {
    opts.onProgress?.({
      status,
      fraction: Math.min(1, progressBase + within),
      detail,
      spentUsd: budget.spentUsd,
    });
  };
  const finishStage = (weight: number): void => {
    progressBase += weight;
  };
  const abortIfCancelled = (): void => {
    if (opts.signal?.aborted === true) throw new CompileCancelledError(budget.spentUsd);
  };

  // ---- Stage 1: enrichment (usually a no-op — it runs in the background) ----
  report("enriching", 0, "Reading your notes");
  const patches = await enrichFragments(opts.fragments, {
    llm,
    embeddings: opts.embeddings,
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (d, t) =>
      report("enriching", t > 0 ? (d / t) * WEIGHTS.enrich : 0, `Reading your notes (${d}/${t})`),
  });
  const fragments = opts.fragments.map((f) => {
    const patch = patches.get(f.id);
    return patch === undefined ? f : { ...f, ...patch };
  });
  finishStage(WEIGHTS.enrich);
  abortIfCancelled();

  // ---- Stage 3: the Bible ----
  report("bible", 0, "Finding the shape of your book");
  const bible = await reuseOrBuildBible(previous, fragments, opts, llm);
  finishStage(WEIGHTS.bible);
  abortIfCancelled();

  // ---- Stage 4: the outline ----
  report("outlining", 0, "Planning chapters");
  const outline = outlineIsStale(previous.outline, bible.version, fragments)
    ? await buildOutline({
        llm,
        projectId: opts.project.id,
        bible,
        fragments,
        targetWords: opts.project.targetWords,
        previous: previous.outline,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (d, t) =>
          report("outlining", (d / t) * WEIGHTS.outline, `Planning chapter ${d} of ${t}`),
      })
    : previous.outline!;
  finishStage(WEIGHTS.outline);
  abortIfCancelled();

  // ---- Stage 5: drafting, incremental ----
  const cards = allScenes(outline);
  const fragmentMap = new Map(fragments.map((f) => [f.id, f]));
  // Tails and ledger from the previous build seed the keys; scenes we end up
  // rebuilding will refresh them as we go.
  const tails = new Map<SceneId, string>();
  for (const s of previous.manuscript?.scenes ?? []) tails.set(s.sceneId, tailOf(s.prose));
  const seedLedger = previous.ledger ?? { deltas: [] };

  const keyed = cards.map((card) => ({
    id: card.id as string,
    key: sceneKey({
      card,
      bibleVersion: bible.version,
      fragments: card.fragmentIds
        .map((id) => fragmentMap.get(id))
        .filter((f): f is Fragment => f !== undefined),
    }),
  }));

  // Previously written prose, indexed by what it was built from rather than by
  // what it was called. A regenerated outline renames every scene; this is what
  // lets their prose survive it.
  const previousByKey = new Map<string, DraftedScene>();
  for (const scene of previous.manuscript?.scenes ?? []) {
    previousByKey.set(scene.contentHash, scene);
  }

  const dirty = dirtyScenes(keyed, new Set(previousByKey.keys()));

  const context: DraftContext = {
    bible,
    outline,
    fragments: fragmentMap,
    ledger: seedLedger,
    tails,
  };

  report(
    "drafting",
    0,
    dirty.size === cards.length
      ? `Writing ${cards.length} scenes`
      : `Rewriting ${dirty.size} of ${cards.length} scenes`,
  );

  const freshlyDrafted =
    dirty.size === 0
      ? []
      : await draftScenes({
          context,
          only: new Set([...dirty].map((id) => id as SceneId)),
          batch,
          budget,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (d, t) =>
            report("drafting", (d / t) * WEIGHTS.draft, `Writing scene ${d} of ${t}`),
        });

  // Freshly drafted prose is what the ledger and revision stages read next.
  collectTails(freshlyDrafted, tails);

  const draftedById = new Map(freshlyDrafted.map((s) => [s.sceneId as string, s]));

  let scenes: DraftedScene[] = [];
  for (const entry of keyed) {
    const fresh = draftedById.get(entry.id);
    if (fresh !== undefined) {
      scenes.push(fresh);
      continue;
    }
    const reused = previousByKey.get(entry.key);
    if (reused === undefined) continue;

    // Rebind the reused prose to the scene it now occupies. The outline may have
    // renamed it; the words are the same words.
    const card = cards.find((c) => (c.id as string) === entry.id);
    scenes.push(
      card === undefined
        ? reused
        : { ...reused, sceneId: card.id, chapterId: card.chapterId },
    );
  }

  if (scenes.length === 0) throw new Error("Compile produced no scenes");
  finishStage(WEIGHTS.draft);
  abortIfCancelled();

  // ---- Stage 6: continuity ledger ----
  report("revising", 0, "Tracking continuity");
  const ledger = await buildLedger(
    scenes,
    cards,
    { llm, bible, ...(opts.signal ? { signal: opts.signal } : {}) },
    (d, t) => report("revising", (d / t) * WEIGHTS.ledger, `Tracking continuity (${d}/${t})`),
  );
  finishStage(WEIGHTS.ledger);
  abortIfCancelled();

  // ---- Stage 7: holistic passes ----
  let issues: ContinuityIssue[] = [];
  let assessment = "Revision passes were skipped for this compile.";
  let payoffs: PayoffReport | null = null;

  if (opts.skipRevision !== true) {
    const reviseCtx: ReviseContext = { bible, outline, ledger };
    const share = WEIGHTS.revise / 4;

    report("revising", 0, "Smoothing the joins between scenes");
    scenes = await smoothTransitions(scenes, reviseCtx, batch, {
      budget,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    finishStage(share);
    abortIfCancelled();

    // The whole manuscript, in one context. This is the pass that most pipelines
    // cannot run, and the reason this one produces a book rather than a
    // collection of scenes.
    report("revising", 0, "Reading the whole book for contradictions");
    const audit = await auditContinuity(scenes, reviseCtx, llm);
    issues = audit.issues;
    assessment = audit.assessment;
    finishStage(share);
    abortIfCancelled();

    if (issues.length > 0) {
      report("revising", 0, `Correcting ${issues.length} continuity issues`);
      scenes = await applyContinuityFixes(scenes, issues, reviseCtx, batch, {
        budget,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    }

    report("revising", 0, "Making it sound like you");
    scenes = await unifyVoice(scenes, reviseCtx, batch, {
      budget,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    finishStage(share);
    abortIfCancelled();

    report("revising", 0, "Checking setups and payoffs");
    payoffs = await auditPayoffs(reviseCtx, llm);
    finishStage(share);
  }

  const compileId = asCompileId(newId());
  const manuscript: Manuscript = {
    projectId: opts.project.id as ProjectId,
    compileId,
    bibleVersion: bible.version,
    outlineVersion: outline.version,
    scenes,
    createdAt: Date.now(),
  };

  report("complete", 1, "Done");

  return {
    compileId: compileId as string,
    state: { bible, outline, manuscript, ledger, compiledAt: Date.now() },
    manuscript,
    coverage: coverage(fragments, outline),
    reusedScenes: scenes.length - freshlyDrafted.length,
    rebuiltScenes: freshlyDrafted.length,
    continuityIssues: issues,
    continuityAssessment: assessment,
    payoffs,
    unusedFragments: outline.unusedFragments,
    costUsd: budget.spentUsd,
    costBreakdown: budget.breakdown(),
    words: manuscriptWords(manuscript),
  };
}


/**
 * Whether the outline has to be rebuilt.
 *
 * Reusing it whenever the Bible version matched looked like a sound saving and
 * was in fact the bug that made the product's central promise false: newly
 * captured notes were never allocated to any scene, so "your notes become a book
 * as you go along" quietly did nothing after the first compile.
 *
 * A fragment that the planner deliberately set aside is not a reason to replan —
 * it has already been considered, and the author has been shown it in
 * `unusedFragments`. Only genuinely unseen material forces a rebuild.
 *
 * Regenerating the outline mints new scene ids, but that is no longer expensive:
 * scene reuse matches on the content key, so unchanged scenes keep their prose
 * under whatever name the new outline gives them.
 */
export function outlineIsStale(
  outline: Outline | null,
  bibleVersion: number,
  fragments: readonly Fragment[],
): boolean {
  if (outline === null) return true;
  if (outline.bibleVersion !== bibleVersion) return true;

  const considered = new Set<string>(assignedFragments(outline));
  for (const skipped of outline.unusedFragments) considered.add(skipped.fragmentId as string);

  return fragments.some(
    (f) =>
      f.deletedAt === null && f.text.trim().length > 0 && !considered.has(f.id as string),
  );
}

/**
 * Rebuilds the Bible only when the corpus has meaningfully moved.
 *
 * The Bible is the root of the dependency graph: bumping its version dirties
 * every scene in the book. So we re-derive it when a tenth of the corpus is new —
 * enough that the shape of the work may genuinely have changed — and otherwise
 * leave it alone. Rebuilding on every added note would make incremental compiles
 * meaningless, since each one would invalidate everything downstream.
 */
const BIBLE_REBUILD_THRESHOLD = 0.1;

async function reuseOrBuildBible(
  previous: CompileState,
  fragments: readonly Fragment[],
  opts: CompileOptions,
  llm: LlmLike,
): Promise<Bible> {
  const existing = previous.bible;
  if (existing === null) {
    return buildBible({
      llm,
      projectId: opts.project.id,
      form: opts.project.form,
      fragments,
      previous: null,
    });
  }

  const known = new Set(existing.sources);
  const usable = fragments.filter((f) => f.deletedAt === null && f.text.trim().length > 0);
  const added = usable.filter((f) => !known.has(f.id)).length;
  const churn = usable.length === 0 ? 0 : added / usable.length;

  if (churn < BIBLE_REBUILD_THRESHOLD) return existing;

  return buildBible({
    llm,
    projectId: opts.project.id,
    form: opts.project.form,
    fragments,
    previous: existing,
  });
}

export class CompileCancelledError extends Error {
  constructor(readonly spentUsd: number) {
    super(`Compile cancelled after spending $${spentUsd.toFixed(2)}`);
    this.name = "CompileCancelledError";
  }
}

export { manuscriptCost, manuscriptWords };

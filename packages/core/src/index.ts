/**
 * @loom/core — the compiler that turns a notebook into a book.
 *
 * The whole design follows from one measurement. A 100,000-word novel is about
 * 135,000 tokens; the context window is 1,000,000. The book fits seven times
 * over. But the per-call output ceiling is 128,000 tokens, and coherence degrades
 * long before that — so no single call can write a book, while a single call can
 * comfortably *read* one.
 *
 * Generate hierarchically. Audit holistically.
 *
 *   1. enrich      — classify, entity-link and embed each fragment as it is
 *                    written, so compile time never pays for it
 *   2. constellate — cluster loose notes into candidate works
 *   3. bible       — derive the compressed, authoritative context (~8k tokens)
 *                    that every later call shares as a cached prefix
 *   4. outline     — plan chapters and scenes as a *consumption plan* that names
 *                    which fragments each scene must use
 *   5. draft       — write scene-sized units in parallel through the Batch API
 *   6. ledger      — extract state deltas so facts travel forward cheaply
 *   7. revise      — transitions, continuity, voice and payoff passes, with the
 *                    whole manuscript in one context
 *   8. recompile   — content-addressed build cache, so a note added in month
 *                    seven rebuilds three scenes rather than the whole book
 */

export * from "./types/index.js";

export { getForm, listForms, renderFormBible, fictionForm, memoirForm } from "./forms/registry.js";
export type { FormDefinition, StructuralPart } from "./forms/types.js";

export {
  MODELS,
  PRICING,
  BATCH_DISCOUNT,
  CostBudget,
  BudgetExceededError,
  costUsd,
  addUsage,
  zeroUsage,
} from "./llm/models.js";
export type { ModelId, ModelRole, Pricing, TokenUsage, CostOptions } from "./llm/models.js";
export { Llm, LlmError } from "./llm/client.js";
export type { CallSpec, Effort, LlmOptions, UsageEvent } from "./llm/client.js";
export { BatchRunner } from "./llm/batch.js";
export type { BatchRequest, BatchResult, BatchProgress, BatchOptions } from "./llm/batch.js";
// The model surface the pipeline depends on. Exported because `CompileOptions`
// names these types: without them a caller cannot supply the `llm`/`batch` seam
// the option advertises.
export type { LlmLike, BatchLike } from "./llm/interfaces.js";

export { sha256Hex } from "./cache/sha256.js";
export { utf8Bytes } from "./cache/utf8.js";
export {
  sceneKey,
  tailOf,
  hashString,
  dirtyScenes,
  changedSince,
  stableStringify,
  DRAFT_STRATEGY_VERSION,
} from "./cache/content-address.js";

export {
  normalise as normaliseVector,
  dot,
  cosine,
  centroid,
  topK,
  encodeVector,
  decodeVector,
} from "./retrieval/vector.js";
export { VoyageEmbeddings, LocalTrigramEmbeddings } from "./retrieval/embed.js";
export type { EmbeddingProvider } from "./retrieval/embed.js";
export { clusterFragments } from "./retrieval/cluster.js";
export type { Constellation, ClusterOptions, ClusterResult } from "./retrieval/cluster.js";

export {
  renderBible,
  renderFragments,
  renderLedger,
  renderSceneCard,
  BIBLE_TOKEN_BUDGET,
  BibleTooLargeError,
} from "./prompts/render.js";

export {
  enrichFragments,
  needsEnrichment,
  needsEmbedding,
  canonicalKey,
  ENRICHER_VERSION,
} from "./pipeline/enrich.js";
export { buildBible, selectVoiceSamples, verifyExemplars } from "./pipeline/bible.js";
export { buildOutline, coverage, reconcileUnused } from "./pipeline/outline.js";
export {
  draftScenes,
  draftSceneNow,
  draftSystemPrompt,
  draftUserPrompt,
  stripPreamble,
  detectUsedFragments,
} from "./pipeline/draft.js";
export type { DraftContext, DraftOptions } from "./pipeline/draft.js";
export { buildLedger, extractDeltas } from "./pipeline/ledger.js";
export {
  smoothTransitions,
  auditContinuity,
  applyContinuityFixes,
  unifyVoice,
  auditPayoffs,
  firstWords,
  lastWords,
  replaceOpening,
} from "./pipeline/revise.js";
export type { ContinuityIssue, PayoffReport, ReviseContext } from "./pipeline/revise.js";

export { compile, emptyCompileState, CompileCancelledError } from "./pipeline/compile.js";
export type {
  CompileOptions,
  CompileProgress,
  CompileResult,
  CompileState,
} from "./pipeline/compile.js";

export {
  SYNC_PROTOCOL_VERSION,
  SYNC_PAGE_LIMIT,
  CONFLICT_SUFFIX,
  fragmentsDiffer,
  laterOf,
} from "./sync/protocol.js";
export type {
  SyncFragment,
  SyncProject,
  SyncPush,
  SyncRecord,
  SyncConflict,
  SyncRequest,
  SyncResponse,
} from "./sync/protocol.js";
export { sync, syncOnce, emptyOutcome, toSyncFragment, toSyncProject } from "./sync/engine.js";
export type {
  SyncLocal,
  SyncTransport,
  SyncOptions,
  SyncOutcome,
  LocalFragment,
  LocalProject,
} from "./sync/engine.js";

export { toMarkdown, toPlainText, estimateReadingMinutes } from "./export/format.js";
export type { ExportOptions } from "./export/format.js";
export {
  assembleBook,
  splitParagraphs,
  escapeXml,
  stripInvalidXml,
  xmlText,
} from "./export/book.js";
export type { Book, BookChapter, BookScene, AssembleOptions } from "./export/book.js";
export { zip, crc32 } from "./export/zip.js";
export type { ZipEntry, ZipOptions, Deflater } from "./export/zip.js";
export { toEpub, packageEpub, chapterHref, chapterLabel } from "./export/epub.js";
export type { EpubOptions } from "./export/epub.js";
export { toDocx, packageDocx } from "./export/docx.js";
export type { DocxOptions } from "./export/docx.js";

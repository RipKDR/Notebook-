# Loom — architecture

Loose notes in. A whole book out.

---

## The measurement everything follows from

| | Tokens | Consequence |
|---|---|---|
| A 100,000-word novel | ~135,000 | The text itself is small |
| Input context window (Opus 5 / Sonnet 5) | 1,000,000 | A whole novel fits **seven times over** |
| Max output per call | 128,000 | No single call can *emit* a book |

The constraint everyone assumes — "a book won't fit in context" — is the wrong one. A book fits
easily. What does not fit is the *output*: a single call physically cannot produce 100,000 words,
and coherence collapses long before the ceiling.

That asymmetry is the entire design:

> **Generate hierarchically. Audit holistically.**

Most systems in this space chunk generation correctly and then chunk revision too, which is why
their output reads like forty competent short stories wearing a trenchcoat. We do not have to.
Continuity checking, voice unification and setup/payoff tracking all run with the complete
manuscript in a single context.

## The mental model

**The notebook is source. The book is a build artifact.** This is a compiler with incremental
rebuilds, not a chatbot with a long prompt.

```
fragments  →  enrichment  →  constellations  →  bible  →  outline  →  scenes  →  passes  →  book
 (source)        (IR)          (grouping)       (context)   (plan)    (codegen)   (link)    (artifact)
```

## The pipeline

### 1. Capture — `apps/mobile/src/app/(tabs)/index.tsx`

One text box. No title, no tags, no project picker, no confirmation. Saving does not dismiss or
navigate, because thoughts arrive in clusters.

This screen decides whether the product works. If capture has friction there are no fragments, and
with no fragments there is no book. Everything downstream exists to make sense of what this screen
collects, and nothing downstream is allowed to add a step to it.

### 2. Enrichment — `packages/core/src/pipeline/enrich.ts`

Runs continuously in the background **as the user writes**, never at compile time. Each fragment is
classified, entity-linked, theme-tagged and embedded.

Two decisions carry the cost here. Fragments are packed 20-per-call, because the system prompt
dominates the price of indexing a 30-word note. And scheduling this at write time rather than
compile time is why pressing "write my book" feels instant instead of like a cold start.

Entity ids are derived from the normalised name (`person:grandma-rose`), so a note written today and
one written next March link up with no cross-fragment resolution pass.

### 3. Constellations — `packages/core/src/retrieval/cluster.ts`

Average-linkage agglomerative clustering over a blended similarity: embedding proximity, plus shared
named entities, plus shared themes.

Semantic similarity alone is not enough. Two notes about the same person in different registers
embed far apart; two unrelated notes in the same register embed close together. Entity overlap is
weighted heavily and deliberately — if two fragments both mention the same grandmother, they belong
together regardless of what the embedding thinks.

Average linkage rather than single (which chains — one ambiguous note bridges two unrelated works
into a mush) or complete (which shatters legitimately broad themes).

**This is the product's first magic moment**: the screen that tells a user they have been writing a
book about their father for eight months without knowing it.

### 4. The Story Bible — `packages/core/src/pipeline/bible.ts`

The single most important artifact. A compact (~8K token), versioned, structured document: cast,
world rules, timeline, themes, motifs, voice guide.

**This is the answer to "how does context stay fresh."** No drafting call ever sees the manuscript.
Every call sees the Bible, plus its immediate neighbourhood, plus the fragments it is assigned.

It runs *once* per compile and every later call inherits its judgement, so it routes to the most
capable model at maximum effort while per-scene work routes to a cheaper one. Spending the most on
the fewest calls is the whole of the cost strategy.

Voice exemplars are **verified verbatim** against the corpus rather than trusted. A paraphrase here
would quietly teach all ~80 scene calls the wrong voice.

### 5. The outline — `packages/core/src/pipeline/outline.ts`

Not a summary — a **consumption plan**. Every scene card names the exact fragment ids it is
obligated to incorporate.

That single constraint is what separates this from a tool that writes a book "inspired by" your
notes. The plan is accountable for the material, and at the end we can report precisely which
fragments made it in and which did not.

Two passes: allocate the corpus across chapters (one call, whole-corpus view), then expand each
chapter into scene cards independently (batchable). Asking for a hundred fully-specified scene cards
in one call means ~25K tokens of structured output, which is where schema adherence and attention
quality visibly degrade.

`reconcileUnused` recomputes what was actually dropped from the finished outline, rather than
trusting the planner's own account — fragments fall through the cracks between passes, and those are
the dangerous ones because nobody reports them.

### 6. Scene drafting — `packages/core/src/pipeline/draft.ts`

~80 calls of ~1,250 words each, through the Batch API at half price.

The prompt is split precisely on the caching boundary:

- **System** (byte-identical across every scene): instructions + Bible + form guidance. Written to
  cache once, read back ~80 times at 0.1×.
- **User** (volatile): scene card, assigned fragments verbatim, previous scene's tail, ledger slice.

Getting this split wrong does not break anything. It silently multiplies the bill, which is the worst
kind of bug.

Batching is right for a full compile (tap, close the app, get a notification) and wrong for a
single-scene preview. `draftSceneNow` is the synchronous path, same prompts.

### 7. The continuity ledger — `packages/core/src/pipeline/ledger.ts`

Drafting is deliberately myopic. That is what keeps a full compile affordable, and it is also what
would produce a book where a character's eyes change colour in chapter nine.

After each scene, a cheap model extracts structured state deltas: who knows what, who is where,
injuries, elapsed time, deaths. A scene sixty pages later receives only the slice touching its own
cast — typically a dozen lines. Facts travel forward across the whole book without anyone paying to
re-read it.

### 8. Holistic passes — `packages/core/src/pipeline/revise.ts`

Where the 1M window earns its keep.

| Pass | Scope | Model |
|---|---|---|
| **A. Transitions** | Pairwise seams, batched | Sonnet 5, low effort |
| **B. Continuity audit** | **The entire manuscript, one call** | Opus 5, max effort |
| **C. Voice unification** | Per scene, batched, toward the author's own sentences | Sonnet 5 |
| **D. Setup / payoff** | Outline + ledger | Opus 5 |

Pass B is the one most pipelines cannot run, and the reason this one produces a book rather than a
collection of scenes.

Pass C is the difference between a product and a toy: the book should sound like the person who
wrote the notes, not like a language model. A guard rejects any "line edit" that changes length by
more than 40% in either direction.

### 9. Incremental recompile — `packages/core/src/cache/content-address.ts`

Each scene is content-addressed on `sha256(bible_version, scene_card, assigned_fragments,
prev_tail_hash, ledger_hash)`.

Add a note in month seven and three scenes rebuild, not a hundred thousand words. This is `make` for
prose, and it is the difference between "your notes become a book as you go along" being a feature
and being a marketing line.

Cross-scene isolation is deliberate: a change in chapter 40 must not dirty chapter 2, or incremental
rebuilds degenerate into full ones. The price is that cross-book consistency is enforced by the
holistic passes instead — which is the right trade, because those run over the finished text in a
single context anyway.

## Cost

A 100,000-word compile, at current list prices:

| Stage | Model | Mechanism | Cost |
|---|---|---|---|
| Enrich 800 fragments | Haiku 4.5 | Batch, 20 per call | $0.75 *(amortised over months)* |
| Bible + outline | Opus 5 | Cached corpus, max effort | $2.43 |
| 80 scenes | Sonnet 5 | Batch + 1h cached prefix | $1.23 |
| Continuity extraction | Haiku 4.5 | Batch | $0.16 |
| 4 revision passes | Sonnet 5 + Opus 5 | Mixed | $2.95 |
| **Total** | | | **~$7.50** |

Batch (50% off) plus prompt caching on the shared Bible prefix is what takes this from ~$30 to
~$7.50 — the difference between an impossible business and a viable one.

**Model routing is the largest single lever.** A compile makes ~1,000 calls and they are not equally
valuable: enrichment runs thousands of times and needs classification, not judgement; the Bible runs
once and everything inherits it.

## Repository layout

```
packages/core     The compiler. Pure TypeScript, no platform dependencies.
  types/          Branded ids, Fragment, Bible, Outline, Manuscript, Ledger
  forms/          Pluggable work forms — fiction, memoir
  llm/            Model routing, cost accounting, caching, batching
  cache/          Content-addressed build keys + pure-TS SHA-256
  retrieval/      Vector maths, embeddings, clustering
  pipeline/       The eight stages
  prompts/        Prompt rendering, with the Bible token budget enforced
  export/         Markdown → pandoc → EPUB/DOCX/PDF

packages/db       Local-first SQLite. FTS5 search, sync boundary, two adapters.
apps/mobile       Expo SDK 57 / RN 0.86. Capture, notes, threads, library, reader.
apps/worker       Hono compile service. Holds the API key; runs jobs the client polls.
```

## Pluggable work forms

Fiction and memoir look similar — both are long-form prose built from fragments — but differ in the
one place that matters: what the Bible must hold, and therefore what the outliner is planning
*towards*.

**Fiction is organised around causality.** Scenes exist because the previous scene made them
inevitable. The Bible carries want, need and conflict so the outliner can build a chain of
consequence. Four acts.

**Memoir is organised around a question.** The events already happened and cannot be reordered for
dramatic convenience; structure comes from the retrospective narrator's inquiry. The Bible carries a
governing question and a stance, and a hard constraint against inventing events, people or dialogue.
Three parts: the question, the evidence, the reckoning.

Adding a form — essay collection, travel narrative, family history — means one file in
`packages/core/src/forms/` and one line in the registry. The pipeline does not change.

## Why local-first

The local SQLite database is the **source of truth**, not a cache of a server. The app is fully
functional with the network permanently off; cloud sync is a feature layered on top rather than a
dependency underneath. That ordering is what makes it honest to tell a user their writing is theirs.

Sync columns (`dirty`, `synced_at`, `remote_rev`) and the outbox ship in the first migration even
though sync is a paid feature. Retrofitting those onto a database holding someone's only copy of
their writing is exactly the migration you never want to write.

## Why the API key is server-side

An app bundle is not a secret. A client-side key is a credential handed to every installer and billed
to us. The worker holds it, enforces entitlements, and runs compiles as polled jobs — which is also
the right shape for work that takes minutes to an hour.

## Notable engineering decisions

**Pure-TypeScript SHA-256** (`cache/sha256.ts`). `node:crypto` is absent on Hermes and `crypto.subtle`
is async and patchy in React Native. A collision here means a stale, contradictory scene silently
survives a rebuild — invisible and unfalsifiable — so we pay for the real hash. Verified against
`node:crypto` across 12 cases including unpaired surrogates, which truncated-emoji notes genuinely
produce.

**Paragraph-aware prose excerpting.** The obvious implementation (split on whitespace, take N words,
join with spaces) silently destroys every paragraph break. It matters twice: the model is shown these
excerpts as examples of the book's rhythm, and `replaceOpening` writes the result back into the
manuscript.

**Symmetric tokenisation in `detectUsedFragments`.** Filtering short words from the needle but not
the haystack means n-grams can never align — dropping "my" from "said my name" yields "said name",
which does not occur in a text that faithfully contains the original line.

**FTS5 query escaping.** `MATCH` takes an expression language, not a string. `AND`, `NEAR`, quotes and
apostrophes all occur in ordinary prose; passing them raw turns a search for an apostrophised word
into a syntax error on the user's search screen.

**Savepoints in both adapters.** SQLite has no nested `BEGIN`, and repository methods call each
other freely.

## What is not built yet

- Cloud sync transport (the boundary and outbox exist; the wire protocol does not)
- Billing and the real entitlement check — `resolveTier` reads a header, which is marked in the code
  as development-only
- Durable job queue — jobs are in-memory, so a worker restart loses in-flight compiles
- Widgets, share-sheet capture, voice capture
- EPUB/DOCX export (Markdown export exists; conversion is a server-side pandoc call)
- On-device `sqlite-vec` (enabled in the Expo config; the app currently uses the pure-JS path)

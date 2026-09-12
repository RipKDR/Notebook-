# Loom

Loose notes in. A whole book out.

You have a sentence in your head at a traffic light. You write it down. Months later, a few hundred
scraps like it become a full-length novel or memoir — built from your own writing, in your own voice.

## The idea

Most "AI writing" tools ask you to start with a blank page and a prompt. This one starts with the
thing writers actually do: catching fragments before they evaporate, with no idea yet what they are
for. The structure is discovered afterwards, from the material.

The engine treats your notebook as **source code** and the book as a **build artifact**. Adding a
note in month seven rebuilds the three scenes it affects, not a hundred thousand words.

## How it works

| | |
|---|---|
| **Capture** | One box. No title, no tags, no project. Saving does not dismiss. |
| **Enrich** | Each note is classified, entity-linked and embedded in the background, as you write. |
| **Threads** | Clustering finds the works hiding in the notebook. *"These 53 notes are about your father."* |
| **Bible** | A compact, authoritative context: cast, world, themes, and your own voice, quoted verbatim. |
| **Outline** | A plan that names which of your notes every scene must use. |
| **Draft** | ~80 scene-sized calls in parallel, sharing a cached prompt prefix. |
| **Revise** | Transitions, continuity, voice, payoff — with the whole manuscript in one context. |
| **Export** | EPUB, Word or Markdown, written on the device, with the network off. |
| **Sync** | Notebook fragments and projects across devices; compiled build artifacts stay local. A conflict keeps both versions, never one. |

The design turns on one measurement: a 100k-word book is ~135k tokens against a **1M-token** window,
so the whole thing fits seven times over — but the **128k output ceiling** means no single call can
write one. So: *generate hierarchically, audit holistically.*

Full reasoning in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
packages/core     The compiler. Pure TypeScript, fully unit-tested.
packages/db       Local-first SQLite with FTS5 search and a sync boundary.
apps/mobile       Expo SDK 57 / React Native 0.86, iOS + Android.
apps/worker       Hono compile service. Holds the model credential.
```

## Running it

```bash
pnpm install
pnpm build          # builds packages/core then packages/db
pnpm test           # 389 tests
pnpm typecheck
```

The worker:

```bash
cp apps/worker/.env.example apps/worker/.env

# Add your ANTHROPIC_API_KEY, then generate the token-signing secret:
pnpm --filter @loom/worker token -- --secret        # put this in LOOM_TOKEN_SECRET
pnpm --filter @loom/worker dev

# Mint a token for the app (Settings -> Compile service):
pnpm --filter @loom/worker token -- --sub me --tier paid
```

Without `LOOM_TOKEN_SECRET` the worker refuses every authenticated route — it fails closed rather
than trusting whatever the caller claims.

The app:

```bash
pnpm --filter @loom/mobile dev
```

Requires Node 20.11+ (the worker and `packages/db` tests use `node:sqlite`, which needs
`--experimental-sqlite` on Node 22 and is stable on Node 24).

The app needs a development build rather than Expo Go: `expo-sqlite` is configured with the
`sqlite-vec` extension, which is a native build flag.

```bash
pnpm --filter @loom/mobile prebuild
```

## Costs

A full 100,000-word compile costs roughly **$7.50** in model tokens — Batch API at 50% plus prompt
caching on the shared Bible prefix. Free tier compiles a real sample offline-capable; the paid tier
adds cloud sync, full length, and the revision passes.

Per-stage breakdown in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#cost).

## Status

Working end to end: capture, local search, background indexing, threads, compiling a book on the
worker, reading it offline, exporting it as EPUB, Word or Markdown, and syncing the notebook across
devices. Compiles are durable — a worker restart resumes from the last stage boundary rather than
losing the run. The billing system that mints tokens and the widgets are not — see
[What is not built yet](docs/ARCHITECTURE.md#what-is-not-built-yet).

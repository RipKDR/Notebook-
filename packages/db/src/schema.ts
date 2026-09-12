/**
 * Schema and migrations.
 *
 * Migrations are append-only and run inside a transaction. `user_version` is
 * SQLite's own counter, which means the migration state travels with the
 * database file rather than in a table we could forget to write.
 */

export const SCHEMA_VERSION = 2;

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  form         TEXT NOT NULL,
  target_words INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

-- ---------------------------------------------------------------------------
-- Fragments — the user's raw writing. The source of truth for everything else.
--
-- project_id is nullable on purpose. Capture must never ask the user to decide
-- what a note is for: they are stopped at a traffic light with a sentence in
-- their head. Sorting happens later, or never.
-- ---------------------------------------------------------------------------
CREATE TABLE fragments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'quick',
  deleted_at  INTEGER,
  pinned      INTEGER NOT NULL DEFAULT 0,

  -- Enrichment, written by the background indexer. Null until it has run.
  kind              TEXT,
  digest            TEXT,
  themes            TEXT,     -- JSON array
  valence           REAL,
  standalone        REAL,
  enricher_version  TEXT,
  enriched_at       INTEGER,

  embedding         BLOB,     -- Float32Array, little-endian
  embedding_model   TEXT,

  -- Sync bookkeeping. Present from the first migration even though sync is a
  -- paid feature, because retrofitting these columns onto a database full of
  -- someone's only copy of their writing is exactly the migration you do not
  -- want to be writing later.
  dirty        INTEGER NOT NULL DEFAULT 1,
  synced_at    INTEGER,
  remote_rev   TEXT
);

CREATE INDEX fragments_created  ON fragments(created_at DESC);
CREATE INDEX fragments_updated  ON fragments(updated_at DESC);
CREATE INDEX fragments_project  ON fragments(project_id, created_at DESC);
CREATE INDEX fragments_dirty    ON fragments(dirty) WHERE dirty = 1;
CREATE INDEX fragments_unenriched ON fragments(enriched_at) WHERE enriched_at IS NULL;

-- ---------------------------------------------------------------------------
-- Entity mentions, normalised out so we can ask "every fragment about Nan"
-- without scanning JSON in every row.
-- ---------------------------------------------------------------------------
CREATE TABLE fragment_entities (
  fragment_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL,
  surface     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  PRIMARY KEY (fragment_id, entity_id)
);

CREATE INDEX fragment_entities_entity ON fragment_entities(entity_id);

-- ---------------------------------------------------------------------------
-- Full-text search. FTS5 is enabled by default in expo-sqlite.
-- External-content table: the index stores no copy of the text, so there is
-- exactly one place a fragment's words live.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE fragments_fts USING fts5(
  text,
  content='fragments',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER fragments_fts_insert AFTER INSERT ON fragments BEGIN
  INSERT INTO fragments_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER fragments_fts_delete AFTER DELETE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER fragments_fts_update AFTER UPDATE OF text ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO fragments_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- ---------------------------------------------------------------------------
-- Compile artifacts. Stored as JSON documents: they are written whole by the
-- pipeline and read whole by the reader, and normalising them would buy nothing
-- but joins.
-- ---------------------------------------------------------------------------
CREATE TABLE compile_state (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  bible        TEXT,
  outline      TEXT,
  ledger       TEXT,
  compiled_at  INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 1,
  synced_at    INTEGER
);

-- Scenes are stored per-row rather than inside the manuscript blob so an
-- incremental rebuild rewrites only the scenes it actually changed.
CREATE TABLE scenes (
  scene_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id   TEXT NOT NULL,
  reading_order INTEGER NOT NULL,
  prose        TEXT NOT NULL,
  word_count   INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  passes       TEXT NOT NULL,
  used_fragments TEXT NOT NULL,
  model        TEXT NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  drafted_at   INTEGER NOT NULL
);

CREATE INDEX scenes_project ON scenes(project_id, reading_order);
CREATE INDEX scenes_hash    ON scenes(content_hash);

-- ---------------------------------------------------------------------------
-- Compile runs, for history and for showing the user what a compile cost.
-- ---------------------------------------------------------------------------
CREATE TABLE compile_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  words         INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  reused_scenes INTEGER NOT NULL DEFAULT 0,
  rebuilt_scenes INTEGER NOT NULL DEFAULT 0,
  coverage      REAL NOT NULL DEFAULT 0,
  report        TEXT,
  error         TEXT
);

CREATE INDEX compile_runs_project ON compile_runs(project_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Sync outbox. Ordered log of local changes awaiting upload.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_outbox (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER NOT NULL
);
`.trim(),
  },
  {
    // Cloud sync. Fragments already carried their sync columns from the first
    // migration, because retrofitting those onto a database holding someone's
    // only copy of their writing is exactly the migration you do not want to be
    // writing later. Projects did not, and the device needs somewhere to keep
    // its position in the server's log.
    version: 2,
    sql: `
-- The outbox goes. It was a second record of what had changed, and it had
-- already drifted from the first: pinning a note and assigning one to a book
-- both set the dirty flag and neither wrote an outbox row, so those changes
-- would never have been uploaded. One flag on the row it describes cannot
-- disagree with itself, and re-sending a push that already landed is harmless.
DROP TABLE sync_outbox;

-- A local revision counter, bumped on every local write.
--
-- Acknowledging a push has to clear the dirty flag only if the row has not
-- changed since it was read, and updated_at cannot answer that: two edits in
-- the same millisecond share a timestamp, and clearing the flag on the second
-- one strands that edit on the device for ever. A counter that only ever goes
-- up cannot be ambiguous.
ALTER TABLE fragments ADD COLUMN local_rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects  ADD COLUMN local_rev INTEGER NOT NULL DEFAULT 1;

ALTER TABLE projects ADD COLUMN dirty      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN synced_at  INTEGER;
ALTER TABLE projects ADD COLUMN remote_rev TEXT;

CREATE INDEX projects_dirty ON projects(dirty) WHERE dirty = 1;

-- Exactly one row. The cursor is the server sequence this device has applied;
-- a timestamp would be wrong under clock skew and unrecoverable once a record
-- had been skipped.
CREATE TABLE sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  cursor         INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  last_error     TEXT
);

INSERT INTO sync_state (id, cursor) VALUES (1, 0);
`.trim(),
  },
];

/** Pragmas applied on every connection. WAL keeps capture writes from blocking reads. */
export const CONNECTION_PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA busy_timeout = 5000;",
  "PRAGMA synchronous = NORMAL;",
].join("\n");

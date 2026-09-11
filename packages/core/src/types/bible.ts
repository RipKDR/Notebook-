import type { BibleId, EntityId, FragmentId, ProjectId } from "./ids.js";

/**
 * The Story Bible is the single most important artifact in the system.
 *
 * It is the *compressed, authoritative context* that every downstream generation
 * call receives. We never pass the manuscript to a drafting call; we pass the
 * Bible. It is deliberately budgeted to ~8K tokens so it can sit in a cached
 * prompt prefix across all ~80 scene calls of a compile, which is what makes a
 * full-length book cost single-digit dollars instead of triple.
 *
 * It is versioned. Bumping the version invalidates every scene built against it,
 * which is exactly what we want — the content-addressed build cache keys on it.
 */

/** A recurring person, place or object the work must stay consistent about. */
export interface BibleEntity {
  readonly id: EntityId;
  readonly name: string;
  readonly kind: "person" | "place" | "object" | "organisation" | "event";
  /** Other names the user has used for this entity across fragments. */
  readonly aliases: readonly string[];
  /** 2-4 sentences. Enough to write them consistently, not a biography. */
  readonly description: string;
  /** What is true about them at the start of the work. The ledger tracks deltas from here. */
  readonly initialState: string;
  /** Fragments that established or reference this entity. Provenance matters — see `docs/ARCHITECTURE.md`. */
  readonly sources: readonly FragmentId[];
}

export interface BibleTheme {
  readonly name: string;
  readonly statement: string;
  /** Concrete images, objects or phrases that carry this theme. Drives motif seeding in scenes. */
  readonly motifs: readonly string[];
  readonly sources: readonly FragmentId[];
}

/**
 * The voice guide is what stops the book sounding like a language model.
 * It is derived from the user's own fragments and carries verbatim exemplars.
 */
export interface VoiceGuide {
  /** Prose description of the register, rhythm and diction. */
  readonly description: string;
  /** Verbatim sentences pulled from the user's own writing. The strongest signal we have. */
  readonly exemplars: readonly string[];
  /** Things the voice never does. Negative constraints outperform positive ones here. */
  readonly avoid: readonly string[];
  readonly person: "first" | "second" | "third-limited" | "third-omniscient";
  readonly tense: "past" | "present";
}

/** Form-specific payload. Discriminated on `form`. See `src/forms/`. */
export interface FictionBible {
  readonly form: "fiction";
  readonly premise: string;
  readonly protagonistId: EntityId | null;
  /** The want/need split that drives the arc. */
  readonly want: string;
  readonly need: string;
  readonly centralConflict: string;
  readonly worldRules: readonly string[];
  readonly stakes: string;
}

export interface MemoirBible {
  readonly form: "memoir";
  /** Memoir needs a governing question, not a plot. This is the spine. */
  readonly governingQuestion: string;
  /** The narrating self looking back, versus the experiencing self on the page. */
  readonly retrospectiveStance: string;
  readonly timeSpan: { readonly earliest: string; readonly latest: string };
  /** Real people need care. Flags which entities the user marked sensitive. */
  readonly sensitiveEntityIds: readonly EntityId[];
  readonly throughLine: string;
}

export type FormBible = FictionBible | MemoirBible;
export type WorkForm = FormBible["form"];

export interface Bible {
  readonly id: BibleId;
  readonly projectId: ProjectId;
  /** Monotonic. Any change bumps this and dirties every scene built on it. */
  readonly version: number;
  readonly title: string;
  /** One sentence. The thing you'd say at a party. */
  readonly logline: string;
  readonly entities: readonly BibleEntity[];
  readonly themes: readonly BibleTheme[];
  readonly voice: VoiceGuide;
  readonly formBible: FormBible;
  /** Fragments that shaped this Bible, for provenance and for incremental invalidation. */
  readonly sources: readonly FragmentId[];
  readonly createdAt: number;
  /** Token cost of the rendered Bible. Enforced by `renderBible` against the budget. */
  readonly renderedTokens: number;
}

export function findEntity(bible: Bible, id: EntityId): BibleEntity | undefined {
  return bible.entities.find((e) => e.id === id);
}

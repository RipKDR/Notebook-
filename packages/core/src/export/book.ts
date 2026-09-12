import type { Bible } from "../types/bible.js";
import type { Manuscript } from "../types/manuscript.js";
import type { Outline } from "../types/outline.js";

/**
 * The finished book, in the one shape every export format wants.
 *
 * Markdown, EPUB and DOCX each need the same traversal — outline order, scenes
 * matched to their cards, empty chapters dropped, parts announced when they
 * change — and they disagree only about how to mark a paragraph up. Doing that
 * traversal three times over is how an EPUB ends up with a chapter the Markdown
 * does not have.
 */

export interface BookScene {
  /** Prose split on blank lines. Every format needs paragraphs; none wants the raw string. */
  readonly paragraphs: readonly string[];
}

export interface BookChapter {
  readonly id: string;
  /** 1-based, as a reader counts them. */
  readonly number: number;
  readonly title: string;
  /** The part this chapter opens, or null if it continues the current one. */
  readonly opensPart: string | null;
  readonly scenes: readonly BookScene[];
}

export interface Book {
  readonly title: string;
  readonly author: string;
  readonly logline: string;
  /** BCP-47. Readers use it for hyphenation and text-to-speech. */
  readonly language: string;
  /** Stable across recompiles of a project, so a reader updates rather than duplicates. */
  readonly identifier: string;
  readonly chapters: readonly BookChapter[];
  readonly words: number;
}

export interface AssembleOptions {
  readonly bible: Bible;
  readonly outline: Outline;
  readonly manuscript: Manuscript;
  /** The person who wrote the notes. There is no other author. */
  readonly author?: string;
  readonly language?: string;
}

export function assembleBook(opts: AssembleOptions): Book {
  const { bible, outline, manuscript } = opts;
  const byScene = new Map(manuscript.scenes.map((s) => [s.sceneId as string, s]));

  const chapters: BookChapter[] = [];
  let lastPart = "";
  let number = 0;

  for (const chapter of outline.chapters) {
    const scenes: BookScene[] = [];
    for (const card of chapter.scenes) {
      const drafted = byScene.get(card.id as string);
      if (drafted === undefined) continue;
      const paragraphs = splitParagraphs(drafted.prose);
      if (paragraphs.length > 0) scenes.push({ paragraphs });
    }
    // A chapter whose scenes all failed to draft is not a chapter. Emitting it
    // anyway gives the reader an empty entry in the table of contents.
    if (scenes.length === 0) continue;

    number++;
    const part = chapter.part.trim();
    const opensPart = part.length > 0 && part !== lastPart ? part : null;
    if (opensPart !== null) lastPart = part;

    chapters.push({ id: chapter.id as string, number, title: chapter.title, opensPart, scenes });
  }

  return {
    title: bible.title,
    author: opts.author?.trim() ?? "",
    logline: bible.logline,
    language: opts.language ?? "en",
    // Keyed on the project, not the compile: re-exporting a revised book should
    // replace the old one on a reader's shelf rather than sit beside it.
    identifier: `urn:loom:project:${manuscript.projectId as string}`,
    chapters,
    words: manuscript.scenes.reduce((n, s) => n + s.wordCount, 0),
  };
}

/**
 * Splits prose into paragraphs on blank lines.
 *
 * The obvious alternative — split on every newline — turns one soft-wrapped
 * paragraph into a dozen one-line paragraphs, which in EPUB means a dozen
 * first-line indents. Blank lines are what the drafting stage actually emits
 * between paragraphs.
 */
export function splitParagraphs(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

/**
 * Escapes text for XML.
 *
 * EPUB and DOCX are both parsed strictly, and prose is full of ampersands and
 * angle brackets. An unescaped one does not render oddly — it makes the file
 * refuse to open.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Removes characters XML 1.0 cannot represent at all.
 *
 * Control characters below 0x20 — other than tab, newline and carriage return —
 * are forbidden outright: there is no escape for them. They arrive in pasted
 * text, and a single one makes the whole export unopenable rather than merely
 * ugly. Unpaired surrogates are the same problem from the other direction, and
 * truncated-emoji notes genuinely produce them.
 */
export function stripInvalidXml(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

/** Text ready to drop into an XML document: the impossible removed, the rest escaped. */
export function xmlText(text: string): string {
  return escapeXml(stripInvalidXml(text));
}

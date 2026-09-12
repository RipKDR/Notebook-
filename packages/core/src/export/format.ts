import { assembleBook, type Book } from "./book.js";
import type { Bible } from "../types/bible.js";
import type { Manuscript } from "../types/manuscript.js";
import type { Outline } from "../types/outline.js";

/**
 * Manuscript export.
 *
 * Markdown is the interchange format: pandoc turns it into EPUB, DOCX or PDF,
 * and it survives being pasted anywhere. Generating EPUB directly would mean
 * shipping a zip writer and an XHTML templater to the phone to produce something
 * a one-line server-side conversion already does better.
 */

export interface ExportOptions {
  readonly bible: Bible;
  readonly outline: Outline;
  readonly manuscript: Manuscript;
  /** Include chapter titles. Off for a continuous-prose export. */
  readonly chapterHeadings?: boolean;
  /** Scene separator. Empty string omits it. */
  readonly sceneBreak?: string;
  readonly includeFrontMatter?: boolean;
}

export function toMarkdown(opts: ExportOptions): string {
  const { chapterHeadings = true, sceneBreak = "* * *", includeFrontMatter = true } = opts;
  return markdownFromBook(assembleBook(opts), { chapterHeadings, sceneBreak, includeFrontMatter });
}

export function toPlainText(opts: ExportOptions): string {
  return toMarkdown({ ...opts, includeFrontMatter: false })
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\*\s\*\s\*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownFromBook(
  book: Book,
  opts: { chapterHeadings: boolean; sceneBreak: string; includeFrontMatter: boolean },
): string {
  const out: string[] = [];
  if (opts.includeFrontMatter) {
    out.push(`---`, `title: ${JSON.stringify(book.title)}`, `---`, "", `# ${book.title}`, "");
    if (book.logline.trim().length > 0) out.push(`*${book.logline}*`, "");
  }

  for (const chapter of book.chapters) {
    if (chapter.opensPart !== null) out.push(`# ${chapter.opensPart}`, "");
    if (opts.chapterHeadings) out.push(`## ${chapter.number}. ${chapter.title}`, "");
    chapter.scenes.forEach((scene, i) => {
      if (i > 0 && opts.sceneBreak.length > 0) out.push(opts.sceneBreak, "");
      out.push(scene.paragraphs.join("\n\n"), "");
    });
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** At 250 words per minute, the conventional figure for adult prose reading. */
export function estimateReadingMinutes(manuscript: Manuscript): number {
  const words = manuscript.scenes.reduce((n, s) => n + s.wordCount, 0);
  return Math.round(words / 250);
}

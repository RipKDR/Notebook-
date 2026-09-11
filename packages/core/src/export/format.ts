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
  const {
    bible,
    outline,
    manuscript,
    chapterHeadings = true,
    sceneBreak = "* * *",
    includeFrontMatter = true,
  } = opts;

  const byScene = new Map(manuscript.scenes.map((s) => [s.sceneId as string, s]));
  const out: string[] = [];

  if (includeFrontMatter) {
    out.push(`---`, `title: ${JSON.stringify(bible.title)}`, `---`, "", `# ${bible.title}`, "");
    if (bible.logline.trim().length > 0) out.push(`*${bible.logline}*`, "");
  }

  let lastPart = "";
  for (const chapter of outline.chapters) {
    const scenes = chapter.scenes
      .map((card) => byScene.get(card.id as string))
      .filter((s): s is NonNullable<typeof s> => s !== undefined && s.prose.trim().length > 0);
    if (scenes.length === 0) continue;

    if (chapter.part !== lastPart && chapter.part.trim().length > 0) {
      out.push(`# ${chapter.part}`, "");
      lastPart = chapter.part;
    }
    if (chapterHeadings) {
      out.push(`## ${chapter.index + 1}. ${chapter.title}`, "");
    }

    scenes.forEach((scene, i) => {
      if (i > 0 && sceneBreak.length > 0) out.push(sceneBreak, "");
      out.push(scene.prose.trim(), "");
    });
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function toPlainText(opts: ExportOptions): string {
  return toMarkdown({ ...opts, includeFrontMatter: false })
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\*\s\*\s\*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** At 250 words per minute, the conventional figure for adult prose reading. */
export function estimateReadingMinutes(manuscript: Manuscript): number {
  const words = manuscript.scenes.reduce((n, s) => n + s.wordCount, 0);
  return Math.round(words / 250);
}

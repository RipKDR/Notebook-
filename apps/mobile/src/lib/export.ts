import {
  assembleBook,
  packageDocx,
  packageEpub,
  toMarkdown,
  utf8Bytes,
  type Bible,
  type Manuscript,
  type Outline,
  type Project,
} from "@loom/core";
import type { LoomDatabase } from "@loom/db";
import {
  FORMAT_MIME,
  FORMAT_UTI,
  NothingToExportError,
  exportFilename,
  type ExportFormat,
} from "./export-formats";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Getting the book out.
 *
 * This runs entirely on the device. The manuscript is already in local SQLite —
 * that is the whole point of writing it there when a compile lands — so asking a
 * server to package it would mean uploading a finished book in order to be sent
 * it back. It would also make export the one thing in the app that needs a
 * network, which is exactly the promise the rest of it does not make.
 *
 * Archives are written uncompressed: DEFLATE is not available on Hermes, and a
 * stored EPUB is a valid EPUB. Measured on an 80-scene book, that costs about
 * 4x the file size — roughly 700KB for a 100,000-word novel instead of under
 * 200KB — which no reader and no share sheet cares about.
 */

export interface ExportResult {
  readonly uri: string;
  readonly filename: string;
  readonly bytes: number;
}

/**
 * Renders a compiled book to a file in the cache directory.
 *
 * The cache directory rather than documents: the file exists to be handed to the
 * share sheet, and the system reclaiming it later is correct. The book itself
 * lives in SQLite and can be re-rendered at any time.
 */
export async function exportProject(
  db: LoomDatabase,
  project: Project,
  format: ExportFormat,
  opts: { author?: string } = {},
): Promise<ExportResult> {
  const state = await db.loadCompileState(project.id);
  const scenes = await db.loadScenes(project.id);

  const bible = state?.bible as Bible | null | undefined;
  const outline = state?.outline as Outline | null | undefined;
  if (bible === null || bible === undefined || outline === null || outline === undefined) {
    throw new NothingToExportError();
  }
  if (scenes.length === 0) throw new NothingToExportError();

  const manuscript: Manuscript = {
    projectId: project.id,
    compileId: `${project.id as string}-export` as Manuscript["compileId"],
    bibleVersion: bible.version,
    outlineVersion: outline.version,
    scenes,
    createdAt: state?.compiledAt ?? Date.now(),
  };

  const book = assembleBook({ bible, outline, manuscript, ...opts });
  if (book.chapters.length === 0) throw new NothingToExportError();

  const data =
    format === "epub"
      ? packageEpub(book)
      : format === "docx"
        ? packageDocx(book)
        : utf8Bytes(toMarkdown({ bible, outline, manuscript }));

  const filename = exportFilename(project.title, format);
  const file = new File(Paths.cache, filename);
  // Re-exporting after a recompile must overwrite, not fail.
  if (file.exists) file.delete();
  file.create();
  file.write(data);

  return { uri: file.uri, filename, bytes: data.length };
}

/** Renders the book and hands it to the system share sheet. */
export async function shareProject(
  db: LoomDatabase,
  project: Project,
  format: ExportFormat,
  opts: { author?: string } = {},
): Promise<ExportResult> {
  const result = await exportProject(db, project, format, opts);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, {
      mimeType: FORMAT_MIME[format],
      dialogTitle: project.title,
      UTI: FORMAT_UTI[format],
    });
  }
  return result;
}

export * from "./export-formats";

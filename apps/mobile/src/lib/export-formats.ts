/**
 * The parts of export that do not touch the platform.
 *
 * Split out for the same reason `token.ts` is split from `settings.ts`: the file
 * next door imports `expo-file-system`, which cannot be loaded outside a React
 * Native runtime, and this is the half worth testing.
 */

export const EXPORT_FORMATS = ["epub", "docx", "markdown"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  epub: "EPUB — for reading",
  docx: "Word — for editing",
  markdown: "Markdown — for anything",
};

export const FORMAT_MIME: Record<ExportFormat, string> = {
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown",
};

export const FORMAT_EXTENSION: Record<ExportFormat, string> = {
  epub: "epub",
  docx: "docx",
  markdown: "md",
};

/**
 * Uniform Type Identifier, which is how iOS decides what an exported file is.
 *
 * Without one for EPUB the share sheet offers no reading apps at all — it treats
 * the file as an opaque archive, which is technically true and useless.
 */
export const FORMAT_UTI: Partial<Record<ExportFormat, string>> = {
  epub: "org.idpf.epub-container",
};

export class NothingToExportError extends Error {
  constructor() {
    super("This book has not been compiled yet.");
    this.name = "NothingToExportError";
  }
}

/**
 * Turns a book title into something every filesystem and share sheet accepts.
 *
 * Titles are user-written and contain slashes, colons and emoji. A slash in
 * particular does not produce an odd filename — it produces a write to a
 * directory that does not exist.
 */
export function safeFilename(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Leading dots hide the file on every Unix system, including inside the
  // archives some share targets unpack into.
  const truncated = cleaned.replace(/^\.+/, "").slice(0, 80);
  // UTF-16 slicing can leave half an astral character at the boundary.
  const safe = truncated.replace(/[\uD800-\uDBFF]$/, "").trim();
  return safe.length > 0 ? safe : "Untitled";
}

export function exportFilename(title: string, format: ExportFormat): string {
  return `${safeFilename(title)}.${FORMAT_EXTENSION[format]}`;
}

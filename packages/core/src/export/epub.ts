import { assembleBook, xmlText, type AssembleOptions, type Book, type BookChapter } from "./book.js";
import { utf8Bytes } from "../cache/utf8.js";
import { zip, type Deflater } from "./zip.js";

/**
 * EPUB 3 export.
 *
 * A book the author cannot get out of the app is not their book. Export is the
 * difference between a product that holds someone's writing and one that merely
 * borrows it.
 *
 * Built here rather than by shelling out to pandoc on the worker. That would put
 * an external binary in the deployment, make export a network round trip, and
 * rule out exporting on a plane — which contradicts the promise the rest of the
 * app makes about the notes this book came from. EPUB is a zip of XHTML; the
 * whole format is small enough to write correctly.
 */

export interface EpubOptions extends AssembleOptions {
  /** Injected so core stays platform-free: `node:zlib` on the worker, nothing on the phone. */
  readonly deflate?: Deflater;
  /** Fixed by default, so exporting the same book twice produces the same bytes. */
  readonly modifiedAt?: Date;
  /** Include the logline under the title on the title page. */
  readonly includeLogline?: boolean;
}

export function toEpub(opts: EpubOptions): Uint8Array {
  const book = assembleBook(opts);
  return packageEpub(book, opts);
}

export function packageEpub(book: Book, opts: Omit<EpubOptions, keyof AssembleOptions> = {}): Uint8Array {
  const modified = opts.modifiedAt ?? new Date(Date.UTC(2020, 0, 1));
  const text = utf8Bytes;

  const entries = [
    // Must be first and stored: a reader identifies the format by reading bytes
    // 30..50 of the archive without inflating anything. Compress it and some
    // readers reject the file outright.
    { name: "mimetype", data: text("application/epub+zip"), store: true },
    { name: "META-INF/container.xml", data: text(CONTAINER_XML) },
    { name: "OEBPS/style.css", data: text(STYLESHEET) },
    { name: "OEBPS/title.xhtml", data: text(titlePage(book, opts.includeLogline !== false)) },
    { name: "OEBPS/nav.xhtml", data: text(navDocument(book)) },
    ...book.chapters.map((chapter) => ({
      name: `OEBPS/${chapterHref(chapter)}`,
      data: text(chapterDocument(book, chapter)),
    })),
    { name: "OEBPS/content.opf", data: text(packageDocument(book, modified)) },
  ];

  return zip(entries, {
    ...(opts.deflate !== undefined ? { deflate: opts.deflate } : {}),
    modifiedAt: modified,
  });
}

/** Zero-padded so chapters sort correctly in any tool that lists the archive. */
export function chapterHref(chapter: BookChapter): string {
  return `text/ch${String(chapter.number).padStart(4, "0")}.xhtml`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/**
 * Deliberately restrained.
 *
 * A reading app's own typography settings are almost always better than
 * anything we could impose, and an EPUB that fights them reads worse everywhere.
 * This sets what the format genuinely needs — indented paragraphs, no indent
 * after a break, a centred scene divider — and leaves fonts, size and colour to
 * the reader.
 */
const STYLESHEET = `@namespace epub "http://www.idpf.org/2007/ops";

body { margin: 0 5%; text-align: justify; }

h1, h2 { text-align: left; font-weight: normal; line-height: 1.3; }
h1 { margin: 3em 0 0.2em; }
h2 { margin: 2em 0 1em; }

p { margin: 0; text-indent: 1.4em; }
p.first, h1 + p, h2 + p, .break + p { text-indent: 0; }

.part { margin: 30% 0 0; text-align: center; }
.break { margin: 1.2em 0; text-align: center; text-indent: 0; }

.title-page { margin-top: 25%; text-align: center; }
.title-page h1 { margin: 0 0 0.4em; }
.logline { font-style: italic; }
.author { margin-top: 2em; }
`;

/**
 * One XHTML document.
 *
 * `stylesheet` is passed in rather than inferred because chapters live a
 * directory down from everything else, and a relative href that is right at the
 * package root is a 404 inside `text/`.
 */
function xhtml(title: string, language: string, body: string, stylesheet: string): string {
  const lang = xmlText(language);
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
  <head>
    <meta charset="utf-8"/>
    <title>${xmlText(title)}</title>
    <link rel="stylesheet" type="text/css" href="${stylesheet}"/>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function titlePage(book: Book, includeLogline: boolean): string {
  const lines = [`    <section class="title-page" epub:type="titlepage">`];
  lines.push(`      <h1>${xmlText(book.title)}</h1>`);
  if (includeLogline && book.logline.trim().length > 0) {
    lines.push(`      <p class="logline">${xmlText(book.logline.trim())}</p>`);
  }
  if (book.author.length > 0) {
    lines.push(`      <p class="author">${xmlText(book.author)}</p>`);
  }
  lines.push(`    </section>`);
  return xhtml(book.title, book.language, lines.join("\n"), "style.css");
}

/**
 * The navigation document — EPUB 3's table of contents.
 *
 * Required by the specification, and it is also the only way a reader can jump
 * between chapters. An EPUB without one opens as a single undifferentiated
 * scroll.
 */
function navDocument(book: Book): string {
  const items = book.chapters
    .map(
      (chapter) =>
        `        <li><a href="${chapterHref(chapter)}">${xmlText(chapterLabel(chapter))}</a></li>`,
    )
    .join("\n");

  const body = `    <nav epub:type="toc" id="toc">
      <h2>Contents</h2>
      <ol>
${items}
      </ol>
    </nav>
    <nav epub:type="landmarks" hidden="hidden">
      <ol>
        <li><a epub:type="titlepage" href="title.xhtml">Title page</a></li>
${book.chapters[0] !== undefined ? `        <li><a epub:type="bodymatter" href="${chapterHref(book.chapters[0])}">Beginning</a></li>` : ""}
      </ol>
    </nav>`;

  return xhtml("Contents", book.language, body, "style.css");
}

export function chapterLabel(chapter: BookChapter): string {
  const title = chapter.title.trim();
  return title.length > 0 ? `${chapter.number}. ${title}` : `Chapter ${chapter.number}`;
}

function chapterDocument(book: Book, chapter: BookChapter): string {
  const lines: string[] = [`    <section epub:type="chapter">`];

  if (chapter.opensPart !== null) {
    lines.push(`      <h1 class="part">${xmlText(chapter.opensPart)}</h1>`);
  }
  lines.push(`      <h2>${xmlText(chapterLabel(chapter))}</h2>`);

  chapter.scenes.forEach((scene, index) => {
    // A scene break is a typographic device, not a heading: readers expect a
    // centred mark and a flush-left paragraph after it.
    if (index > 0) lines.push(`      <p class="break">* * *</p>`);
    scene.paragraphs.forEach((paragraph, p) => {
      const cls = p === 0 ? ` class="first"` : "";
      lines.push(`      <p${cls}>${xmlText(paragraph)}</p>`);
    });
  });

  lines.push(`    </section>`);

  return xhtml(chapterLabel(chapter), book.language, lines.join("\n"), "../style.css");
}

/**
 * The OPF package document: metadata, manifest and reading order.
 *
 * `dcterms:modified` is required by EPUB 3 and must be a whole-second UTC
 * timestamp — a value with milliseconds fails validation, which is the kind of
 * detail that only shows up when someone tries to sell the file.
 */
function packageDocument(book: Book, modified: Date): string {
  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="style" href="style.css" media-type="text/css"/>`,
    `    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
    ...book.chapters.map(
      (chapter) =>
        `    <item id="ch${chapter.number}" href="${chapterHref(chapter)}" media-type="application/xhtml+xml"/>`,
    ),
  ].join("\n");

  const spine = [
    `    <itemref idref="title"/>`,
    `    <itemref idref="nav"/>`,
    ...book.chapters.map((chapter) => `    <itemref idref="ch${chapter.number}"/>`),
  ].join("\n");

  const author =
    book.author.length > 0
      ? `    <dc:creator id="author">${xmlText(book.author)}</dc:creator>\n    <meta refines="#author" property="role" scheme="marc:relators">aut</meta>\n`
      : "";

  const description =
    book.logline.trim().length > 0
      ? `    <dc:description>${xmlText(book.logline.trim())}</dc:description>\n`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${xmlText(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${xmlText(book.identifier)}</dc:identifier>
    <dc:title>${xmlText(book.title)}</dc:title>
    <dc:language>${xmlText(book.language)}</dc:language>
${author}${description}    <meta property="dcterms:modified">${modified.toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
}

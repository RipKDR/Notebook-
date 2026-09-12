import { assembleBook, xmlText, type AssembleOptions, type Book } from "./book.js";
import { chapterLabel } from "./epub.js";
import { utf8Bytes } from "../cache/utf8.js";
import { zip, type Deflater } from "./zip.js";

/**
 * DOCX export.
 *
 * EPUB is what a book is read in; DOCX is what it is *worked* in. An author
 * sending a manuscript to an editor, a beta reader or an agent needs a file
 * those people can leave comments and tracked changes in, and that is Word.
 *
 * OOXML is the same zip-of-XML shape as EPUB, so it reuses the writer. What it
 * does not reuse is the layout: this emits standard manuscript format — double
 * spaced, 12pt serif, first-line indents, chapters starting on a new page —
 * because that is what the people receiving it expect to open.
 */

export interface DocxOptions extends AssembleOptions {
  /** Injected so core stays platform-free: `node:zlib` on the worker, nothing on the phone. */
  readonly deflate?: Deflater;
  readonly modifiedAt?: Date;
  /**
   * Standard manuscript format: double spaced, one side, 12pt. On by default,
   * because a DOCX export exists to be sent to someone who will mark it up.
   */
  readonly manuscriptFormat?: boolean;
}

export function toDocx(opts: DocxOptions): Uint8Array {
  const book = assembleBook(opts);
  return packageDocx(book, opts);
}

export function packageDocx(
  book: Book,
  opts: Omit<DocxOptions, keyof AssembleOptions> = {},
): Uint8Array {
  const modified = opts.modifiedAt ?? new Date(Date.UTC(2020, 0, 1));
  const doubleSpaced = opts.manuscriptFormat !== false;
  const text = utf8Bytes;

  const entries = [
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES) },
    { name: "_rels/.rels", data: text(ROOT_RELS) },
    { name: "word/_rels/document.xml.rels", data: text(DOCUMENT_RELS) },
    { name: "word/styles.xml", data: text(styles(doubleSpaced)) },
    { name: "word/document.xml", data: text(document(book)) },
    { name: "docProps/core.xml", data: text(coreProperties(book, modified)) },
    { name: "docProps/app.xml", data: text(appProperties(book)) },
  ];

  return zip(entries, {
    ...(opts.deflate !== undefined ? { deflate: opts.deflate } : {}),
    modifiedAt: modified,
  });
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Named styles rather than inline formatting on every run.
 *
 * A manuscript is tens of thousands of paragraphs. Inlining the formatting on
 * each one triples the file size and — worse — makes it unchangeable: an editor
 * who wants single spacing has to reformat the document instead of changing one
 * style.
 *
 * Measurements are OOXML's: half-points for size, twentieths of a point
 * ("twips") for spacing and indents.
 */
function styles(doubleSpaced: boolean): string {
  const lineSpacing = doubleSpaced ? 480 : 276;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="0" w:line="${lineSpacing}" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:ind w:firstLine="480"/></w:pPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="FirstParagraph">
    <w:name w:val="First Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:ind w:firstLine="0"/></w:pPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="SceneBreak">
    <w:name w:val="Scene Break"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="240" w:after="240"/>
      <w:ind w:firstLine="0"/>
      <w:jc w:val="center"/>
    </w:pPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="2400" w:after="240"/>
      <w:ind w:firstLine="0"/>
      <w:jc w:val="center"/>
    </w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:basedOn w:val="Title"/>
    <w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>
    <w:rPr><w:b w:val="0"/><w:i/><w:sz w:val="24"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:qFormat/>
    <w:pPr>
      <w:pageBreakBefore/>
      <w:spacing w:before="2400" w:after="480"/>
      <w:ind w:firstLine="0"/>
      <w:jc w:val="center"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:qFormat/>
    <w:pPr>
      <w:pageBreakBefore/>
      <w:spacing w:before="1200" w:after="480"/>
      <w:ind w:firstLine="0"/>
      <w:jc w:val="center"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
</w:styles>
`;
}

function paragraph(style: string, content: string): string {
  if (content.length === 0) {
    return `    <w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr></w:p>`;
  }
  // xml:space="preserve" keeps leading and trailing spaces, which Word would
  // otherwise silently collapse — and prose does contain deliberate ones.
  return (
    `    <w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${xmlText(content)}</w:t></w:r></w:p>`
  );
}

function document(book: Book): string {
  const body: string[] = [];

  body.push(paragraph("Title", book.title));
  if (book.logline.trim().length > 0) body.push(paragraph("Subtitle", book.logline.trim()));
  if (book.author.length > 0) body.push(paragraph("Subtitle", book.author));

  for (const chapter of book.chapters) {
    if (chapter.opensPart !== null) body.push(paragraph("Heading1", chapter.opensPart));
    body.push(paragraph("Heading2", chapterLabel(chapter)));

    chapter.scenes.forEach((scene, index) => {
      if (index > 0) body.push(paragraph("SceneBreak", "* * *"));
      scene.paragraphs.forEach((text, p) => {
        // The first paragraph after a heading or a break is not indented —
        // typographic convention, and the one thing that makes a Word export
        // look like a manuscript rather than an essay.
        body.push(paragraph(p === 0 ? "FirstParagraph" : "Normal", text));
      });
    });
  }

  // US Letter, one-inch margins: what a submission is expected to be.
  const section = `    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}">
  <w:body>
${body.join("\n")}
${section}
  </w:body>
</w:document>
`;
}

function coreProperties(book: Book, modified: Date): string {
  const stamp = modified.toISOString().replace(/\.\d{3}Z$/, "Z");
  const creator = book.author.length > 0 ? xmlText(book.author) : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlText(book.title)}</dc:title>
  <dc:creator>${creator}</dc:creator>
  <cp:lastModifiedBy>${creator}</cp:lastModifiedBy>
  <dc:description>${xmlText(book.logline.trim())}</dc:description>
  <dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
</cp:coreProperties>
`;
}

function appProperties(book: Book): string {
  const paragraphs = book.chapters.reduce(
    (n, c) => n + c.scenes.reduce((m, s) => m + s.paragraphs.length, 0),
    0,
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Loom</Application>
  <Words>${book.words}</Words>
  <Paragraphs>${paragraphs}</Paragraphs>
</Properties>
`;
}

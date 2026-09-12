import { inflateRawSync, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  asChapterId,
  asCompileId,
  asFragmentId,
  asProjectId,
  asSceneId,
  assembleBook,
  crc32,
  splitParagraphs,
  stripInvalidXml,
  toDocx,
  toEpub,
  toMarkdown,
  xmlText,
  zip,
  type Bible,
  type DraftedScene,
  type Manuscript,
  type Outline,
} from "../src/index.js";

/**
 * Export is verified by reading the archives back apart, not by asserting on the
 * strings that went in. A zip with a wrong offset or a stale CRC is a perfectly
 * plausible-looking string and an unopenable file.
 */

// ---------------------------------------------------------------------------
// A minimal, independent ZIP reader — deliberately written from the format spec
// rather than from the writer, so that a misunderstanding in one does not
// silently validate the other.
// ---------------------------------------------------------------------------

interface ReadEntry {
  readonly name: string;
  readonly method: number;
  readonly data: Uint8Array;
  readonly localOffset: number;
}

function unzip(archive: Uint8Array): Map<string, ReadEntry> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();

  // Find the end-of-central-directory record by scanning back for its signature.
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ReadEntry>();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central directory header");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLen));

    // Follow the pointer into the local header and read the payload from there.
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = archive.subarray(start, start + compressedSize);

    const data = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    if (data.length !== uncompressedSize) throw new Error(`size mismatch: ${name}`);
    if (crc32(data) !== crc) throw new Error(`crc mismatch: ${name}`);

    entries.set(name, { name, method, data, localOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

const decode = (entry: ReadEntry | undefined) =>
  entry === undefined ? "" : new TextDecoder().decode(entry.data);

const nodeDeflate = (data: Uint8Array) => new Uint8Array(deflateRawSync(data));

// ---------------------------------------------------------------------------
// A small, complete book.
// ---------------------------------------------------------------------------

const projectId = asProjectId("proj-1");

function scene(id: string, chapter: string, prose: string): DraftedScene {
  return {
    sceneId: asSceneId(id),
    chapterId: asChapterId(chapter),
    prose,
    wordCount: prose.trim().split(/\s+/).length,
    contentHash: `hash-${id}`,
    passes: ["draft"],
    usedFragments: [asFragmentId("f1")],
    model: "fake",
    costUsd: 0.01,
    draftedAt: 1,
  };
}

const bible = {
  id: "bible-1",
  projectId,
  version: 1,
  title: "The Kitchen Radio & <Other> Songs",
  logline: "A daughter reads her mother's silences.",
  entities: [],
  themes: [],
  voice: { description: "", exemplars: [], avoid: [], person: "first", tense: "past" },
  formBible: {
    form: "memoir",
    governingQuestion: "Why the silence?",
    retrospectiveStance: "",
    timeSpan: { earliest: "1970", latest: "2020" },
    sensitiveEntityIds: [],
    throughLine: "",
  },
  sources: [],
  createdAt: 1,
  renderedTokens: 100,
} as unknown as Bible;

const outline = {
  id: "outline-1",
  projectId,
  version: 1,
  bibleVersion: 1,
  targetWords: 1000,
  unusedFragments: [],
  createdAt: 1,
  chapters: [
    {
      id: asChapterId("c1"),
      index: 0,
      title: "The Drawer",
      summary: "",
      part: "The Question",
      scenes: [
        { id: asSceneId("s1"), chapterId: asChapterId("c1") },
        { id: asSceneId("s2"), chapterId: asChapterId("c1") },
      ],
    },
    {
      id: asChapterId("c2"),
      index: 1,
      title: "The Letters",
      summary: "",
      part: "The Evidence",
      scenes: [{ id: asSceneId("s3"), chapterId: asChapterId("c2") }],
    },
    {
      // Every scene in this chapter failed to draft. It must not reach the book.
      id: asChapterId("c3"),
      index: 2,
      title: "The Garden",
      summary: "",
      part: "The Evidence",
      scenes: [{ id: asSceneId("s4"), chapterId: asChapterId("c3") }],
    },
  ],
} as unknown as Outline;

const manuscript: Manuscript = {
  projectId,
  compileId: asCompileId("compile-1"),
  bibleVersion: 1,
  outlineVersion: 1,
  createdAt: 1,
  scenes: [
    scene("s1", "c1", "Every drawer had string in it.\n\nShe kept the good scissors elsewhere."),
    scene("s2", "c1", "The radio stayed on <all> night & nobody listened."),
    scene("s3", "c2", "He sent letters for eleven years."),
  ],
};

const book = { bible, outline, manuscript, author: "H. Ferraro" };

// ---------------------------------------------------------------------------

describe("zip writer", () => {
  it("round-trips entries through an independent reader", () => {
    const encoder = new TextEncoder();
    const archive = zip([
      { name: "a.txt", data: encoder.encode("hello") },
      { name: "dir/b.txt", data: encoder.encode("world") },
    ]);

    const entries = unzip(archive);
    expect(decode(entries.get("a.txt"))).toBe("hello");
    expect(decode(entries.get("dir/b.txt"))).toBe("world");
  });

  it("stores entries uncompressed when no deflater is supplied", () => {
    const archive = zip([{ name: "a.txt", data: new TextEncoder().encode("x".repeat(500)) }]);
    expect(unzip(archive).get("a.txt")?.method).toBe(0);
  });

  it("compresses when a deflater is supplied", () => {
    const data = new TextEncoder().encode("the same sentence over and over. ".repeat(200));
    const stored = zip([{ name: "a.txt", data }]);
    const deflated = zip([{ name: "a.txt", data }], { deflate: nodeDeflate });

    expect(deflated.length).toBeLessThan(stored.length);
    const entry = unzip(deflated).get("a.txt");
    expect(entry?.method).toBe(8);
    expect(entry?.data).toEqual(data);
  });

  it("falls back to storing when compression would make the entry bigger", () => {
    // Random-ish bytes do not compress; DEFLATE adds framing and the result
    // grows. Writing the larger version would be a strictly worse file.
    const data = new Uint8Array(64);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) % 251;
    const archive = zip([{ name: "a.bin", data }], { deflate: nodeDeflate });

    expect(unzip(archive).get("a.bin")?.method).toBe(0);
    expect(unzip(archive).get("a.bin")?.data).toEqual(data);
  });

  it("honours a forced store even when a deflater is available", () => {
    const data = new TextEncoder().encode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const archive = zip([{ name: "m", data, store: true }], { deflate: nodeDeflate });
    expect(unzip(archive).get("m")?.method).toBe(0);
  });

  it("handles an empty archive", () => {
    expect(unzip(zip([])).size).toBe(0);
  });

  it("handles an empty file", () => {
    const entries = unzip(zip([{ name: "empty", data: new Uint8Array(0) }]));
    expect(entries.get("empty")?.data.length).toBe(0);
  });

  it("survives non-ASCII names and content", () => {
    const data = new TextEncoder().encode("naïve — café 😀");
    const entries = unzip(zip([{ name: "notes/naïve.txt", data }], { deflate: nodeDeflate }));
    expect(decode(entries.get("notes/naïve.txt"))).toBe("naïve — café 😀");
  });

  it("computes CRC-32 the way the format defines it", () => {
    // The published check value for "123456789".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("produces byte-identical archives for identical input", () => {
    const entry = [{ name: "a.txt", data: new TextEncoder().encode("hello") }];
    expect(zip(entry)).toEqual(zip(entry));
  });
});

describe("book assembly", () => {
  it("drops a chapter whose scenes all failed to draft", () => {
    const assembled = assembleBook(book);
    expect(assembled.chapters.map((c) => c.title)).toEqual(["The Drawer", "The Letters"]);
  });

  it("numbers chapters as a reader counts them, after the empty ones are gone", () => {
    expect(assembleBook(book).chapters.map((c) => c.number)).toEqual([1, 2]);
  });

  it("announces a part only when it changes", () => {
    const assembled = assembleBook(book);
    expect(assembled.chapters[0]?.opensPart).toBe("The Question");
    expect(assembled.chapters[1]?.opensPart).toBe("The Evidence");
  });

  it("splits prose on blank lines, not on every newline", () => {
    expect(splitParagraphs("one\nstill one\n\ntwo")).toEqual(["one still one", "two"]);
    expect(splitParagraphs("   \n\n  ")).toEqual([]);
  });

  it("identifies the book by project so a re-export replaces rather than duplicates", () => {
    expect(assembleBook(book).identifier).toBe("urn:loom:project:proj-1");
  });

  it("removes characters XML cannot represent", () => {
    // A NUL or a lone surrogate has no escape; leaving one in makes the whole
    // file unopenable rather than merely ugly.
    expect(stripInvalidXml("a\u0000b\u001Fc")).toBe("abc");
    expect(stripInvalidXml("ok\uD800end")).toBe("okend");
    expect(stripInvalidXml("emoji 😀 survives")).toBe("emoji 😀 survives");
    expect(stripInvalidXml("tabs\tand\nnewlines\rstay")).toBe("tabs\tand\nnewlines\rstay");
    expect(stripInvalidXml("next\u0085line")).toBe("next\u0085line");
  });

  it("escapes every character XML treats as markup", () => {
    expect(xmlText(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

describe("EPUB", () => {
  const archive = toEpub({ ...book, deflate: nodeDeflate });
  const entries = unzip(archive);

  it("puts an uncompressed mimetype first, where a reader looks for it", () => {
    const mimetype = entries.get("mimetype");
    expect(mimetype?.method).toBe(0);
    expect(mimetype?.localOffset).toBe(0);
    expect(decode(mimetype)).toBe("application/epub+zip");
    // The signature check readers actually perform: the literal string at a
    // fixed byte offset in the archive.
    expect(new TextDecoder().decode(archive.subarray(30, 38))).toBe("mimetype");
    expect(new TextDecoder().decode(archive.subarray(38, 58))).toBe("application/epub+zip");
  });

  it("ships every part the format requires", () => {
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        "mimetype",
        "META-INF/container.xml",
        "OEBPS/content.opf",
        "OEBPS/nav.xhtml",
        "OEBPS/title.xhtml",
        "OEBPS/style.css",
      ]),
    );
  });

  it("preserves XML 1.0 characters from the U+007F–U+009F range in prose", () => {
    const withNextLine = {
      ...book,
      manuscript: {
        ...manuscript,
        scenes: [scene("s1", "c1", "next\u0085line")],
      },
    };
    const chapter = decode(
      unzip(toEpub({ ...withNextLine, deflate: nodeDeflate })).get("OEBPS/text/ch0001.xhtml"),
    );
    expect(chapter).toContain("next\u0085line");
  });

  it("points the container at the package document, which exists", () => {
    const container = decode(entries.get("META-INF/container.xml"));
    const path = /full-path="([^"]+)"/.exec(container)?.[1];
    expect(path).toBe("OEBPS/content.opf");
    expect(entries.has(path!)).toBe(true);
  });

  it("manifests every file it references, and references every file it manifests", () => {
    const opf = decode(entries.get("OEBPS/content.opf"));
    const hrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) expect(entries.has(`OEBPS/${href}`)).toBe(true);

    // Every spine itemref must resolve to a manifest id, or readers show a
    // chapter-shaped hole.
    const ids = new Set([...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]!));
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]!);
    expect(spine.length).toBeGreaterThan(2);
    for (const ref of spine) expect(ids.has(ref)).toBe(true);
  });

  it("declares a whole-second modified timestamp, as EPUB 3 requires", () => {
    const opf = decode(entries.get("OEBPS/content.opf"));
    const stamp = /dcterms:modified">([^<]+)</.exec(opf)?.[1];
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("links every chapter from the table of contents", () => {
    const nav = decode(entries.get("OEBPS/nav.xhtml"));
    const links = [...nav.matchAll(/<li><a href="([^"]+)">([^<]*)</g)];
    expect(links.map((l) => l[2])).toEqual(["1. The Drawer", "2. The Letters"]);
    for (const [, href] of links) expect(entries.has(`OEBPS/${href}`)).toBe(true);
  });

  it("writes the prose as paragraphs, with the markup escaped", () => {
    const chapter = decode(entries.get("OEBPS/text/ch0001.xhtml"));
    expect(chapter).toContain("<p class=\"first\">Every drawer had string in it.</p>");
    expect(chapter).toContain("<p>She kept the good scissors elsewhere.</p>");
    // An unescaped angle bracket here does not render oddly; it makes the file
    // refuse to open.
    expect(chapter).toContain("&lt;all&gt; night &amp; nobody");
    expect(chapter).not.toContain("<all>");
  });

  it("marks the seam between two scenes in one chapter", () => {
    const chapter = decode(entries.get("OEBPS/text/ch0001.xhtml"));
    expect(chapter).toContain('<p class="break">* * *</p>');
  });

  it("announces a new part above the chapter that opens it", () => {
    expect(decode(entries.get("OEBPS/text/ch0002.xhtml"))).toContain(
      '<h1 class="part">The Evidence</h1>',
    );
    expect(decode(entries.get("OEBPS/text/ch0001.xhtml"))).toContain(
      '<h1 class="part">The Question</h1>',
    );
  });

  it("links the stylesheet from the directory each document is actually in", () => {
    expect(decode(entries.get("OEBPS/title.xhtml"))).toContain('href="style.css"');
    expect(decode(entries.get("OEBPS/text/ch0001.xhtml"))).toContain('href="../style.css"');
  });

  it("escapes the title everywhere it appears", () => {
    const opf = decode(entries.get("OEBPS/content.opf"));
    expect(opf).toContain("The Kitchen Radio &amp; &lt;Other&gt; Songs");
    expect(decode(entries.get("OEBPS/title.xhtml"))).toContain(
      "The Kitchen Radio &amp; &lt;Other&gt; Songs",
    );
  });

  it("carries the author through as a creator", () => {
    expect(decode(entries.get("OEBPS/content.opf"))).toContain("<dc:creator id=\"author\">H. Ferraro");
  });

  it("omits the creator entirely when there is no author", () => {
    const anonymous = unzip(toEpub({ bible, outline, manuscript }));
    expect(decode(anonymous.get("OEBPS/content.opf"))).not.toContain("dc:creator");
  });

  it("produces the same bytes twice for the same book", () => {
    expect(toEpub({ ...book, deflate: nodeDeflate })).toEqual(archive);
  });

  it("works with no deflater at all, which is the on-device path", () => {
    const stored = unzip(toEpub(book));
    expect(decode(stored.get("mimetype"))).toBe("application/epub+zip");
    expect([...stored.values()].every((e) => e.method === 0)).toBe(true);
  });
});

describe("DOCX", () => {
  const entries = unzip(toDocx({ ...book, deflate: nodeDeflate }));

  it("ships every part Word requires to open the file", () => {
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
        "word/_rels/document.xml.rels",
        "docProps/core.xml",
        "docProps/app.xml",
      ]),
    );
  });

  it("declares a content type for every part it ships", () => {
    const types = decode(entries.get("[Content_Types].xml"));
    for (const part of ["/word/document.xml", "/word/styles.xml", "/docProps/core.xml"]) {
      expect(types).toContain(`PartName="${part}"`);
    }
    expect(types).toContain('Extension="rels"');
  });

  it("points its root relationship at a document that exists", () => {
    const rels = decode(entries.get("_rels/.rels"));
    const target = /officeDocument" Target="([^"]+)"/.exec(rels)?.[1];
    expect(target).toBe("word/document.xml");
    expect(entries.has(target!)).toBe(true);
  });

  it("uses a style name for every paragraph, and defines every name it uses", () => {
    const document = decode(entries.get("word/document.xml"));
    const styles = decode(entries.get("word/styles.xml"));

    const used = new Set([...document.matchAll(/<w:pStyle w:val="([^"]+)"/g)].map((m) => m[1]!));
    const defined = new Set([...styles.matchAll(/<w:style [^>]*w:styleId="([^"]+)"/g)].map((m) => m[1]!));

    expect(used.size).toBeGreaterThan(3);
    // An undefined style silently falls back to Normal, which is how a
    // manuscript loses every one of its chapter headings.
    for (const style of used) expect(defined.has(style)).toBe(true);
  });

  it("writes the prose, escaped, in reading order", () => {
    const document = decode(entries.get("word/document.xml"));
    const paragraphs = [...document.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map(
      (m) => m[1]!,
    );

    expect(paragraphs).toContain("Every drawer had string in it.");
    expect(paragraphs).toContain("He sent letters for eleven years.");
    expect(paragraphs.indexOf("Every drawer had string in it.")).toBeLessThan(
      paragraphs.indexOf("He sent letters for eleven years."),
    );
    expect(document).toContain("&lt;all&gt; night &amp; nobody");
  });

  it("does not indent the first paragraph after a heading or a break", () => {
    const document = decode(entries.get("word/document.xml"));
    const first = document.indexOf('w:val="FirstParagraph"');
    expect(first).toBeGreaterThan(0);
    expect(document).toContain('<w:pStyle w:val="SceneBreak"/>');
  });

  it("starts each chapter on a new page", () => {
    // Without this a 300-page manuscript runs its chapters together, which is
    // the first thing an editor notices.
    expect(decode(entries.get("word/styles.xml"))).toContain("<w:pageBreakBefore/>");
  });

  it("defines a page size and margins", () => {
    const document = decode(entries.get("word/document.xml"));
    expect(document).toContain("<w:sectPr>");
    expect(document).toContain('w:w="12240"');
  });

  it("records the word count in the document properties", () => {
    expect(decode(entries.get("docProps/app.xml"))).toContain(
      `<Words>${assembleBook(book).words}</Words>`,
    );
  });

  it("single-spaces when manuscript format is turned off", () => {
    const single = unzip(toDocx({ ...book, manuscriptFormat: false }));
    expect(decode(single.get("word/styles.xml"))).toContain('w:line="276"');
    expect(decode(entries.get("word/styles.xml"))).toContain('w:line="480"');
  });
});

describe("all three formats agree about the book", () => {
  it("contains the same chapters in the same order", () => {
    const markdown = toMarkdown({ bible, outline, manuscript });
    const epub = unzip(toEpub(book));
    const docx = decode(unzip(toDocx(book)).get("word/document.xml"));

    for (const title of ["The Drawer", "The Letters"]) {
      expect(markdown).toContain(title);
      expect(decode(epub.get("OEBPS/nav.xhtml"))).toContain(title);
      expect(docx).toContain(title);
    }
    // The chapter with nothing drafted appears in none of them.
    expect(markdown).not.toContain("The Garden");
    expect(decode(epub.get("OEBPS/nav.xhtml"))).not.toContain("The Garden");
    expect(docx).not.toContain("The Garden");
  });
});

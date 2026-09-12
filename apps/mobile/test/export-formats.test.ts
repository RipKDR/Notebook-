import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  FORMAT_EXTENSION,
  FORMAT_LABELS,
  FORMAT_MIME,
  exportFilename,
  safeFilename,
} from "../src/lib/export-formats";

describe("safeFilename", () => {
  it("keeps an ordinary title intact", () => {
    expect(safeFilename("The Kitchen Radio")).toBe("The Kitchen Radio");
  });

  it("replaces path separators", () => {
    // A slash does not produce an odd filename — it produces a write to a
    // directory that does not exist.
    expect(safeFilename("Before/After")).toBe("Before After");
    expect(safeFilename("C:\\Users\\me")).toBe("C Users me");
  });

  it("replaces the characters Windows and share sheets reject", () => {
    expect(safeFilename('a:b*c?d"e<f>g|h')).toBe("a b c d e f g h");
  });

  it("strips control characters", () => {
    expect(safeFilename("Quiet\u0000Room\u001F")).toBe("QuietRoom");
  });

  it("collapses the whitespace its own substitutions create", () => {
    expect(safeFilename("a///b")).toBe("a b");
  });

  it("removes leading dots, which hide the file", () => {
    expect(safeFilename("...hidden")).toBe("hidden");
    expect(safeFilename(".")).toBe("Untitled");
  });

  it("falls back rather than producing an empty name", () => {
    expect(safeFilename("")).toBe("Untitled");
    expect(safeFilename("   ")).toBe("Untitled");
    expect(safeFilename("////")).toBe("Untitled");
  });

  it("caps the length filesystems will accept", () => {
    expect(safeFilename("x".repeat(500)).length).toBe(80);
  });

  it("does not split an astral character at the length boundary", () => {
    const name = safeFilename(`${"x".repeat(79)}😀`);
    expect(name).toBe("x".repeat(79));
    expect(name).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("never ends on a space, which some filesystems silently drop", () => {
    const name = safeFilename("word ".repeat(40));
    expect(name).toBe(name.trim());
  });

  it("keeps characters a title legitimately contains", () => {
    expect(safeFilename("Naïve — a memoir, 1998")).toBe("Naïve — a memoir, 1998");
    expect(safeFilename("Book 😀")).toBe("Book 😀");
  });
});

describe("export formats", () => {
  it("defines a label, a MIME type and an extension for every format", () => {
    for (const format of EXPORT_FORMATS) {
      expect(FORMAT_LABELS[format]).toBeTruthy();
      expect(FORMAT_MIME[format]).toMatch(/^[a-z]+\//);
      expect(FORMAT_EXTENSION[format]).toMatch(/^[a-z]+$/);
    }
  });

  it("builds a filename from the title and the format", () => {
    expect(exportFilename("The Kitchen Radio", "epub")).toBe("The Kitchen Radio.epub");
    expect(exportFilename("The Kitchen Radio", "docx")).toBe("The Kitchen Radio.docx");
    expect(exportFilename("The Kitchen Radio", "markdown")).toBe("The Kitchen Radio.md");
  });

  it("sanitises the title on its way into the filename", () => {
    expect(exportFilename("A/B", "epub")).toBe("A B.epub");
  });
});

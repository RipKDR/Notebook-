import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/cache/sha256.js";
import { stableStringify } from "../src/cache/content-address.js";

const nodeHash = (s: string): string =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("sha256Hex", () => {
  const cases = [
    ["empty", ""],
    ["ascii", "abc"],
    ["sentence", "The quick brown fox jumps over the lazy dog"],
    ["block boundary 55", "a".repeat(55)],
    ["block boundary 56", "a".repeat(56)],
    ["block boundary 64", "a".repeat(64)],
    ["multi-block", "a".repeat(1000)],
    ["accents", "naïve café — résumé"],
    ["cjk", "日本語のテキスト"],
    ["astral emoji", "\u{1F600}\u{1F4DA}"],
    ["lone high surrogate", "\uD83D"],
    ["lone low surrogate", "\uDE00"],
    ["surrogate then text", "\uD83Dhello"],
    ["json", JSON.stringify({ scene: "x", fragments: [1, 2, 3] })],
  ] as const;

  for (const [name, input] of cases) {
    it(`matches node:crypto for ${name}`, () => {
      expect(sha256Hex(input)).toBe(nodeHash(input));
    });
  }

  it("produces 64 hex characters", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stableStringify", () => {
  it("is insensitive to key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("is sensitive to values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("handles nesting and null", () => {
    expect(stableStringify({ z: { y: null, x: [1, { b: 2, a: 1 }] } })).toBe(
      '{"z":{"x":[1,{"a":1,"b":2}],"y":null}}',
    );
  });

  it("drops undefined so optional fields do not perturb a build key", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

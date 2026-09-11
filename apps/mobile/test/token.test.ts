import { describe, expect, it } from "vitest";
import { issueToken, generateSecret } from "../../worker/src/auth.js";
import { isConfigured, normaliseUrl, tierFromToken } from "../src/lib/token";

/**
 * These decode tokens minted by the worker's real issuer, not fixtures. The
 * point is to catch a base64url encoding disagreement between the two sides,
 * which would otherwise surface only as a user's plan displaying wrong.
 */
const secret = generateSecret();

describe("tierFromToken", () => {
  it("reads the tier from a token the worker actually issued", () => {
    expect(tierFromToken(issueToken({ sub: "a", tier: "paid" }, secret))).toBe("paid");
    expect(tierFromToken(issueToken({ sub: "a", tier: "free" }, secret))).toBe("free");
  });

  it("survives a payload whose base64 needs padding", () => {
    // Claim lengths vary, so the encoded payload lands on every padding case.
    for (const sub of ["a", "ab", "abc", "abcd", "abcde", "a".repeat(37)]) {
      expect(tierFromToken(issueToken({ sub, tier: "paid" }, secret))).toBe("paid");
    }
  });

  it("returns null rather than throwing on rubbish", () => {
    for (const bad of ["", "nonsense", "a.b", "...", "%%%", "Zm9v"]) {
      expect(() => tierFromToken(bad)).not.toThrow();
      expect(tierFromToken(bad)).toBeNull();
    }
  });

  it("returns null for no token", () => {
    expect(tierFromToken(null)).toBeNull();
  });
});

describe("normaliseUrl", () => {
  it("strips trailing slashes so paths do not double up", () => {
    expect(normaliseUrl("https://x.example.com/")).toBe("https://x.example.com");
    expect(normaliseUrl("https://x.example.com///")).toBe("https://x.example.com");
  });

  it("trims surrounding whitespace from a pasted address", () => {
    expect(normaliseUrl("  https://x.example.com  ")).toBe("https://x.example.com");
  });

  it("treats blank input as unset", () => {
    expect(normaliseUrl("")).toBeNull();
    expect(normaliseUrl("   ")).toBeNull();
    expect(normaliseUrl(null)).toBeNull();
  });

  it("leaves a path prefix intact", () => {
    expect(normaliseUrl("https://x.example.com/loom/")).toBe("https://x.example.com/loom");
  });
});

describe("isConfigured", () => {
  it("requires both an address and a token", () => {
    expect(isConfigured({ baseUrl: "https://x", token: "t" })).toBe(true);
    expect(isConfigured({ baseUrl: "https://x", token: null })).toBe(false);
    expect(isConfigured({ baseUrl: null, token: "t" })).toBe(false);
    expect(isConfigured({ baseUrl: null, token: null })).toBe(false);
  });
});

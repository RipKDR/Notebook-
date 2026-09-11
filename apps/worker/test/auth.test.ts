import { describe, expect, it } from "vitest";
import { bearerFrom, generateSecret, issueToken, verifyToken } from "../src/auth.js";

const secret = generateSecret();

describe("token verification", () => {
  it("accepts a token it issued", () => {
    const result = verifyToken(issueToken({ sub: "acct-1", tier: "paid" }, secret), secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("acct-1");
      expect(result.claims.tier).toBe("paid");
    }
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueToken({ sub: "acct-1", tier: "paid" }, generateSecret());
    expect(verifyToken(token, secret).ok).toBe(false);
  });

  it("rejects a tier escalated after signing", () => {
    // The whole point: the tier decides how much of our money the caller can
    // spend, so editing the payload must invalidate the signature.
    const token = issueToken({ sub: "acct-1", tier: "free" }, secret);
    const [payload, signature] = token.split(".") as [string, string];

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.tier = "paid";
    const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");

    const result = verifyToken(`${forged}.${signature}`, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Bad signature");
  });

  it("rejects an expired token", () => {
    const token = issueToken({ sub: "a", tier: "free", ttlSeconds: -1 }, secret);
    const result = verifyToken(token, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Token expired");
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "nonsense", "a.b.c", ".", "....", "%%%.%%%"]) {
      expect(() => verifyToken(bad, secret)).not.toThrow();
      expect(verifyToken(bad, secret).ok).toBe(false);
    }
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on unequal lengths; the length check must come first.
    const token = issueToken({ sub: "a", tier: "free" }, secret);
    const [payload] = token.split(".") as [string];
    expect(() => verifyToken(`${payload}.short`, secret)).not.toThrow();
    expect(verifyToken(`${payload}.short`, secret).ok).toBe(false);
  });

  it("parses bearer headers and ignores anything else", () => {
    expect(bearerFrom("Bearer abc123")).toBe("abc123");
    expect(bearerFrom("bearer abc123")).toBe("abc123");
    expect(bearerFrom("Basic abc123")).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
  });
});

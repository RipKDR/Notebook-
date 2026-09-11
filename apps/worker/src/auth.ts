import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer token verification.
 *
 * The tier a caller claims decides how much of our money they may spend, so it
 * cannot be self-asserted. Reading it from an unauthenticated header — which is
 * what this replaced — let anyone send `x-loom-tier: paid` and compile
 * full-length books on our account indefinitely.
 *
 * Tokens are minted by whatever owns billing and signed with a shared secret.
 * This module only verifies; it never issues in the request path. The payload is
 * readable by the client (it is base64, not encryption) — that is fine, because
 * the signature is what makes it trustworthy, and it lets the app show the user
 * their own tier without a round trip.
 */

export interface TokenClaims {
  /** Stable account id. Usage is counted against this. */
  readonly sub: string;
  readonly tier: "free" | "paid";
  /** Unix seconds. */
  readonly exp: number;
  readonly iat: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: TokenClaims }
  | { readonly ok: false; readonly reason: string };

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payload).digest());
}

/** Mints a token. Used by the billing system and by the local dev CLI, never per-request. */
export function issueToken(
  claims: Omit<TokenClaims, "iat" | "exp"> & { ttlSeconds?: number },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenClaims = {
    sub: claims.sub,
    tier: claims.tier,
    iat: now,
    exp: now + (claims.ttlSeconds ?? 30 * 24 * 60 * 60),
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyToken(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "Malformed token" };

  const [encoded, signature] = parts as [string, string];
  const expected = sign(encoded, secret);

  // Compare in constant time. A length mismatch is itself a rejection —
  // timingSafeEqual throws on unequal lengths rather than returning false.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Bad signature" };
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(encoded).toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "Unreadable claims" };
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, reason: "Missing subject" };
  }
  if (claims.tier !== "free" && claims.tier !== "paid") {
    return { ok: false, reason: "Unknown tier" };
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    return { ok: false, reason: "Token expired" };
  }
  return { ok: true, claims };
}

/** Extracts a bearer token from an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

/** Generates a secret for local development. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

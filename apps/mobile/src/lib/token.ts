/**
 * Pure helpers for worker settings.
 *
 * Deliberately free of React and Expo imports so they can be tested on plain
 * Node. Token decoding in particular is worth real coverage: it has to agree
 * byte-for-byte with the worker's base64url encoding, and a mismatch would show
 * up only as a user's plan silently displaying wrong.
 */

export interface WorkerSettingsShape {
  readonly baseUrl: string | null;
  readonly token: string | null;
}

/** Trims trailing slashes so paths concatenate to one slash, not two. */
export function normaliseUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length === 0 ? null : trimmed;
}

export function isConfigured(
  s: WorkerSettingsShape,
): s is { baseUrl: string; token: string } {
  return s.baseUrl !== null && s.token !== null;
}

/**
 * Reads the tier out of a token's claims, for display only.
 *
 * The payload is base64, not encryption — the worker's HMAC signature is what
 * makes it authoritative, and the worker re-verifies on every request. Reading
 * it here only saves a round trip to tell a user which plan they are on; nothing
 * is trusted on the strength of it.
 */
export function tierFromToken(token: string | null): "free" | "paid" | null {
  if (token === null) return null;
  const payload = token.split(".")[0];
  if (payload === undefined || payload.length === 0) return null;

  try {
    const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const claims = JSON.parse(json) as { tier?: unknown };
    if (claims.tier === "paid") return "paid";
    if (claims.tier === "free") return "free";
    return null;
  } catch {
    return null;
  }
}

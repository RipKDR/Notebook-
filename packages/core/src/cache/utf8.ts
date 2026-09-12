/**
 * UTF-8 encoding that behaves identically everywhere we run.
 *
 * `TextEncoder` is not guaranteed on Hermes, which is the same reason
 * `sha256.ts` next door hashes by hand. Two places now need bytes from a string
 * — the build key and the export writer — so the encoder lives here rather than
 * being written twice with a chance of disagreeing.
 *
 * `TextEncoder` is used when the runtime has one, because it is native and this
 * runs over a whole book's worth of text. The fallback matches it byte for byte,
 * including how it handles text that is not valid Unicode.
 */

/**
 * U+FFFD, the replacement character. Unpaired surrogates are not valid Unicode
 * scalars and cannot be encoded as UTF-8. WHATWG (and therefore Node's Buffer,
 * TextEncoder and every browser) substitutes U+FFFD instead. We match that
 * exactly: a note truncated mid-emoji must hash identically on the phone and in
 * the worker, or the scene would rebuild forever on one of them and never on the
 * other.
 */
const REPLACEMENT = [0xef, 0xbf, 0xbd] as const;

const native: { encode(input: string): Uint8Array } | null =
  typeof TextEncoder === "function" ? new TextEncoder() : null;

export function utf8Bytes(str: string): Uint8Array {
  return native !== null ? native.encode(str) : encodeByHand(str);
}

/** The portable path. Exported so a test can hold it against `TextEncoder`. */
export function encodeByHand(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate. Pair it if we can; otherwise it is an unpaired surrogate.
      const lo = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
      } else {
        out.push(...REPLACEMENT);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // Unpaired low surrogate.
      out.push(...REPLACEMENT);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

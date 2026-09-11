/**
 * Vector maths, in plain JavaScript.
 *
 * A working notebook is a few thousand fragments, not a few million. At that
 * scale an exhaustive cosine scan over Float32Arrays takes single-digit
 * milliseconds on a phone — far below the threshold where a native index,
 * an extra build dependency and a second copy of the data would earn their keep.
 *
 * Vectors are stored unit-normalised, so cosine similarity is a dot product.
 */

export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const mag = Math.sqrt(sum);
  if (mag === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / mag;
  return out;
}

/** Dot product. Correct as cosine similarity only for unit-normalised inputs. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  return dot(normalise(a), normalise(b));
}

export function centroid(vectors: readonly Float32Array[]): Float32Array {
  const first = vectors[0];
  if (first === undefined) throw new RangeError("Cannot take the centroid of zero vectors");
  const out = new Float32Array(first.length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + v[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / vectors.length;
  return normalise(out);
}

export interface Scored<T> {
  readonly item: T;
  readonly score: number;
}

/** Top-k by similarity to `query`. Uses a bounded insert rather than sorting the whole corpus. */
export function topK<T>(
  query: Float32Array,
  items: readonly T[],
  vectorOf: (item: T) => Float32Array | null,
  k: number,
): Scored<T>[] {
  const best: Scored<T>[] = [];
  for (const item of items) {
    const v = vectorOf(item);
    if (v === null) continue;
    const score = dot(query, v);

    if (best.length < k) {
      best.push({ item, score });
      best.sort((a, b) => b.score - a.score);
    } else if (score > best[best.length - 1]!.score) {
      best[best.length - 1] = { item, score };
      best.sort((a, b) => b.score - a.score);
    }
  }
  return best;
}

/** Serialisation for SQLite BLOB columns. Little-endian, matching every platform we target. */
export function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  // Copy rather than aliasing: SQLite buffers may not be 4-byte aligned, and a
  // misaligned Float32Array view throws on some engines.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

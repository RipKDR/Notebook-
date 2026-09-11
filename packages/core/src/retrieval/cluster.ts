import type { Fragment } from "../types/fragment.js";
import type { ConstellationId, FragmentId } from "../types/ids.js";
import { asConstellationId, newId } from "../types/ids.js";
import { centroid, dot } from "./vector.js";

/**
 * Constellations: the stage that turns 800 unrelated notes into ~15 candidate
 * books.
 *
 * This is the product's first magic moment. The user has been dropping sentences
 * into a box for months with no sense of shape; this is the screen that says
 * "these fifty-three notes are about your father, and they're a book."
 *
 * Semantic similarity alone is not enough for that. Two notes about the same
 * person in different registers embed far apart, while two unrelated notes in the
 * same register embed close together. So similarity here is a blend: embedding
 * proximity, plus shared named entities (the strongest signal that two fragments
 * belong to the same work), plus shared themes.
 */

export interface Constellation {
  readonly id: ConstellationId;
  readonly fragmentIds: readonly FragmentId[];
  /** Mean embedding, for retrieval against the cluster. */
  readonly centroid: Float32Array | null;
  /** Entities appearing in at least a quarter of members, most frequent first. */
  readonly dominantEntities: readonly string[];
  readonly dominantThemes: readonly string[];
  /** Mean pairwise similarity inside the cluster. Low = a weak, probably spurious grouping. */
  readonly cohesion: number;
  /** Total words across members — the honest signal of whether this is book-sized. */
  readonly wordCount: number;
}

export interface ClusterOptions {
  /** Stop merging below this blended similarity. Higher = more, tighter clusters. */
  readonly mergeThreshold?: number;
  /** Clusters smaller than this are dissolved and their members returned as loose. */
  readonly minSize?: number;
  readonly maxClusters?: number;
  /** Weight of shared entities relative to embedding proximity. */
  readonly entityWeight?: number;
  readonly themeWeight?: number;
  /**
   * Above this corpus size we subsample for the distance matrix rather than
   * allocating an N² matrix. 2,500 fragments is ~25MB and a second or two of
   * work in the compile worker; beyond that the cost stops being worth it.
   */
  readonly exactLimit?: number;
}

const DEFAULTS = {
  mergeThreshold: 0.42,
  minSize: 3,
  maxClusters: 24,
  entityWeight: 0.35,
  themeWeight: 0.15,
  exactLimit: 2500,
} as const;

export interface ClusterResult {
  readonly constellations: readonly Constellation[];
  /** Fragments that did not join any cluster. Still shown to the user — never discarded. */
  readonly loose: readonly FragmentId[];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

interface Prepared {
  readonly fragment: Fragment;
  readonly entities: Set<string>;
  readonly themes: Set<string>;
}

function prepare(f: Fragment): Prepared {
  return {
    fragment: f,
    entities: new Set((f.enrichment?.entities ?? []).map((e) => e.entityId as string)),
    themes: new Set((f.enrichment?.themes ?? []).map((t) => t.toLowerCase())),
  };
}

/**
 * Blended similarity in [0, 1].
 *
 * Entity overlap is weighted heavily and deliberately: if two fragments both
 * mention the same grandmother, they belong together regardless of what the
 * embedding thinks.
 */
function similarity(a: Prepared, b: Prepared, opts: Required<ClusterOptions>): number {
  const va = a.fragment.embedding;
  const vb = b.fragment.embedding;
  const semantic = va !== null && vb !== null ? Math.max(0, dot(va, vb)) : 0;
  const entity = jaccard(a.entities, b.entities);
  const theme = jaccard(a.themes, b.themes);

  const base = 1 - opts.entityWeight - opts.themeWeight;
  return base * semantic + opts.entityWeight * entity + opts.themeWeight * theme;
}

/**
 * Average-linkage agglomerative clustering.
 *
 * Average linkage (rather than single or complete) because single linkage
 * chains — one ambiguous note bridges two unrelated works into a mush — and
 * complete linkage shatters legitimately broad themes. Distances are updated
 * with the Lance-Williams formula so merges cost O(n) instead of a full
 * recomputation from points.
 */
export function clusterFragments(
  fragments: readonly Fragment[],
  options: ClusterOptions = {},
): ClusterResult {
  const opts: Required<ClusterOptions> = { ...DEFAULTS, ...options };

  const usable = fragments.filter((f) => f.deletedAt === null && f.text.trim().length > 0);
  if (usable.length === 0) return { constellations: [], loose: [] };
  if (usable.length < opts.minSize) {
    return { constellations: [], loose: usable.map((f) => f.id) };
  }

  // Guard the N² allocation. Beyond the limit we cluster the most recent
  // `exactLimit` fragments and return the remainder as loose, rather than
  // stalling the worker on a matrix nobody asked for.
  const inScope =
    usable.length <= opts.exactLimit
      ? usable
      : [...usable].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, opts.exactLimit);
  const inScopeIds = new Set(inScope.map((f) => f.id));
  const overflow = usable.filter((f) => !inScopeIds.has(f.id)).map((f) => f.id);

  const prepared = inScope.map(prepare);
  const n = prepared.length;

  // Upper-triangular similarity matrix, flattened.
  const sim = new Float32Array((n * (n - 1)) / 2);
  const idx = (i: number, j: number): number => {
    const [lo, hi] = i < j ? [i, j] : [j, i];
    return (lo * (2 * n - lo - 1)) / 2 + (hi - lo - 1);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sim[idx(i, j)] = similarity(prepared[i]!, prepared[j]!, opts);
    }
  }

  // Active clusters, each a list of member indices.
  const members: number[][] = prepared.map((_, i) => [i]);
  const alive = new Array<boolean>(n).fill(true);
  let aliveCount = n;

  while (aliveCount > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const s = sim[idx(i, j)]!;
        if (s > bestScore) {
          bestScore = s;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI < 0 || bestScore < opts.mergeThreshold) break;

    // Lance-Williams average linkage: the merged cluster's similarity to every
    // other cluster is the size-weighted mean of its parents'.
    const sizeI = members[bestI]!.length;
    const sizeJ = members[bestJ]!.length;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bestI || k === bestJ) continue;
      const merged = (sizeI * sim[idx(bestI, k)]! + sizeJ * sim[idx(bestJ, k)]!) / (sizeI + sizeJ);
      sim[idx(bestI, k)] = merged;
    }

    members[bestI] = [...members[bestI]!, ...members[bestJ]!];
    members[bestJ] = [];
    alive[bestJ] = false;
    aliveCount--;
  }

  const loose: FragmentId[] = [...overflow];
  const built: Constellation[] = [];

  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const group = members[i]!;
    if (group.length < opts.minSize) {
      for (const m of group) loose.push(prepared[m]!.fragment.id);
      continue;
    }
    built.push(buildConstellation(group.map((m) => prepared[m]!), sim, idx, group));
  }

  // Largest first — the user should see their most substantial thread at the top.
  built.sort((a, b) => b.wordCount - a.wordCount);

  const kept = built.slice(0, opts.maxClusters);
  for (const dropped of built.slice(opts.maxClusters)) {
    loose.push(...dropped.fragmentIds);
  }

  return { constellations: kept, loose };
}

function buildConstellation(
  group: readonly Prepared[],
  sim: Float32Array,
  idx: (i: number, j: number) => number,
  indices: readonly number[],
): Constellation {
  const vectors = group
    .map((p) => p.fragment.embedding)
    .filter((v): v is Float32Array => v !== null);

  const entityCounts = new Map<string, number>();
  const themeCounts = new Map<string, number>();
  for (const p of group) {
    for (const e of p.entities) entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
    for (const t of p.themes) themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
  }

  const threshold = Math.max(2, Math.ceil(group.length * 0.25));
  const dominant = (counts: Map<string, number>): string[] =>
    [...counts.entries()]
      .filter(([, c]) => c >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);

  // Mean pairwise similarity over the original (pre-merge) pairs.
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      sum += sim[idx(indices[a]!, indices[b]!)]!;
      pairs++;
    }
  }

  return {
    id: asConstellationId(newId()),
    fragmentIds: group.map((p) => p.fragment.id),
    centroid: vectors.length > 0 ? centroid(vectors) : null,
    dominantEntities: dominant(entityCounts),
    dominantThemes: dominant(themeCounts),
    cohesion: pairs > 0 ? sum / pairs : 0,
    wordCount: group.reduce(
      (n, p) => n + p.fragment.text.trim().split(/\s+/).filter(Boolean).length,
      0,
    ),
  };
}

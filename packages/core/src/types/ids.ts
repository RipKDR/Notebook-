/**
 * Branded ID types. These are compile-time only — at runtime they are strings —
 * but they stop you passing a FragmentId where a SceneId is expected, which is
 * the single most common bug class in a pipeline that threads IDs through
 * eight stages.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type FragmentId = Brand<string, "FragmentId">;
export type ConstellationId = Brand<string, "ConstellationId">;
export type BibleId = Brand<string, "BibleId">;
export type OutlineId = Brand<string, "OutlineId">;
export type ChapterId = Brand<string, "ChapterId">;
export type SceneId = Brand<string, "SceneId">;
export type EntityId = Brand<string, "EntityId">;
export type CompileId = Brand<string, "CompileId">;

export const asProjectId = (s: string): ProjectId => s as ProjectId;
export const asFragmentId = (s: string): FragmentId => s as FragmentId;
export const asConstellationId = (s: string): ConstellationId => s as ConstellationId;
export const asBibleId = (s: string): BibleId => s as BibleId;
export const asOutlineId = (s: string): OutlineId => s as OutlineId;
export const asChapterId = (s: string): ChapterId => s as ChapterId;
export const asSceneId = (s: string): SceneId => s as SceneId;
export const asEntityId = (s: string): EntityId => s as EntityId;
export const asCompileId = (s: string): CompileId => s as CompileId;

/**
 * Monotonic, sortable, collision-resistant ID. ULID-shaped (Crockford base32,
 * 48-bit timestamp + 80 bits of randomness) so IDs sort by creation time — which
 * matters because fragments are append-heavy and we replay them in order.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(now: number = Date.now(), random: () => number = Math.random): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[Math.floor(random() * 32)]!;
  }
  return ts + rand;
}

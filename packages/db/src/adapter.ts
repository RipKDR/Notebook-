/**
 * The SQLite adapter boundary.
 *
 * The same schema and the same queries have to run in two very different
 * places: `expo-sqlite` on the phone, where everything is async, and a Node
 * driver in the compile worker, where everything is sync. Rather than writing
 * the data layer twice, everything above this interface is written once against
 * the async shape — which is the superset — and each platform supplies a small
 * adapter.
 *
 * Keeping this boundary narrow is deliberate. It is four methods, and that is
 * what makes "works offline on the phone, and also in the worker" a property of
 * the whole data layer rather than a claim we have to re-verify per feature.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface SqlAdapter {
  /** Runs one or more statements for their side effects. Used by migrations. */
  exec(sql: string): Promise<void>;
  /** Runs a parameterised statement, returning rows affected. */
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  /**
   * Runs `fn` inside a transaction, rolling back if it throws.
   *
   * Correctness here is not optional: a fragment write that half-lands leaves a
   * note in the search index that no longer exists in the table, and the user
   * loses writing they believe they saved.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

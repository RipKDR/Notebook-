import type { Fragment, FragmentId, Project, ProjectId } from "@loom/core";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "./provider";

/**
 * Data access hooks.
 *
 * Deliberately plain: `useState` + `useEffect` over the local database rather
 * than a caching query library. Every read here is a local SQLite call measured
 * in single-digit milliseconds, so there is no network latency for a cache to
 * hide — and a stale-while-revalidate layer over a source of truth this fast
 * mostly buys you bugs where the user's newest note takes a moment to appear.
 */

interface AsyncState<T> {
  readonly data: T;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly reload: () => void;
}

function useQuery<T>(run: () => Promise<T>, initial: T, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void run()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `run` is recreated every render by design; deps are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export function useFragments(opts: { projectId?: ProjectId | null; limit?: number } = {}) {
  const { db, revision } = useDatabase();
  return useQuery<Fragment[]>(() => db.listFragments(opts), [], [
    revision,
    opts.projectId,
    opts.limit,
  ]);
}

export function useFragment(id: FragmentId | null) {
  const { db, revision } = useDatabase();
  return useQuery<Fragment | null>(
    () => (id === null ? Promise.resolve(null) : db.getFragment(id)),
    null,
    [revision, id],
  );
}

export function useSearch(query: string) {
  const { db, revision } = useDatabase();
  const trimmed = query.trim();
  return useQuery<Fragment[]>(
    () => (trimmed.length === 0 ? Promise.resolve([]) : db.search(trimmed)),
    [],
    [revision, trimmed],
  );
}

export function useProjects() {
  const { db, revision } = useDatabase();
  return useQuery<Project[]>(() => db.listProjects(), [], [revision]);
}

export function useCounts() {
  const { db, revision } = useDatabase();
  return useQuery(() => db.countFragments(), { total: 0, enriched: 0, words: 0 }, [revision]);
}

/** Capture, with the revision bump that refreshes every list on screen. */
export function useCapture() {
  const { db, touch } = useDatabase();
  return useCallback(
    async (text: string, source: Parameters<typeof db.capture>[1] = "quick") => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return null;
      const fragment = await db.capture(trimmed, source);
      touch();
      return fragment;
    },
    [db, touch],
  );
}

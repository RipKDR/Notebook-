import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useDatabase } from "@/db/provider";
import { Indexer, type EnrichmentResult } from "./enrichment";
import { isConfigured, useSettings } from "./settings";

/**
 * Runs the indexer when the app becomes active, and on demand.
 *
 * Foregrounding is the right trigger: it is when a user is about to look at
 * Threads, and it is a moment the OS already permits work. A timer would drain
 * battery indexing notes nobody is about to read.
 */
export function useIndexer(): {
  run: () => Promise<EnrichmentResult | null>;
  running: boolean;
  lastResult: EnrichmentResult | null;
} {
  const { db, touch } = useDatabase();
  const { settings } = useSettings();
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<EnrichmentResult | null>(null);

  // Read settings through a ref so the indexer instance survives a settings
  // change without being rebuilt mid-run.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const indexer = useMemo(
    () =>
      new Indexer(db, () => {
        const current = settingsRef.current;
        return isConfigured(current)
          ? { baseUrl: current.baseUrl, token: current.token }
          : null;
      }),
    [db],
  );

  const run = useCallback(async () => {
    if (indexer.isRunning) return null;
    setRunning(true);
    try {
      const result = await indexer.run();
      setLastResult(result);
      if (result.indexed > 0) touch();
      return result;
    } finally {
      setRunning(false);
    }
  }, [indexer, touch]);

  useEffect(() => {
    if (AppState.currentState === "active") void run();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => subscription.remove();
  }, [run]);

  return { run, running, lastResult };
}

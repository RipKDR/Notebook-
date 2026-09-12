import {
  SYNC_PROTOCOL_VERSION,
  sync as runSync,
  type SyncOutcome,
  type SyncRequest,
  type SyncResponse,
} from "@loom/core";
import type { LoomDatabase } from "@loom/db";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDatabase } from "@/db/provider";
import { ApiError, type ApiConfig } from "./api";
import { isConfigured, useSettings } from "./settings";
import { bindAppStateSync } from "./sync-app-state";

/**
 * Cloud sync, from the app's side.
 *
 * The merge itself lives in `@loom/core` behind injected ports, so what is left
 * here is the two things that are genuinely the app's: where the request goes,
 * and what the user is told when it does not work.
 *
 * Sync is never on the capture path. The local database is the source of truth
 * and the app is fully functional with the network permanently off; a note is
 * saved the instant it is typed, whether or not anything reaches a server.
 */

export type SyncPhase =
  | { phase: "idle" }
  | { phase: "syncing" }
  | { phase: "done"; outcome: SyncOutcome; at: number }
  | { phase: "off"; reason: string }
  | { phase: "failed"; error: string };

export class SyncDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncDisabledError";
  }
}

/** Posts one round trip. The engine decides how many rounds there are. */
export function transportFor(config: ApiConfig) {
  return async (request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> => {
    const response = await fetch(`${config.baseUrl}/v1/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token !== undefined ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(request),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (response.status === 402) {
      // Not a failure to retry. The account is not entitled to sync, and saying
      // so plainly is better than a spinner that never resolves.
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new SyncDisabledError(
        detail?.error ?? "Cloud sync is part of the paid plan. Your writing stays on your device.",
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ApiError(text.slice(0, 400) || `Sync failed with ${response.status}`, response.status);
    }

    const payload = (await response.json()) as SyncResponse;
    if (payload.protocol !== SYNC_PROTOCOL_VERSION) {
      throw new ApiError(
        `This app speaks sync protocol ${SYNC_PROTOCOL_VERSION}; the server speaks ${payload.protocol}. Update the app.`,
        409,
      );
    }
    return payload;
  };
}

export async function syncNow(
  db: LoomDatabase,
  config: ApiConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<SyncOutcome> {
  return runSync({
    local: db,
    transport: transportFor(config),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * Runs sync when the app comes to the foreground, and on demand.
 *
 * Foregrounding rather than a timer, for the same reason the indexer uses it: it
 * is a moment the OS already permits work, and it is when the user is about to
 * look at their notes. And deliberately not on every save — capture must stay a
 * local write with nothing attached to it, and a notebook that syncs when the
 * app opens is indistinguishable from one that syncs constantly, except in
 * battery and in how often a flaky connection can manufacture a conflict.
 */
interface SyncController {
  readonly status: SyncPhase;
  readonly sync: () => Promise<SyncOutcome | null>;
}

const SyncContext = createContext<SyncController | null>(null);

/** Owns the one synchronization lane for a database and its foreground listener. */
export function SyncProvider({ children }: { children: ReactNode }): ReactNode {
  const { db, touch } = useDatabase();
  const { settings } = useSettings();
  const [status, setStatus] = useState<SyncPhase>({ phase: "idle" });
  const running = useRef(false);
  const runRef = useRef<() => Promise<SyncOutcome | null>>(async () => null);

  const run = useCallback(async (): Promise<SyncOutcome | null> => {
    if (running.current) return null;
    if (!isConfigured(settings)) {
      setStatus({ phase: "off", reason: "No compile service configured." });
      return null;
    }

    running.current = true;
    setStatus({ phase: "syncing" });
    try {
      const outcome = await syncNow(db, { baseUrl: settings.baseUrl, token: settings.token });
      setStatus({ phase: "done", outcome, at: Date.now() });
      // Anything that arrived has to reach the screens showing it.
      if (outcome.pulled > 0 || outcome.conflicts > 0) touch();
      return outcome;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Sync failed for a reason we could not read.";
      setStatus(
        err instanceof SyncDisabledError
          ? { phase: "off", reason: message }
          : { phase: "failed", error: message },
      );
      // The failure is recorded locally so it can be shown later rather than
      // vanishing with this component.
      await db.setSyncCursor((await db.syncState()).cursor, message).catch(() => undefined);
      return null;
    } finally {
      running.current = false;
    }
  }, [db, settings, touch]);

  runRef.current = run;

  useEffect(() => {
    return bindAppStateSync(() => {
      void runRef.current();
    }, true);
  }, []);

  return createElement(SyncContext.Provider, { value: { status, sync: run } }, children);
}

export function useSync(): SyncController {
  const controller = useContext(SyncContext);
  if (controller === null) throw new Error("useSync must be used inside a SyncProvider");
  return controller;
}

import { useSync } from "@/lib/sync";

/**
 * Consumes the app-lifetime sync controller.
 *
 * The provider owns foreground events and mutual exclusion; this component
 * deliberately has no second listener or status. Nothing in capture waits on
 * it — the local database is the source of truth.
 */
export function BackgroundSync(): null {
  // The provider owns the listener and mutex; this component only asserts that
  // the app-lifetime controller is mounted alongside the other background work.
  useSync();
  return null;
}

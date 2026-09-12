import { useSync } from "@/lib/sync";

/**
 * Mounts sync for the lifetime of the app.
 *
 * It renders nothing, for the same reason `BackgroundIndexer` does not: sync has
 * to be driven by something that is always alive, and a hook needs a component
 * to live in. Nothing in capture waits on it — the local database is the source
 * of truth, and a note is saved whether or not this ever reaches a server.
 */
export function BackgroundSync(): null {
  useSync();
  return null;
}

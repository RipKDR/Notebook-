import { useIndexer } from "@/lib/use-indexer";

/**
 * Mounts the indexer for the lifetime of the app.
 *
 * It renders nothing. It exists because indexing has to be driven by something
 * that is always alive, and a hook needs a component to live in — without this,
 * fragments are captured and then never read, so Threads has nothing to show.
 */
export function BackgroundIndexer(): null {
  useIndexer();
  return null;
}

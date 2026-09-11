/**
 * Human-facing formatting.
 *
 * These are small, and they are the difference between an app that feels made
 * and one that feels generated. "3m ago" beats a timestamp; "48,120 words" beats
 * 48120.
 */

export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function formatWords(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** At 250 words per minute, the conventional figure for adult prose reading. */
export function readingTime(words: number): string {
  const minutes = Math.round(words / 250);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min read`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h read` : `${hours}h ${rest}m read`;
}

/** Book-length progress, expressed against a real target rather than a vibe. */
export function lengthDescriptor(words: number): string {
  if (words < 1_000) return "a handful of notes";
  if (words < 7_500) return "a short story's worth";
  if (words < 20_000) return "a novelette's worth";
  if (words < 40_000) return "a novella's worth";
  if (words < 80_000) return "most of a novel";
  return "a full novel's worth";
}

export function pluralise(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

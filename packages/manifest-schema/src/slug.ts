/**
 * Turn a display name into a slug that satisfies {@link SLUG_RE} — the one
 * ruleset every user-defined slug (triggers, sandboxes, apps, connectors)
 * already follows.
 *
 * Shared deliberately: every surface that derives a folder/slug from a
 * user-entered name must derive the SAME value, or a preview lies about what
 * will be created. Kept dependency-free next to `SLUG_RE` (same rationale as
 * `constants.ts`).
 */

/** Longest slug SLUG_RE accepts: one leading alphanumeric plus 127 more. */
const SLUG_MAX_LENGTH = 128;

export function slugifySlug(title: string, fallback: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    // SLUG_RE's first character must be a letter or digit, so leading
    // separators (`_foo`, `--x`) are dropped, not just dashes.
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, SLUG_MAX_LENGTH)
    // The cap can end mid-run: a 130-character name keeps its first 128
    // characters, and a trailing separator would break SLUG_RE's tail.
    .replace(/[._-]+$/, '');
  return slug || fallback;
}

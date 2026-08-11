/**
 * Default titles for a brand-new session ("New session - <date>" and the
 * historical Veyris "New agent").
 * It is NOT a real title: OpenCode stamps it before its summarizer produces the
 * real one, and if it were persisted as `metadata.name` it would freeze junk
 * into the sidebar. Session titles are now dosco-owned (see
 * session-title-generate.ts), but historic rows may still carry this frozen
 * placeholder, so the serializer nulls it at read time. Shared predicate used by
 * the serializer and the title generator.
 */
export function isPlaceholderOpencodeTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && /^new (?:session|agent)\b/i.test(title.trim());
}

/**
 * POSIX-regex twin of `isPlaceholderOpencodeTitle`, for the compare-and-set
 * predicate in the title UPDATE (`trim(metadata->>'name') ~* pattern`).
 * `[^[:alnum:]_]` is the POSIX spelling of JavaScript's `\b` word boundary.
 * Kept in lockstep by unit test.
 */
export const PLACEHOLDER_TITLE_SQL_PATTERN = '^new (session|agent)([^[:alnum:]_]|$)';

/**
 * The runtime's own title for a session's canonical ROOT conversation, read
 * from the `metadata.opencode_sessions` snapshot (opencode-session-snapshot.ts).
 *
 * This is a READ-time preference, not a second title writer: `metadata.name`
 * stays owned solely by session-title-generate.ts. The snapshot mirrors what
 * OpenCode's in-sandbox summarizer produced — the string the session header
 * already shows live — so session reads resolve the same title the header
 * does instead of drifting to the first-prompt-derived generated name.
 *
 * The root entry is matched by the pinned root id first (`opencode_session_id`),
 * then by the parentless entry of the scoped tree. Placeholder and blank titles
 * read as absent so callers fall through to the generated name.
 */
export function runtimeRootTitleFromSnapshot(
  snapshot: unknown,
  pinnedRootId: string | null,
): string | null {
  if (!Array.isArray(snapshot)) return null;
  const entries = snapshot.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
  );
  const root =
    (pinnedRootId && entries.find((entry) => entry.id === pinnedRootId)) ||
    entries.find((entry) => {
      const parent = entry.parent_id;
      return parent === null || parent === undefined || parent === '';
    });
  const title = typeof root?.title === 'string' ? root.title.trim() : '';
  if (!title || isPlaceholderOpencodeTitle(title)) return null;
  return title;
}

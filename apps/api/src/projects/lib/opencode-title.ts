/**
 * OpenCode's default title for a brand-new session ("New session - <date>").
 * It is NOT a real title: OpenCode stamps it before its summarizer produces the
 * real one, and if it were persisted as `metadata.name` it would freeze junk
 * into the sidebar. Session titles are now Kortix-owned (see
 * session-title-generate.ts), but historic rows may still carry this frozen
 * placeholder, so the serializer nulls it at read time. Shared predicate used by
 * the serializer and the title generator.
 */
export function isPlaceholderOpencodeTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && /^new session\b/i.test(title.trim());
}

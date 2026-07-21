import { projectSessions } from '@kortix/db';
import type { Database } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

/**
 * ACP title sync — the write path for `project_sessions.metadata.name` (the
 * auto title `serializeSession` mirrors as `name`/`custom_name` unset — see
 * `lib/serializers.ts`) fed by two origins, cheapest-correct first:
 *
 *   1. HARNESS  — claude-agent-acp's `session_info_update` notification
 *      carries a real `{title, updatedAt}` (see `extractHarnessSessionTitle`
 *      in `./acp-envelope.ts` for the per-harness evidence). Authoritative
 *      whenever it arrives; last-write-wins on `updatedAt` so an out-of-order
 *      SSE delivery can never regress an already-applied newer title.
 *   2. FALLBACK — for harnesses that never emit one (codex, pi, opencode),
 *      the first user prompt's text, truncated, applied exactly once (only
 *      while the row has no title yet at all).
 *
 * A user rename (`metadata.custom_name`, set by the session PATCH route —
 * `routes/r7.ts`) is authoritative over BOTH and is never touched or
 * overwritten by either path here — checked first, unconditionally.
 *
 * `metadata.title_source` ('harness' | 'fallback') plus
 * `metadata.title_updated_at` (harness path only) are the bookkeeping this
 * module owns to make the harness path idempotent without a second table.
 */

type SessionTitleMetadata = Record<string, unknown> & {
  custom_name?: string;
  name?: string;
  title_source?: 'harness' | 'fallback';
  title_updated_at?: string;
};

export type PersistAcpSessionTitleDeps = {
  db: Database;
};

function scopedWhere(projectSessionId: string, projectId: string) {
  return and(
    eq(projectSessions.sessionId, projectSessionId),
    eq(projectSessions.projectId, projectId),
  );
}

async function loadMetadata(
  db: Database,
  projectSessionId: string,
  projectId: string,
): Promise<SessionTitleMetadata> {
  const [current] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(scopedWhere(projectSessionId, projectId))
    .limit(1);
  return ((current?.metadata as SessionTitleMetadata | null) ?? {}) as SessionTitleMetadata;
}

/**
 * Applies a harness-emitted title. No-op when:
 *   - the session has a user-set custom name (`metadata.custom_name`), or
 *   - the stored title already came from the harness AND its
 *     `title_updated_at` is >= this update's `updatedAt` (both parseable) —
 *     the idempotent / last-write-wins guard against out-of-order SSE
 *     delivery re-applying (or regressing) a title that already landed.
 *
 * A fallback-sourced title (or no title at all) is always overwritten — the
 * harness title is strictly more authoritative than the first-prompt guess.
 */
export async function persistHarnessSessionTitle(
  deps: PersistAcpSessionTitleDeps,
  input: { projectSessionId: string; projectId: string; title: string; updatedAt: string | null },
): Promise<boolean> {
  const { db } = deps;
  const metadata = await loadMetadata(db, input.projectSessionId, input.projectId);
  if (typeof metadata.custom_name === 'string' && metadata.custom_name.trim()) return false;

  if (metadata.title_source === 'harness' && metadata.title_updated_at && input.updatedAt) {
    const stored = Date.parse(metadata.title_updated_at);
    const incoming = Date.parse(input.updatedAt);
    if (Number.isFinite(stored) && Number.isFinite(incoming) && stored >= incoming) return false;
  }

  const { title_updated_at: _staleTitleUpdatedAt, ...restMetadata } = metadata;
  const nextMetadata: SessionTitleMetadata = {
    ...restMetadata,
    name: input.title,
    title_source: 'harness',
    ...(input.updatedAt ? { title_updated_at: input.updatedAt } : {}),
  };

  await db.update(projectSessions).set({
    metadata: nextMetadata,
    updatedAt: new Date(),
  }).where(scopedWhere(input.projectSessionId, input.projectId));
  return true;
}

/**
 * Applies the first-prompt fallback title. Fires at most once per session in
 * effect: a no-op the instant the row already has ANY title (harness or an
 * earlier fallback) or a user-set custom name — callers may call this on
 * every `session/prompt` with no extra bookkeeping.
 */
export async function persistFallbackSessionTitle(
  deps: PersistAcpSessionTitleDeps,
  input: { projectSessionId: string; projectId: string; title: string },
): Promise<boolean> {
  const { db } = deps;
  const metadata = await loadMetadata(db, input.projectSessionId, input.projectId);
  if (typeof metadata.custom_name === 'string' && metadata.custom_name.trim()) return false;
  if (typeof metadata.name === 'string' && metadata.name.trim()) return false;

  const nextMetadata: SessionTitleMetadata = {
    ...metadata,
    name: input.title,
    title_source: 'fallback',
  };

  await db.update(projectSessions).set({
    metadata: nextMetadata,
    updatedAt: new Date(),
  }).where(scopedWhere(input.projectSessionId, input.projectId));
  return true;
}

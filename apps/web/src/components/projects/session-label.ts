import type { ProjectOpenCodeSession, ProjectSession } from '@/lib/projects-client';

/**
 * Canonical helpers for resolving a project session's display label and its
 * opencode session tree. Single source of truth — the sidebar, the session
 * list, and the tab bar must all render the SAME name for a session.
 */

/** The root opencode session a project session is pinned to (if synced). */
export function rootOpenCodeSession(session: ProjectSession): ProjectOpenCodeSession | null {
  const opencodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) return opencodeSessions.find((item) => item.id === rootId) ?? null;
  return opencodeSessions.find((item) => !item.parent_id) ?? null;
}

/** Direct, non-archived children of the root opencode session, newest first. */
export function directSubsessions(session: ProjectSession): ProjectOpenCodeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/**
 * Human display label for a session. Precedence: the user-set rename
 * (custom_name) is AUTHORITATIVE and always wins — even over the live
 * opencode root title (which keeps serving the auto title after a rename).
 * Then: live opencode root title → resolved name (synced auto-title) →
 * legacy metadata.session_name → branch slice → short id.
 */
export function sessionDisplayLabel(session: ProjectSession): string {
  const metadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const fallback = session.branch_name
    ? session.branch_name.slice(0, 14)
    : session.session_id.slice(0, 8);
  return (
    session.custom_name?.trim() ||
    rootOpenCodeSession(session)?.title?.trim() ||
    session.name?.trim() ||
    metadataName?.trim() ||
    fallback
  );
}

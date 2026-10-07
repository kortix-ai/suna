/**
 * A project session's conversation tree: its root conversation in the
 * session runtime and the subagent children under it. The API serves the
 * tree as `runtime_sessions` (read from the runtime projection); older API
 * builds send only `opencode_sessions`, so every reader goes through these.
 */
import type { ProjectRuntimeSession, ProjectSession } from '../rest/projects-client/sessions';

type SessionTree = Pick<
  ProjectSession,
  'runtime_sessions' | 'opencode_sessions' | 'runtime_session_id' | 'opencode_session_id'
>;

/** Every conversation of a session's runtime: the root and its children. */
export function runtimeSessionsOf(session: SessionTree): ProjectRuntimeSession[] {
  return session.runtime_sessions ?? session.opencode_sessions ?? [];
}

/** The root conversation a session is pinned to, else (no pin yet) the first parentless one. */
export function rootRuntimeSession(session: SessionTree): ProjectRuntimeSession | null {
  const conversations = runtimeSessionsOf(session);
  const rootId = session.runtime_session_id ?? session.opencode_session_id;
  if (rootId) return conversations.find((item) => item.id === rootId) ?? null;
  return conversations.find((item) => !item.parent_id) ?? null;
}

/**
 * Direct, non-archived children of the root, newest `updated_at` first. A
 * missing time counts as 0 and ties break on id, so the order never churns
 * between refetches.
 */
export function directSubsessions(session: SessionTree): ProjectRuntimeSession[] {
  const root = rootRuntimeSession(session);
  if (!root) return [];
  return runtimeSessionsOf(session)
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.id.localeCompare(b.id));
}

/**
 * The project session that owns a runtime conversation id: a session id or
 * root pin first, then any conversation of a row (a child runs in its
 * parent's sandbox). Null for null or an unknown id.
 */
export function projectSessionForRuntimeId<S extends SessionTree & Pick<ProjectSession, 'session_id'>>(
  sessions: readonly S[],
  runtimeId: string | null,
): S | null {
  if (!runtimeId) return null;
  const direct = sessions.find(
    (session) =>
      session.session_id === runtimeId || (session.runtime_session_id ?? session.opencode_session_id) === runtimeId,
  );
  if (direct) return direct;
  return sessions.find((session) => runtimeSessionsOf(session).some((item) => item.id === runtimeId)) ?? null;
}

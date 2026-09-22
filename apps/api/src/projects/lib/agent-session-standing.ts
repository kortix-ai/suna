/**
 * An agent session's standing on one session row under the `agent_principal`
 * model (spec §2). The agent acts as itself, so it owns only its own session
 * and the sessions it spawned (`metadata.spawned_by_session`), never the
 * launcher's other sessions. Visibility only narrows: a private or restricted
 * session it does not own is invisible even when the launcher could see it; a
 * project-visible session keeps the ordinary verdict (`visibleByRules`).
 */
export function agentSessionStanding(
  boundCredentialSessionId: string | null,
  row: { sessionId: string; metadata: unknown; visibility: string },
  visibleByRules: boolean,
): { isOwner: boolean; visible: boolean } {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const isOwner =
    boundCredentialSessionId !== null &&
    (row.sessionId === boundCredentialSessionId ||
      meta.spawned_by_session === boundCredentialSessionId);
  return { isOwner, visible: isOwner || (row.visibility === 'project' && visibleByRules) };
}

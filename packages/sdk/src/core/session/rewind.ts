export function messagesBeforeRewind<T extends { info: { id: string } }>(
  messages: T[],
  messageId: string | null,
): T[] {
  if (!messageId) return messages;
  const boundary = messages.findIndex((message) => message.info.id === messageId);
  return boundary < 0 ? messages : messages.slice(0, boundary);
}

export interface SessionRewindState {
  messageId: string;
  staged: boolean;
}

/** Mark the rewind as committed while its removed path remains hidden locally. */
export function commitSessionRewind(
  rewind: SessionRewindState | null,
): SessionRewindState | null {
  return rewind?.staged ? { ...rewind, staged: false } : rewind;
}

/** Drop the local boundary after runtime synchronization confirms cleanup. */
export function reconcileCommittedSessionRewind<T extends { info: { id: string } }>(
  messages: T[],
  rewind: SessionRewindState | null,
): SessionRewindState | null {
  if (!rewind || rewind.staged) return rewind;
  return messages.some((message) => message.info.id === rewind.messageId) ? rewind : null;
}

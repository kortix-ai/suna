'use client';

import { SessionChat } from '../thread/session-chat';
import { useSessionIds } from '../../providers/session-ids';

/**
 * The body of a sub-agent that is not a Kortix session of its own: an
 * in-process child (`session: "same"`) or an old OpenCode subagent, whose
 * transcript lives in its lead's computer and saved history. It mounts the
 * read-only `SessionChat` of that child under the lead's saved-history scope,
 * so it paints while the computer is off. Every child that is its own project
 * session reads `SessionPeek` instead (`subagent-dialog-content.tsx`).
 */
export function LegacySubagentChat({ sessionId }: { sessionId: string }) {
  // The session page this sub-agent runs under. Its saved history holds the
  // sub-agent's transcript too.
  const ids = useSessionIds();
  const savedHistoryScope = ids.projectId && ids.sessionId ? `${ids.projectId}/${ids.sessionId}` : undefined;
  return <SessionChat sessionId={sessionId} hideHeader readOnly initialScrollTop savedHistoryScope={savedHistoryScope} />;
}

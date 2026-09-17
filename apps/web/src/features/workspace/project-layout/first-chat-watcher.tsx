'use client';

import { useProjectSessions } from '@kortix/sdk/react';
import { useEffect } from 'react';

import { useFirstChatPending, useFirstChatStore } from '@/stores/first-chat-store';

/**
 * Finishes a project's first chat once the project has a session, however that
 * session was made: a send from the first chat, a connector-gate retry,
 * Customize, the command palette, or another tab.
 *
 * Mounted once in the project shell, which wraps every project route. The
 * sidebar list cannot own this: on mobile it unmounts with its sheet.
 *
 * It reads the sidebar's own session query (same key, so no second request on
 * desktop) and only while a first chat is pending, so it costs nothing after.
 * Waiting for the session to be IN the list is deliberate: finishing any
 * earlier would drop the sidebar's first-chat row to the empty state for a
 * beat before the real row arrives.
 */
export function FirstChatWatcher({ projectId }: { projectId: string }) {
  const pending = useFirstChatPending(projectId);
  const finish = useFirstChatStore((state) => state.finish);
  const { sessions } = useProjectSessions(projectId, { enabled: pending });
  const hasSession = sessions.length > 0;

  useEffect(() => {
    if (pending && hasSession) finish(projectId);
  }, [pending, hasSession, projectId, finish]);

  return null;
}

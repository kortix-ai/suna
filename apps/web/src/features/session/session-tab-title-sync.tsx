'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { sessionTabTitleFromSession } from './session-tab-title';
import type { ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

/**
 * Keeps the tab title correct AFTER the route's metadata has settled — a
 * rename, or the agent's auto-title landing seconds into a new session.
 *
 * This is deliberately NOT a second owner of the title. `generateMetadata` in
 * the session layout resolves the same string from the same fields, so on load
 * the two agree and the guarded write below is a no-op. The only writes that
 * ever reach the DOM from here are genuine post-load changes to the name.
 *
 * It cannot be the primary owner: React re-asserts the metadata-owned <title>
 * when it commits, which happens after client effects run, so a client write
 * during load is overwritten (measured: written at 306ms, gone at 324ms).
 *
 * Rendered by the layout, never by the page, so the session page tree gains no
 * subscriber and no re-render.
 */
export function SessionTabTitleSync({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  // A pure READER of the session list the page already loads. `enabled: false`
  // stops this component from ever issuing a request of its own, while still
  // subscribing to the cache entry — so the optimistic write in the rename
  // mutation (`applySessionRename`) reaches the tab immediately. `select`
  // narrows 64 sessions down to one string, so structural sharing re-renders
  // this component only when the title actually changes.
  const { data: title } = useQuery({
    queryKey: qk.project.sessions(projectId),
    enabled: false,
    notifyOnChangeProps: ['data'],
    select: (sessions: ProjectSession[]) => {
      const session = sessions.find((item) => item.session_id === sessionId);
      // No record cached yet: leave whatever the server resolved alone rather
      // than overwriting a correct title with "Untitled session".
      return session ? sessionTabTitleFromSession(session) : null;
    },
  });

  useEffect(() => {
    if (!title) return;
    // Write only on a real change. Assigning an identical string still mutates
    // the <title> node, and this must stay quiet enough to be invisible.
    if (document.title !== title) document.title = title;
  }, [title]);

  return null;
}

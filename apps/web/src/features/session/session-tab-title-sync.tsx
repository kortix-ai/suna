'use client';

import { useEffect } from 'react';

import { useProjectSessionRow } from '@kortix/sdk/react';
import { sessionTabTitleFromSession } from './session-tab-title';

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
  // A READER of the row the session list already holds, so the optimistic
  // write in the rename mutation (`applySessionRename`) reaches the tab
  // immediately. A session on no loaded page resolves through the
  // single-session read the session page already issues.
  const session = useProjectSessionRow(projectId, sessionId);
  // No record cached yet: leave whatever the server resolved alone rather
  // than overwriting a correct title with "Untitled session".
  const title = session ? sessionTabTitleFromSession(session) : null;

  useEffect(() => {
    if (!title) return;
    // Write only on a real change. Assigning an identical string still mutates
    // the <title> node, and this must stay quiet enough to be invisible.
    if (document.title !== title) document.title = title;
  }, [title]);

  return null;
}

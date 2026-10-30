'use client';

import { useEffect } from 'react';

import { useProjectSession } from '@kortix/sdk/react';
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
  // Reads the session's OWN cache entry, not the project's session list.
  //
  // It used to subscribe to the flat list with `enabled: false` and find its
  // row in it. That stopped working when the sidebar's list became a bounded
  // page under a different cache key: this observer would have sat on an entry
  // nobody writes any more, and the tab title would never update. The single
  // row is also the correct dependency — the tab shows one session's name.
  //
  // `useProjectSession` is a real query, so a rename (which writes through
  // every cached session shape, see `updateCachedProjectSessions`) reaches the
  // tab immediately, and a session opened from a cold cache still resolves.
  const { data: session } = useProjectSession(projectId, sessionId);
  const title = session ? sessionTabTitleFromSession(session) : null;

  useEffect(() => {
    if (!title) return;
    // Write only on a real change. Assigning an identical string still mutates
    // the <title> node, and this must stay quiet enough to be invisible.
    if (document.title !== title) document.title = title;
  }, [title]);

  return null;
}

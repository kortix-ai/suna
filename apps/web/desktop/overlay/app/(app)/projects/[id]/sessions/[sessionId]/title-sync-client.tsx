'use client';

import { useParams } from 'next/navigation';

import { SessionTabTitleSync } from '@/features/session/session-tab-title-sync';

/**
 * Desktop-only wrapper that feeds SessionTabTitleSync the ids from the URL.
 *
 * The web layout passes them down from server `params`; under static export
 * those are the `__shell__` placeholder, so they come from the shimmed
 * `useParams` instead. Rendered from the layout, never the page, so the session
 * page tree gains no extra subscriber — same contract as on web.
 */
export function SessionTabTitleSyncFromUrl() {
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();

  if (!projectId || !sessionId) return null;

  return <SessionTabTitleSync projectId={projectId} sessionId={sessionId} />;
}

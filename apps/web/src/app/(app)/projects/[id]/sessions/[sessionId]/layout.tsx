import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { resolveSessionTabTitle } from '@/features/session/session-tab-title-server';
import { SessionTabTitleSync } from '@/features/session/session-tab-title-sync';

type SessionRouteProps = {
  children: ReactNode;
  params: Promise<{ id: string; sessionId: string }>;
};

/**
 * The session route's tab title lives here, and only here.
 *
 * It has to be a layout: `page.tsx` is a client component, and a client
 * component cannot export `generateMetadata`. That is also the reason the tab
 * used to read "dosco – The agent network for Your Company" for every open
 * session — the route declared no title of its own, so it inherited the root
 * default from app/layout.tsx.
 *
 * Resolving it here rather than in a client effect is not a style preference.
 * React re-asserts the metadata-owned <title> element when it commits, after
 * client effects have already run, so a `document.title = …` write during load
 * is reliably overwritten a few milliseconds later. Owning the title through
 * the Metadata API is the only way it survives — and it comes with the initial
 * HTML, so there is no flicker and no hydration mismatch.
 *
 * Next re-runs this for every navigation into a different `sessionId`,
 * including client-side navigation and browser back/forward, so those cases
 * need no extra machinery.
 */
export async function generateMetadata({ params }: SessionRouteProps): Promise<Metadata> {
  const { id: projectId, sessionId } = await params;
  return {
    // `absolute` bypasses the root layout's `%s | dosco` template: the tab
    // reads "<session name> — dosco", and a session named "dosco" must not
    // come out as "dosco | dosco".
    title: { absolute: await resolveSessionTabTitle(projectId, sessionId) },
  };
}

export default async function SessionRouteLayout({ children, params }: SessionRouteProps) {
  const { id: projectId, sessionId } = await params;
  return (
    <>
      {children}
      {/* Post-load changes only (rename, auto-title). Mounted here rather than
          in the page so the page tree gains no session-name subscriber. */}
      <SessionTabTitleSync projectId={projectId} sessionId={sessionId} />
    </>
  );
}

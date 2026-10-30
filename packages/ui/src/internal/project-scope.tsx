'use client';

import { KortixProjectProvider } from '@kortix/sdk/react';
import type { ReactNode } from 'react';

import { SessionIdsProvider, type UiSessionIds } from '../providers/session-ids';

/**
 * `SessionIdsProvider` plus the SDK's project scope (`KortixProjectProvider`:
 * the model catalog, runtime providers). The composed screens (`SessionThread`,
 * `SessionWorkspace`, `ProjectHome`) mount it, so a host mounts nothing for them.
 * It lives here, not in `providers/`, because the root entry must load without
 * the optional `@kortix/sdk` peer.
 */
export function ProjectScope({ projectId, sessionId, children }: UiSessionIds & { children: ReactNode }) {
  const ids = (
    <SessionIdsProvider projectId={projectId} sessionId={sessionId}>
      {children}
    </SessionIdsProvider>
  );
  return projectId ? <KortixProjectProvider projectId={projectId}>{ids}</KortixProjectProvider> : ids;
}

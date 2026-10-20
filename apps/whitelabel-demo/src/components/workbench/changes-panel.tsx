'use client';

/**
 * The Changes tab: the project's git history, branches and the session's
 * compare-to-base, read only (`CommitsView`). Committing, pushing and change
 * requests are the Lumen operator's: the proxy refuses them
 * (`src/server/proxy-policy.ts`), so the panel draws no control for them.
 */

import { CommitsView } from './changes/commits-view';

export function ChangesPanel({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card p-3">
      <CommitsView projectId={projectId} sessionId={sessionId} />
    </div>
  );
}

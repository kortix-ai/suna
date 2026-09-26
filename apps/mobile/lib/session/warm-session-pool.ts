/**
 * The app's one warm-session pool (`warm-session.ts`), backed by the SDK's
 * warm routes. One module-level instance: `ProjectScreen` keeps it filled and
 * a project-home send takes from it. Reset on sign-out (`hooks/useAuth.ts`).
 */
import { claimWarmProjectSession, ensureWarmProjectSession, getProjectSession } from '@kortix/sdk';

import { createWarmSessionPool } from './warm-session';

export const warmSessionPool = createWarmSessionPool({
  ensure: async (projectId, excludeSessionId) => {
    const { session } = await ensureWarmProjectSession(
      projectId,
      excludeSessionId ? { excludeSessionId } : undefined,
    );
    return { sessionId: session.session_id, agentName: session.agent_name ?? null };
  },
  // Web calls the same (deprecated-for-new-callers) claim: it is the one route
  // that stores the first prompt and drops the warm marker in one transaction.
  claim: (projectId, input) => claimWarmProjectSession(projectId, input),
  read: (projectId, sessionId) => getProjectSession(projectId, sessionId, { showErrors: false }),
});

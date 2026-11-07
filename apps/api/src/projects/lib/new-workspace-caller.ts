import { isProjectSessionPrincipal } from '../../middleware/agent-scope';
import type { NewWorkspaceCaller } from '../new-workspace';
import type { Context } from 'hono';

/** Who is asking, for the new-workspace caller rule (`new-workspace.ts`). */
export function newWorkspaceCallerOf(c: Context): NewWorkspaceCaller {
  return {
    userId: c.get('userId') as string,
    email: (c.get('userEmail') as string | undefined) || null,
    authType: c.get('authType') as string | undefined,
    // A browser JWT's `sessionId` is its Supabase login session, not a
    // Kortix session (middleware/caller-session.ts): never a scoped credential.
    scopedCredential: Boolean(c.get('tokenProjectId')) || isProjectSessionPrincipal(c),
  };
}

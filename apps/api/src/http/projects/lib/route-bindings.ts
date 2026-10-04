import type { Context } from 'hono';
import { isUuid } from '../../../lib/validate';
import type { ProjectAccessAction } from '../../../services/projects/access';
import { loadProjectForUser } from '../../../services/projects/lib/access';

/** The shared UUID and project-load sleeve; route-specific gates stay at their original sites. */
export async function resolveSessionBinding(
  c: Context,
  projectId: string,
  sessionId: string,
  claim: ProjectAccessAction,
): Promise<
  | { kind: 'error'; response: Response }
  | { kind: 'ok'; loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>> }
> {
  if (!isUuid(sessionId))
    return { kind: 'error', response: c.json({ error: 'Invalid session id' }, 400) };
  const loaded = await loadProjectForUser(c, projectId, claim);
  if (!loaded) return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  return { kind: 'ok', loaded };
}

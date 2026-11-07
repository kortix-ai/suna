import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../../iam';
import { assertAgentScope } from '../../../iam/agent-scope';
import { callerKortixSessionId } from '../../../middleware/caller-session';
import { isUuid } from '../../../shared/validate';
import type { ProjectAccessAction } from '../../access';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from '../../lib/access';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;
type VisibleSession = NonNullable<Awaited<ReturnType<typeof loadVisibleSession>>>;

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

/** The owner/manager gate of restart, recover, stop, delete and restore; each route words its own 403. */
export async function loadLifecycleSession(
  c: Context,
  loaded: LoadedProject,
  sessionId: string,
  refusal: string,
  options: { rejectTombstoned: boolean },
): Promise<{ kind: 'error'; response: Response } | { kind: 'ok'; visible: VisibleSession }> {
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  if (!visible || (options.rejectTombstoned && sessionIsTombstoned(visible.row)))
    return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  if (!visible.canManageLifecycle)
    return { kind: 'error', response: c.json({ error: refusal }, 403) };
  return { kind: 'ok', visible };
}

/** The gate of the queued-prompt routes (DELETE, PATCH, retry, hold): floor 'session', session-start, visible and not tombstoned. */
export async function loadRunnableSession(
  c: Context,
  projectId: string,
  sessionId: string,
): Promise<
  | { kind: 'error'; response: Response }
  | { kind: 'ok'; loaded: LoadedProject; visible: VisibleSession }
> {
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_SESSION_START,
  );
  const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
  if (!visible || sessionIsTombstoned(visible.row))
    return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  return { kind: 'ok', loaded, visible };
}

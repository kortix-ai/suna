import { ensureProjectSessionEnvironment } from '../rest/projects-client';
import { getSessionHealth } from './health';
import { getSandboxUrlForExternalId } from './server-store/url-helpers';

export async function resolveSessionWorkspaceEnvironment(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
) {
  const environment = await ensureProjectSessionEnvironment(projectId, sessionId);
  signal?.throwIfAborted();
  if (environment.status !== 'active' || !environment.external_id) {
    return { environment, ready: false };
  }
  const result = await getSessionHealth(
    getSandboxUrlForExternalId(environment.external_id),
    { signal },
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error(`Workspace health request failed: ${result.status}`);
  }
  if (result.health?.boot_error) throw new Error(result.health.boot_error);
  return { environment, ready: result.ok && result.health?.runtimeReady === true };
}

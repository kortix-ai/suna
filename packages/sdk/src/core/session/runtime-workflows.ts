/**
 * The workflow runs a session's box serves (`/kortix/runtime/workflows`), and
 * their controls. A run lives on the box that runs it: the session that called
 * `workflow`, or its background runner session.
 *
 *   GET  /kortix/runtime/workflows                 → 200 { runs: WorkflowRunMetadata[] }, newest first
 *   POST /kortix/runtime/workflows/:runId/control  → 200 { ok: true, paused }; 404 unknown run
 */
import { authenticatedFetch } from '../http/auth';
import { ApiError } from '../http/api/errors';
import { getProjectSession } from '../rest/projects-client/sessions';
import { projectSessionStartSeed } from '../rest/projects-client/session-sandbox';
import type {
  WorkflowControlBody,
  WorkflowControlResult,
  WorkflowRunMetadata,
} from '../rest/projects-client/multi-agent';
import { getSandboxUrlForExternalId } from './server-store/url-helpers';
import { getSessionRuntime } from './session-runtime-registry';

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.message || body.error || text || `HTTP ${response.status}`;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

async function call<T>(runtimeUrl: string, method: string, path: string, body: unknown, what: string): Promise<T> {
  const base = runtimeUrl.replace(/\/$/, '');
  const response = await authenticatedFetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new ApiError(`${what}: ${await errorText(response)}`, { status: response.status, response });
  }
  return (await response.json()) as T;
}

/** The workflow runs of one box, newest first. */
export function listRuntimeWorkflowRuns(runtimeUrl: string): Promise<{ runs: WorkflowRunMetadata[] }> {
  return call(runtimeUrl, 'GET', '/kortix/runtime/workflows', undefined, 'Reading the workflow runs failed');
}

/** Pause, resume, stop a run, or restart one of its agents. */
export function controlRuntimeWorkflowRun(
  runtimeUrl: string,
  runId: string,
  body: WorkflowControlBody,
): Promise<WorkflowControlResult> {
  return call(
    runtimeUrl,
    'POST',
    `/kortix/runtime/workflows/${encodeURIComponent(runId)}/control`,
    body,
    'Changing the workflow run failed',
  );
}

/**
 * A session's runs, for a poll: the runtime this process already resolved for
 * the session, else the one its row names while it runs. A session that does
 * not run has no live runs, and this never starts it. A box without the
 * workflow routes (`404`) has none either.
 */
export async function readSessionWorkflowRuns(
  projectId: string,
  sessionId: string,
): Promise<{ runs: WorkflowRunMetadata[] }> {
  let runtimeUrl = getSessionRuntime(projectId, sessionId)?.runtimeUrl;
  if (!runtimeUrl) {
    const row = await getProjectSession(projectId, sessionId, { showErrors: false }).catch(() => null);
    const externalId = row ? projectSessionStartSeed(row)?.sandbox?.external_id : undefined;
    if (externalId) runtimeUrl = getSandboxUrlForExternalId(externalId);
  }
  if (!runtimeUrl) return { runs: [] };
  try {
    const answer = await listRuntimeWorkflowRuns(runtimeUrl);
    return { runs: Array.isArray(answer?.runs) ? answer.runs : [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { runs: [] };
    throw error;
  }
}

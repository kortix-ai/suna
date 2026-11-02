/**
 * The workflow runs a session's box serves (`/kortix/runtime/workflows`), and
 * their controls. A run lives on the box that runs it: the session that called
 * `workflow`, or its background runner session.
 *
 *   GET  /kortix/runtime/workflows                 → 200 { runs: WorkflowRunMetadata[] }, newest first
 *   POST /kortix/runtime/workflows/:runId/control  → 200 { ok: true, paused }; 404 unknown run;
 *        409 { code: 'run_in_runner', runner_session_id } for a background run asked on its parent
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

async function call<T>(runtimeUrl: string, method: string, path: string, body: unknown, what: string): Promise<T> {
  const base = runtimeUrl.replace(/\/$/, '');
  const response = await authenticatedFetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let details: { error?: string; message?: string; code?: string } | undefined;
    try {
      details = JSON.parse(text);
    } catch {
      details = undefined;
    }
    const message = details?.message || details?.error || text || `HTTP ${response.status}`;
    throw new ApiError(`${what}: ${message}`, {
      status: response.status,
      response,
      ...(details ? { details, data: details, ...(typeof details.code === 'string' ? { code: details.code } : {}) } : {}),
    });
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
 * The runtime URL of a session that runs: the one this process already
 * resolved, else the one its row names. Null for a session that does not run.
 * Never starts a session.
 */
export async function runningSessionRuntimeUrl(projectId: string, sessionId: string): Promise<string | null> {
  const known = getSessionRuntime(projectId, sessionId)?.runtimeUrl;
  if (known) return known;
  const row = await getProjectSession(projectId, sessionId, { showErrors: false }).catch(() => null);
  const externalId = row ? projectSessionStartSeed(row)?.sandbox?.external_id : undefined;
  return externalId ? getSandboxUrlForExternalId(externalId) : null;
}

async function requireRunningRuntimeUrl(projectId: string, sessionId: string): Promise<string> {
  const url = await runningSessionRuntimeUrl(projectId, sessionId);
  if (!url) throw new Error('This session is not running, so its workflow runs cannot change.');
  return url;
}

/** The runner session a `409 run_in_runner` names, or null for any other error. */
function runnerSessionOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'run_in_runner') return null;
  const runner = (error.details as { runner_session_id?: unknown } | undefined)?.runner_session_id;
  return typeof runner === 'string' && runner ? runner : null;
}

/**
 * Control a run of `sessionId`. A background run lives in its runner session:
 * the parent's box answers `409 run_in_runner`, and the control goes to that
 * runner once. Never starts a session.
 */
export async function controlSessionWorkflowRun(
  projectId: string,
  sessionId: string,
  runId: string,
  body: WorkflowControlBody,
): Promise<WorkflowControlResult> {
  const url = await requireRunningRuntimeUrl(projectId, sessionId);
  try {
    return await controlRuntimeWorkflowRun(url, runId, body);
  } catch (error) {
    const runner = runnerSessionOf(error);
    if (!runner || runner === sessionId) throw error;
    return controlRuntimeWorkflowRun(await requireRunningRuntimeUrl(projectId, runner), runId, body);
  }
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
  const runtimeUrl = await runningSessionRuntimeUrl(projectId, sessionId);
  if (!runtimeUrl) return { runs: [] };
  try {
    const answer = await listRuntimeWorkflowRuns(runtimeUrl);
    return { runs: Array.isArray(answer?.runs) ? answer.runs : [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { runs: [] };
    throw error;
  }
}

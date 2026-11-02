import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../client/kortix';
import { configureKortix } from '../http/config';
import { ApiError } from '../http/api/errors';
import { clearSessionRuntime, setSessionRuntime } from './session-runtime-registry';
import {
  controlRuntimeWorkflowRun,
  controlSessionWorkflowRun,
  listRuntimeWorkflowRuns,
  readSessionWorkflowRuns,
} from './runtime-workflows';

const RUNTIME = 'http://test.local/p/sbx_1/8000';
const RUN = {
  runId: 'run_1',
  title: 'Audit the routes',
  status: 'running',
  phases: [],
  agents: [],
  startedAt: 1,
};

let requests: { method: string; url: string; body: unknown; auth: string | null }[] = [];
let routes: Record<string, { status?: number; body: unknown }> = {};

beforeEach(() => {
  requests = [];
  routes = {};
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = request.body ? JSON.parse(await request.text()) : undefined;
    requests.push({ method: request.method, url: request.url, body, auth: request.headers.get('authorization') });
    const route = routes[`${request.method} ${request.url}`] ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => clearSessionRuntime('p1', 's1'));

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('listRuntimeWorkflowRuns reads the runs of one box, with the caller token', async () => {
  routes[`GET ${RUNTIME}/kortix/runtime/workflows`] = { body: { runs: [RUN] } };
  expect(await listRuntimeWorkflowRuns(RUNTIME)).toEqual({ runs: [RUN] } as never);
  expect(requests[0]!.auth).toBe('Bearer tok');
});

test('controlRuntimeWorkflowRun posts the control body to the run', async () => {
  routes[`POST ${RUNTIME}/kortix/runtime/workflows/run_1/control`] = { body: { ok: true, paused: true } };
  expect(await controlRuntimeWorkflowRun(RUNTIME, 'run_1', { action: 'pause' })).toEqual({ ok: true, paused: true });
  expect(requests[0]).toMatchObject({ method: 'POST', body: { action: 'pause' } });
});

test('controlRuntimeWorkflowRun throws an ApiError with the status on an unknown run', async () => {
  const error = await controlRuntimeWorkflowRun(RUNTIME, 'nope', { action: 'stop' }).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(404);
});

test('readSessionWorkflowRuns uses the resolved runtime and never starts a stopped session', async () => {
  setSessionRuntime('p1', 's1', { runtimeSessionId: 'r', opencodeSessionId: 'r', runtimeUrl: RUNTIME, sandboxId: 'sbx_1' });
  routes[`GET ${RUNTIME}/kortix/runtime/workflows`] = { body: { runs: [RUN] } };
  expect((await readSessionWorkflowRuns('p1', 's1')).runs).toHaveLength(1);

  clearSessionRuntime('p1', 's1');
  routes['GET http://test.local/projects/p1/sessions/s1'] = { body: { session_id: 's1', status: 'stopped' } };
  expect(await readSessionWorkflowRuns('p1', 's1')).toEqual({ runs: [] });
  expect(requests.some((r) => r.url.endsWith('/start'))).toBe(false);
});

test('readSessionWorkflowRuns answers no runs from a box without the workflow routes', async () => {
  setSessionRuntime('p1', 's1', { runtimeSessionId: 'r', opencodeSessionId: 'r', runtimeUrl: RUNTIME, sandboxId: 'sbx_1' });
  expect(await readSessionWorkflowRuns('p1', 's1')).toEqual({ runs: [] });
});

test('a session handle lists and controls the workflow runs of its own box', async () => {
  setSessionRuntime('p1', 's1', { runtimeSessionId: 'r', opencodeSessionId: 'r', runtimeUrl: RUNTIME, sandboxId: 'sbx_1' });
  routes[`GET ${RUNTIME}/kortix/runtime/workflows`] = { body: { runs: [RUN] } };
  routes[`POST ${RUNTIME}/kortix/runtime/workflows/run_1/control`] = { body: { ok: true, paused: false } };
  const session = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' }).session('p1', 's1');
  expect((await session.workflows.list()).runs[0]!.runId).toBe('run_1');
  expect(await session.workflows.control('run_1', { action: 'restart_agent', session_id: 'c1' })).toEqual({ ok: true, paused: false });
  expect(requests.at(-1)).toMatchObject({ body: { action: 'restart_agent', session_id: 'c1' } });
});

test('a control the parent box redirects to the runner session (409 run_in_runner) goes to the runner once', async () => {
  const RUNNER = 'http://test.local/p/sbx_runner/8000';
  setSessionRuntime('p1', 's1', { runtimeSessionId: 'r', opencodeSessionId: 'r', runtimeUrl: RUNTIME, sandboxId: 'sbx_1' });
  setSessionRuntime('p1', 'runner1', { runtimeSessionId: 'r2', opencodeSessionId: 'r2', runtimeUrl: RUNNER, sandboxId: 'sbx_runner' });
  routes[`POST ${RUNTIME}/kortix/runtime/workflows/run_1/control`] = {
    status: 409,
    body: { error: 'this run runs in its runner session', code: 'run_in_runner', runner_session_id: 'runner1' },
  };
  routes[`POST ${RUNNER}/kortix/runtime/workflows/run_1/control`] = { body: { ok: true, paused: true } };
  expect(await controlSessionWorkflowRun('p1', 's1', 'run_1', { action: 'pause' })).toEqual({ ok: true, paused: true });
  expect(requests.map((r) => r.url)).toEqual([
    `${RUNTIME}/kortix/runtime/workflows/run_1/control`,
    `${RUNNER}/kortix/runtime/workflows/run_1/control`,
  ]);

  const session = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' }).session('p1', 's1');
  expect(await session.workflows.control('run_1', { action: 'pause' })).toEqual({ ok: true, paused: true });
  clearSessionRuntime('p1', 'runner1');
});

test('a control to a session that does not run fails with a plain sentence, and never starts it', async () => {
  routes['GET http://test.local/projects/p1/sessions/s1'] = { body: { session_id: 's1', status: 'stopped' } };
  await expect(controlSessionWorkflowRun('p1', 's1', 'run_1', { action: 'stop' })).rejects.toThrow('not running');
  expect(requests.some((r) => r.url.endsWith('/start'))).toBe(false);
});

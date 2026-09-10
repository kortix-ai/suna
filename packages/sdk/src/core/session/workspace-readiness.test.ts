import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../http/config';
import { setCurrentRuntime } from './current-runtime';
import { resolveSessionWorkspaceEnvironment } from './workspace-readiness';

let environmentStatus = 'active';
let healthStatus = 200;
let runtimeReady: boolean | undefined = false;
let bootError: string | null = null;
let calls: Array<{ path: string; auth: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  environmentStatus = 'active';
  healthStatus = 200;
  runtimeReady = false;
  bootError = null;
  calls = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, auth: request.headers.get('authorization') });
      if (path === '/v1/projects/project-1/sessions/session-1/environment/ensure') {
        return Response.json({ session_id: 'session-1', status: environmentStatus,
          external_id: environmentStatus === 'active' ? 'environment-1' : null,
          preview_url: null, preview_token: null });
      }
      if (path === '/v1/p/environment-1/8000/kortix/health') {
        return Response.json({ status: bootError ? 'error' : 'ok', runtimeReady,
          boot_error: bootError }, { status: healthStatus });
      }
      return Response.json({ error: 'wrong runtime' }, { status: 404 });
    },
  });
  configureKortix({ backendUrl: `${server.url.origin}/v1`, getToken: async () => 'workspace-test' });
  setCurrentRuntime('https://unrelated-runtime.invalid', 'unrelated');
});

afterEach(() => { server.stop(true); });

test('an active environment waits for its own runtime readiness, then exposes ready', async () => {
  expect((await resolveSessionWorkspaceEnvironment('project-1', 'session-1')).ready).toBe(false);
  runtimeReady = true;
  expect((await resolveSessionWorkspaceEnvironment('project-1', 'session-1')).ready).toBe(true);
  expect(calls.map((c) => c.path)).toEqual([
    '/v1/projects/project-1/sessions/session-1/environment/ensure',
    '/v1/p/environment-1/8000/kortix/health',
    '/v1/projects/project-1/sessions/session-1/environment/ensure',
    '/v1/p/environment-1/8000/kortix/health',
  ]);
  expect(calls.every((c) => c.auth === 'Bearer workspace-test')).toBe(true);
});

test('provisioning has no runtime to probe', async () => {
  environmentStatus = 'provisioning';
  expect((await resolveSessionWorkspaceEnvironment('project-1', 'session-1')).ready).toBe(false);
  expect(calls).toHaveLength(1);
});

test('a transient daemon failure remains pending even with a ready-shaped body', async () => {
  healthStatus = 503;
  runtimeReady = true;
  expect((await resolveSessionWorkspaceEnvironment('project-1', 'session-1')).ready).toBe(false);
});

test('a failed checkout surfaces its boot error', async () => {
  bootError = 'checkout failed';
  await expect(resolveSessionWorkspaceEnvironment('project-1', 'session-1')).rejects.toThrow('checkout failed');
});


test('an unknown health shape does not prove workspace readiness', async () => {
  runtimeReady = undefined;
  expect((await resolveSessionWorkspaceEnvironment('project-1', 'session-1')).ready).toBe(false);
});

test('authorization failures surface instead of polling indefinitely', async () => {
  healthStatus = 403;
  await expect(resolveSessionWorkspaceEnvironment('project-1', 'session-1')).rejects.toThrow('403');
});

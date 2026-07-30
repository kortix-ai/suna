import { expect, test } from 'bun:test';

import { createHealthRouter } from './health';

test('reports selected ACP harness readiness independently from OpenCode REST', async () => {
  const router = createHealthRouter(
    {
      autoClone: false,
      projectTarget: '/workspace',
      sandboxToken: 'token',
    } as never,
    {
      getState: () => 'starting',
      getPid: () => null,
    } as never,
    Date.now(),
    {
      repoMaterializationError: null,
      timeline: [],
      acpHarness: 'codex',
      acpServerId: 'project-session-1',
      acpRuntimeReady: true,
      acpRuntimeError: null,
    },
    null,
    {
      get: (serverId: string) =>
        serverId === 'project-session-1' ? { harness: 'codex', pid: 123, busy: false } : null,
    } as never,
  );

  const response = await router.request('/');
  const body = await response.json();

  expect(body).toMatchObject({
    status: 'ok',
    runtimeReady: true,
    runtime: 'acp',
    runtime_harness: 'codex',
    acp_harness: 'codex',
    acp_server_id: 'project-session-1',
    acp_ready: true,
    opencode: 'down',
  });
});

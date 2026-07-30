import { expect, test } from 'bun:test';

import { parseSandboxRuntimeHealth, readManagedAcpSessionIdentity } from './runtime-inspection';

test('parseSandboxRuntimeHealth accepts valid ACP health metadata', () => {
  expect(
    parseSandboxRuntimeHealth({
      runtime: 'acp',
      runtimeReady: true,
      runtime_harness: 'codex',
      acp_server_id: 'project-session-1',
      boot_error: null,
    }),
  ).toEqual({
    runtime: 'acp',
    runtimeReady: true,
    acpServerId: 'project-session-1',
    runtimeHarness: 'codex',
    bootError: null,
  });
});

test('parseSandboxRuntimeHealth rejects unknown harness values', () => {
  expect(
    parseSandboxRuntimeHealth({
      runtime: 'acp',
      runtimeReady: true,
      runtime_harness: 'unknown',
      acp_server_id: 'project-session-1',
    }),
  ).toMatchObject({
    runtimeHarness: null,
  });
});

test('readManagedAcpSessionIdentity separates managed and legacy ACP sessions', () => {
  expect(
    readManagedAcpSessionIdentity({
      runtime_transport: 'acp',
      runtime_harness: 'pi',
      acp_server_id: 'project-session-1',
    }),
  ).toEqual({
    runtimeHarness: 'pi',
    acpServerId: 'project-session-1',
  });
  expect(readManagedAcpSessionIdentity({ runtime_transport: 'acp' })).toBeNull();
});

import { expect, test } from 'bun:test';

import { configureKortix } from '../core/http/config';
import { cancelAcpSession, createAcpSessionRuntimeController } from './use-acp-session-runtime';

test('ACP cancellation propagates the controller rejection', async () => {
  const failure = new Error('cancel failed');
  await expect(
    cancelAcpSession({
      cancel: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});

test('legacy ACP sessions keep the canonical OpenCode session as the bridge identity', () => {
  const inputs: unknown[] = [];
  const controller = createAcpSessionRuntimeController(
    {
      projectId: 'project-1',
      runtimeUrl: 'https://api.kortix.test/v1/p/box/8000',
      sessionId: 'project-session-1',
      acpServerId: null,
      acpSessionId: null,
      runtimeHarness: null,
      legacySessionId: 'opencode-root-1',
    },
    (input) => {
      inputs.push(input);
      return { kind: 'legacy' } as never;
    },
  );

  expect((controller as unknown as { kind: string }).kind).toBe('legacy');
  expect(inputs).toEqual([
    {
      runtimeUrl: 'https://api.kortix.test/v1/p/box/8000',
      sessionId: 'opencode-root-1',
    },
  ]);
});

test('managed ACP sessions bind the immutable native agent to the controller', () => {
  configureKortix({
    backendUrl: 'https://api.kortix.test/v1',
    getToken: async () => 'token',
  });
  const inputs: unknown[] = [];
  createAcpSessionRuntimeController(
    {
      projectId: 'project-1',
      runtimeUrl: 'https://api.kortix.test/v1/p/box/8000',
      sessionId: 'project-session-1',
      acpServerId: 'project-session-1',
      acpSessionId: 'codex-native-1',
      runtimeHarness: 'codex',
      nativeAgent: 'reviewer',
    },
    (input) => {
      inputs.push(input);
      return { kind: 'managed' } as never;
    },
  );

  expect(inputs).toEqual([
    expect.objectContaining({
      sessionId: 'project-session-1',
      acpServerId: 'project-session-1',
      acpSessionId: 'codex-native-1',
      runtimeHarness: 'codex',
      nativeAgent: 'reviewer',
      endpoint: 'https://api.kortix.test/v1/projects/project-1/sessions/project-session-1/acp',
      durableTranscript: true,
    }),
  ]);
});

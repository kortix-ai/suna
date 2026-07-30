import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { persistProjectSessionAcpIdentity } from './session-acp-identity';

let request: { url: string; method: string; body: unknown } | null = null;

configureKortix({
  backendUrl: 'http://test.local/v1',
  getToken: async () => 'token',
});

beforeEach(() => {
  request = null;
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    request = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    return Response.json({
      acp_server_id: 'S1',
      runtime_harness: 'codex',
      acp_session_id: 'codex-native-1',
    });
  }) as unknown as typeof fetch;
});

test('persists separate ACP process and harness-native session identifiers', async () => {
  const result = await persistProjectSessionAcpIdentity('P1', 'S1', {
    acp_server_id: 'S1',
    runtime_harness: 'codex',
    acp_session_id: 'codex-native-1',
  });

  expect(request).toEqual({
    url: 'http://test.local/v1/projects/P1/sessions/S1/acp-identity',
    method: 'PUT',
    body: {
      acp_server_id: 'S1',
      runtime_harness: 'codex',
      acp_session_id: 'codex-native-1',
    },
  });
  expect(result.acp_session_id).toBe('codex-native-1');
});

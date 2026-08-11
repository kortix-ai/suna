import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { setAgentScope } from './agent-scope';

let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  globalThis.fetch = mock(async (_url: unknown, options: RequestInit = {}) => {
    bodies.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'token',
});

test('setAgentScope sends the canonical required connector field', async () => {
  await setAgentScope('workspace-1', 'support', {
    connectors: ['gmail'],
    connectors_required: ['gmail'],
  });
  expect(bodies[0]).toMatchObject({
    connectors: ['gmail'],
    connectors_required: ['gmail'],
  });
});

test('setAgentScope imports the deprecated alias without serializing it', async () => {
  await setAgentScope('workspace-1', 'support', {
    connectors: ['gmail'],
    connectors_personal: ['gmail'],
  });
  expect(bodies[0]?.connectors_required).toEqual(['gmail']);
  expect(bodies[0]).not.toHaveProperty('connectors_personal');
});

test('setAgentScope rejects conflicting aliases before sending a request', async () => {
  await expect(
    setAgentScope('workspace-1', 'support', {
      connectors: ['gmail', 'slack'],
      connectors_required: ['gmail'],
      connectors_personal: ['slack'],
    }),
  ).rejects.toThrow('connectors_personal must match connectors_required');
  expect(bodies).toHaveLength(0);
});

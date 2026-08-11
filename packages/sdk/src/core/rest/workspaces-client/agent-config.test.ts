import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type AgentConfigBlock,
  getAgentConfig,
  updateAgentConfig,
} from './agent-config';

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let nextBody: Record<string, unknown> = { ok: true };

beforeEach(() => {
  calls = [];
  nextBody = { ok: true };
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: options.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : {},
    });
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'token',
});

describe('AgentConfigBlock', () => {
  test('accepts an agent sandbox template slug', () => {
    const block: AgentConfigBlock = { sandbox: 'ml' };
    expect(block.sandbox).toBe('ml');
  });

  test('accepts the canonical required connector field', () => {
    const block: AgentConfigBlock = {
      connectors: ['gmail'],
      connectors_required: ['gmail'],
    };
    expect(block.connectors_required).toEqual(['gmail']);
  });
});

describe('updateAgentConfig', () => {
  test('serializes the deprecated input alias as canonical', async () => {
    await updateAgentConfig('workspace-1', 'support', {
      connectors: ['gmail'],
      connectors_personal: ['gmail', 'gmail'],
    });
    expect(calls[0]?.body).toMatchObject({
      connectors: ['gmail'],
      connectors_required: ['gmail'],
    });
    expect(calls[0]?.body).not.toHaveProperty('connectors_personal');
  });

  test('accepts matching normalized aliases', async () => {
    await updateAgentConfig('workspace-1', 'support', {
      connectors: ['gmail', 'slack'],
      connectors_required: ['gmail', 'slack'],
      connectors_personal: ['slack', 'gmail'],
    });
    expect(calls[0]?.body.connectors_required).toEqual(['gmail', 'slack']);
    expect(calls[0]?.body).not.toHaveProperty('connectors_personal');
  });

  test('rejects conflicting aliases before sending a request', async () => {
    await expect(
      updateAgentConfig('workspace-1', 'support', {
        connectors: ['gmail', 'slack'],
        connectors_required: ['gmail'],
        connectors_personal: ['slack'],
      }),
    ).rejects.toThrow('connectors_personal must match connectors_required');
    expect(calls).toHaveLength(0);
  });

  test('normalizes a deprecated response alias to canonical', async () => {
    nextBody = {
      ok: true,
      agent: 'support',
      schema_version: 2,
      block: {
        connectors: ['gmail'],
        connectors_personal: ['gmail'],
      },
    };
    const response = await updateAgentConfig('workspace-1', 'support', {
      connectors: ['gmail'],
    });
    expect(response.block?.connectors_required).toEqual(['gmail']);
    expect(response.block).not.toHaveProperty('connectors_personal');
  });
});

describe('getAgentConfig', () => {
  test('normalizes a deprecated response alias to canonical', async () => {
    nextBody = {
      agent: 'support',
      schema_version: 2,
      editable: true,
      default_agent: 'support',
      block: {
        connectors: ['gmail'],
        connectors_personal: ['gmail'],
      },
    };
    const response = await getAgentConfig('workspace-1', 'support');
    expect(response.block?.connectors_required).toEqual(['gmail']);
    expect(response.block).not.toHaveProperty('connectors_personal');
  });
});

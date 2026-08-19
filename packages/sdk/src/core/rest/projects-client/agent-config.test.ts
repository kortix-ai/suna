import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type AgentConfigBlock,
  getAgentConfig,
  grantSecretToAgent,
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
    await updateAgentConfig('project-1', 'support', {
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
    await updateAgentConfig('project-1', 'support', {
      connectors: ['gmail', 'slack'],
      connectors_required: ['gmail', 'slack'],
      connectors_personal: ['slack', 'gmail'],
    });
    expect(calls[0]?.body.connectors_required).toEqual(['gmail', 'slack']);
    expect(calls[0]?.body).not.toHaveProperty('connectors_personal');
  });

  test('rejects conflicting aliases before sending a request', async () => {
    await expect(
      updateAgentConfig('project-1', 'support', {
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
    const response = await updateAgentConfig('project-1', 'support', {
      connectors: ['gmail'],
    });
    expect(response.block?.connectors_required).toEqual(['gmail']);
    expect(response.block).not.toHaveProperty('connectors_personal');
  });
});

describe('grantSecretToAgent', () => {
  test('posts the agent to the secret grant route', async () => {
    nextBody = {
      identifier: 'BOUNDARY_TEST',
      agent: 'support',
      already_granted: false,
      adopted_governance: true,
    };
    const response = await grantSecretToAgent('project-1', 'BOUNDARY_TEST', 'support');
    expect(calls[0]?.url).toBe(
      'http://test.local/projects/project-1/secrets/BOUNDARY_TEST/grant',
    );
    expect(calls[0]?.body).toEqual({ agent: 'support' });
    expect(response.already_granted).toBe(false);
    expect(response.adopted_governance).toBe(true);
  });

  test('escapes an identifier that carries URL-significant characters', async () => {
    nextBody = {
      identifier: 'GMAPS/primary key',
      agent: 'support',
      already_granted: true,
      adopted_governance: false,
    };
    await grantSecretToAgent('project-1', 'GMAPS/primary key', 'support');
    expect(calls[0]?.url).toBe(
      'http://test.local/projects/project-1/secrets/GMAPS%2Fprimary%20key/grant',
    );
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
    const response = await getAgentConfig('project-1', 'support');
    expect(response.block?.connectors_required).toEqual(['gmail']);
    expect(response.block).not.toHaveProperty('connectors_personal');
  });
});

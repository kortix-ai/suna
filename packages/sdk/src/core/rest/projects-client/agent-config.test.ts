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

  test('carries the path of the agent .md (server-owned `file`)', () => {
    const block: AgentConfigBlock = { file: 'agents/support.md' };
    expect(block.file).toBe('agents/support.md');
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

  test('a GET -> PUT round trip sends the block `file` back unchanged', async () => {
    nextBody = { agent: 'support', schema_version: 2, editable: true, block: { file: 'agents/support.md', skills: 'all' } };
    const current = await getAgentConfig('project-1', 'support');
    nextBody = { ok: true, agent: 'support', schema_version: 2, block: current.block };
    await updateAgentConfig('project-1', 'support', current.block ?? {});
    expect(calls[1]?.body).toMatchObject({ file: 'agents/support.md', skills: 'all' });
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


describe('repository access compatibility', () => {
  test('reads legacy restricted agents as repository access disabled', async () => {
    for (const workspace of ['runtime', 'read']) {
      nextBody = { agent: 'support', schema_version: 2, block: { workspace } };
      const response = await getAgentConfig('project-1', 'support');
      expect(response.block).toEqual({ repository_access: false });
    }
  });

  test('writes the boolean field when an older caller supplies a supported workspace alias', async () => {
    await updateAgentConfig('project-1', 'support', { workspace: 'runtime' });
    expect(calls[0]?.body).toEqual({ repository_access: false });
  });

  test('rejects conflicting aliases before sending a request', async () => {
    await expect(updateAgentConfig('project-1', 'support', {
      repository_access: true, workspace: 'runtime',
    } as AgentConfigBlock)).rejects.toThrow('repository_access conflicts with workspace');
    expect(calls).toHaveLength(0);
  });

  test('does not turn an unavailable read request into a working session implicitly', async () => {
    await expect(updateAgentConfig('project-1', 'support', { workspace: 'read' }))
      .rejects.toThrow('Set repository_access explicitly');
    expect(calls).toHaveLength(0);
  });
});

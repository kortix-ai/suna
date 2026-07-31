import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type AgentConfigBlock,
  createAgentConfig,
  getAgentConfig,
  previewAgentConfig,
  repairAgentBehavior,
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

  test('returns behavior-file state fields from the backend', async () => {
    nextBody = {
      agent: 'support',
      schema_version: 2,
      editable: true,
      default_agent: 'support',
      behavior_path: '.kortix/opencode/agents/support.md',
      behavior_file_state: 'missing',
      block: { enabled: true, opencode: {} },
    };
    const response = await getAgentConfig('project-1', 'support');
    expect(response.behavior_path).toBe('.kortix/opencode/agents/support.md');
    expect(response.behavior_file_state).toBe('missing');
  });
});

describe('previewAgentConfig', () => {
  test('posts the create draft and serializes connector aliases as canonical', async () => {
    nextBody = {
      agent_name: 'reliance-cto',
      manifest_path: 'kortix.yaml',
      behavior_path: '.kortix/opencode/agents/reliance-cto.md',
      behavior_markdown: 'You are the CTO.',
      preview_revision: 'a'.repeat(64),
    };

    const response = await previewAgentConfig('project-1', {
      agentName: 'reliance-cto',
      block: {
        connectors_personal: ['gmail', 'gmail'],
        opencode: { prompt: 'You are the CTO.' },
      },
    });

    expect(calls[0]?.url).toBe('http://test.local/projects/project-1/agents/preview');
    expect(calls[0]?.body).toEqual({
      agentName: 'reliance-cto',
      block: {
        connectors_required: ['gmail'],
        opencode: { prompt: 'You are the CTO.' },
      },
    });
    expect(response.preview_revision).toBe('a'.repeat(64));
    expect(response.behavior_path).toBe('.kortix/opencode/agents/reliance-cto.md');
  });
});

describe('createAgentConfig', () => {
  test('posts the reviewed preview revision to the create route', async () => {
    nextBody = {
      agent_name: 'reliance-cto',
      manifest_path: 'kortix.yaml',
      behavior_path: '.kortix/opencode/agents/reliance-cto.md',
      preview_revision: 'b'.repeat(64),
      branch: 'kortix/agents/create/reliance-cto-20260730120000-deadbeef',
      commit_sha: 'c'.repeat(40),
      change_request: { cr_id: 'CR1', number: 1 },
    };

    await createAgentConfig('project-1', {
      agentName: 'reliance-cto',
      preview_revision: 'b'.repeat(64),
      block: {
        connectors_personal: ['github'],
        opencode: { prompt: 'You are the CTO.' },
      },
    });

    expect(calls[0]?.url).toBe('http://test.local/projects/project-1/agents');
    expect(calls[0]?.body).toEqual({
      agentName: 'reliance-cto',
      preview_revision: 'b'.repeat(64),
      block: {
        connectors_required: ['github'],
        opencode: { prompt: 'You are the CTO.' },
      },
    });
  });
});

describe('repairAgentBehavior', () => {
  test('posts user-reviewed markdown to the behavior repair route', async () => {
    nextBody = {
      agent_name: 'support',
      manifest_path: 'kortix.yaml',
      behavior_path: '.kortix/opencode/agents/support.md',
      branch: 'kortix/agents/repair/support-20260730120000-deadbeef',
      commit_sha: 'd'.repeat(40),
      change_request: { cr_id: 'CR2', number: 2 },
    };

    await repairAgentBehavior('project-1', 'support', {
      behavior_markdown: '---\ndescription: Support\n---\n\nYou help.',
    });

    expect(calls[0]?.url).toBe(
      'http://test.local/projects/project-1/agents/support/behavior-repair',
    );
    expect(calls[0]?.body).toEqual({
      behavior_markdown: '---\ndescription: Support\n---\n\nYou help.',
    });
  });
});

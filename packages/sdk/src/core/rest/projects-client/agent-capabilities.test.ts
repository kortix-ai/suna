import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type AgentCapabilities,
  capabilityGranted,
  getAgentCapabilities,
  getProjectCapabilities,
  setCapabilityGranted,
} from './agent-capabilities';
import type { AgentConfigBlock } from './agent-config';

let urls: string[] = [];
const CATALOG: AgentCapabilities = {
  agent: 'support',
  schema_version: 3,
  tools: [{ id: 'bash', group: 'workspace', description: 'Run shell commands.', aliases: [], source: null }],
  skills: [{ id: 'kortix-goals', group: 'builtin', description: 'Goals.', feature_flag: 'goals', available: false }],
  extensions: [{ id: 'kortix-turn', group: 'platform', description: 'Turn.', required: true, controlled_by: null }],
};

beforeEach(() => {
  urls = [];
  globalThis.fetch = mock(async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });

describe('getAgentCapabilities', () => {
  test('reads the agent capability catalog route and returns its body', async () => {
    const catalog = await getAgentCapabilities('p1', 'support team');
    expect(urls).toEqual(['http://test.local/projects/p1/agents/support%20team/capabilities']);
    expect(catalog).toEqual(CATALOG);
  });
});

describe('getProjectCapabilities', () => {
  test("reads the project's catalog route: every tool, skill and extension any agent can get", async () => {
    urls = [];
    await getProjectCapabilities('p1');
    expect(urls).toEqual(['http://test.local/projects/p1/capabilities']);
  });
});

describe('capabilityGranted', () => {
  test('all, exclude, a list and none', () => {
    expect(capabilityGranted('all', 'a', 'none')).toBe(true);
    expect(capabilityGranted({ exclude: ['a'] }, 'a', 'none')).toBe(false);
    expect(capabilityGranted({ exclude: ['a'] }, 'b', 'none')).toBe(true);
    expect(capabilityGranted(['a'], 'a', 'none')).toBe(true);
    expect(capabilityGranted(['a'], 'b', 'all')).toBe(false);
    expect(capabilityGranted('none', 'a', 'all')).toBe(false);
    expect(capabilityGranted(['*'], 'a', 'none')).toBe(true);
  });

  test('an omitted grant reads as the default the caller names', () => {
    expect(capabilityGranted(undefined, 'a', 'all')).toBe(true);
    expect(capabilityGranted(undefined, 'a', 'none')).toBe(false);
  });
});

describe('setCapabilityGranted: the smallest manifest value', () => {
  test('turning one item off under all writes { exclude: [that one] }', () => {
    expect(setCapabilityGranted('all', 'kortix-goals', false, 'none')).toEqual({ exclude: ['kortix-goals'] });
    expect(setCapabilityGranted(undefined, 'bash', false, 'all')).toEqual({ exclude: ['bash'] });
  });

  test('an alias list goes off and on together', () => {
    expect(setCapabilityGranted('all', ['agent', 'task'], false, 'all')).toEqual({ exclude: ['agent', 'task'] });
    expect(setCapabilityGranted({ exclude: ['agent', 'task', 'bash'] }, ['agent', 'task'], true, 'all')).toEqual({ exclude: ['bash'] });
  });

  test('the last excluded item turned back on returns to all', () => {
    expect(setCapabilityGranted({ exclude: ['a'] }, 'a', true, 'none')).toBe('all');
  });

  test('a list adds and removes; an empty list is none; none turns one on as a list', () => {
    expect(setCapabilityGranted(['a'], 'b', true, 'none')).toEqual(['a', 'b']);
    expect(setCapabilityGranted(['a', 'b'], 'a', false, 'none')).toEqual(['b']);
    expect(setCapabilityGranted(['a'], 'a', false, 'none')).toBe('none');
    expect(setCapabilityGranted('none', 'a', true, 'all')).toEqual(['a']);
    expect(setCapabilityGranted(undefined, 'a', true, 'none')).toEqual(['a']);
  });

  test('a no-op change returns the grant as it was', () => {
    expect(setCapabilityGranted('all', 'a', true, 'none')).toBe('all');
    expect(setCapabilityGranted(['a'], 'a', true, 'none')).toEqual(['a']);
  });
});

describe('AgentConfigBlock', () => {
  test('carries the exclude form for skills and extensions, and the tools and codemode keys', () => {
    const block: AgentConfigBlock = {
      skills: { exclude: ['kortix-goals'] },
      extensions: { exclude: ['audit'] },
      tools: { exclude: ['codemode'] },
      codemode: 'off',
    };
    expect(block.skills).toEqual({ exclude: ['kortix-goals'] });
  });
});

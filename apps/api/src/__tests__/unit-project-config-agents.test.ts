import { describe, expect, test } from 'bun:test';

import { resolveConfigAgents } from '../projects/git/config';
import type { LoadedAgents } from '../projects/agents';

const nativeAgents = [
  {
    name: 'kortix',
    path: '.kortix/opencode/agents/kortix.md',
    description: 'Default Kortix agent',
    mode: 'primary',
  },
  {
    name: 'release-bot',
    path: '.kortix/opencode/agents/release-bot.md',
    description: 'Ships releases',
    mode: 'subagent',
  },
];

describe('project config agent discovery', () => {
  test('no [[agents]] keeps legacy OpenCode discovery', () => {
    const result = resolveConfigAgents(nativeAgents, { specs: [], errors: [] });

    expect(result.agent_discovery).toBe('opencode');
    expect(result.agents).toEqual([
      { ...nativeAgents[0], source: 'opencode', enabled: true },
      { ...nativeAgents[1], source: 'opencode', enabled: true },
    ]);
  });

  test('[[agents]] becomes the launchable server-side roster', () => {
    const loaded: LoadedAgents = {
      errors: [],
      specs: [
        {
          name: 'kortix',
          path: 'kortix.toml#agents.kortix',
          enabled: true,
          connectors: 'all',
          kortixCli: 'all',
          env: 'all',
          file: null,
          model: null,
        },
        {
          name: 'triage',
          path: 'kortix.toml#agents.triage',
          enabled: true,
          connectors: [],
          kortixCli: [],
          env: 'all',
          file: '.kortix/opencode/agents/release-bot.md',
          model: null,
        },
        {
          name: 'disabled',
          path: 'kortix.toml#agents.disabled',
          enabled: false,
          connectors: [],
          kortixCli: [],
          env: 'all',
          file: null,
          model: null,
        },
      ],
    };

    const result = resolveConfigAgents(nativeAgents, loaded);

    expect(result.agent_discovery).toBe('declarative');
    expect(result.agents).toEqual([
      {
        name: 'kortix',
        path: '.kortix/opencode/agents/kortix.md',
        description: 'Default Kortix agent',
        mode: 'primary',
        source: 'kortix.toml',
        enabled: true,
        scope: { env: 'all', connectors: 'all', kortix_cli: 'all' },
      },
      {
        name: 'triage',
        path: '.kortix/opencode/agents/release-bot.md',
        description: 'Ships releases',
        mode: 'subagent',
        source: 'kortix.toml',
        enabled: true,
        scope: { env: 'all', connectors: [], kortix_cli: [] },
      },
    ]);
  });

  test('per-agent env/connectors/CLI allowlists surface as read-only scope', () => {
    const loaded: LoadedAgents = {
      errors: [],
      specs: [
        {
          name: 'support_bot',
          path: 'kortix.toml#agents.support_bot',
          enabled: true,
          connectors: ['stripe'],
          kortixCli: ['project.read'],
          env: ['GITHUB_TOKEN', 'OPENAI_API_KEY'],
          file: null,
          model: null,
        },
      ],
    };

    const [agent] = resolveConfigAgents(nativeAgents, loaded).agents;
    // The UI reads exactly this to render the per-agent scope panel — note the
    // wire key is `kortix_cli` (snake_case), mapped from the spec's `kortixCli`.
    expect(agent?.scope).toEqual({
      env: ['GITHUB_TOKEN', 'OPENAI_API_KEY'],
      connectors: ['stripe'],
      kortix_cli: ['project.read'],
    });
  });

  test('OpenCode-discovered agents carry no [[agents]] scope', () => {
    const result = resolveConfigAgents(nativeAgents, { specs: [], errors: [] });
    expect(result.agents.every((a) => a.scope === undefined)).toBe(true);
  });

  test('invalid [agents] adoption disables legacy discovery instead of silently exposing all agents', () => {
    const result = resolveConfigAgents(nativeAgents, {
      specs: [],
      errors: [{
        name: '(top-level)',
        path: 'kortix.toml',
        error: '`agents` must use [[agents]]',
      }],
    });

    expect(result.agent_discovery).toBe('declarative');
    expect(result.agents).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2/client';

import type { ProjectConfigSummary } from '../rest/projects-client';
import {
  composerSelectableAgents,
  projectConfigAgentsToOpenCodeAgents,
  resolveComposerAgent,
} from './composer-agents';

/**
 * The composer's agent list, framework-free. Web and mobile both build the
 * picker from these functions, so the rules live here once: hidden agents
 * never show, subagents are dispatched (never picked), `project-manager` is
 * gated on the projects paradigm, and the project default sorts first.
 */

function agent(name: string, extra: Partial<Agent> = {}): Agent {
  return { name, mode: 'primary', ...extra } as unknown as Agent;
}

function config(input: {
  default_agent?: string | null;
  open_code_default_agent?: string | null;
  agents: Array<{ name: string; enabled?: boolean; mode?: string }>;
}): ProjectConfigSummary {
  return {
    open_code_default_agent: input.open_code_default_agent ?? null,
    default_agent: input.default_agent,
    agents: input.agents.map((a) => ({
      path: `${a.name}.md`,
      description: null,
      source: 'kortix_yaml',
      ...a,
    })),
  } as unknown as ProjectConfigSummary;
}

describe('projectConfigAgentsToOpenCodeAgents', () => {
  test('default_agent sorts first and wins over the deprecated open_code_default_agent', () => {
    const agents = projectConfigAgentsToOpenCodeAgents(
      config({
        default_agent: 'support',
        open_code_default_agent: 'kortix',
        agents: [{ name: 'kortix' }, { name: 'support' }],
      }),
    );
    expect(agents.map((a) => a.name)).toEqual(['support', 'kortix']);
  });

  test('falls back to open_code_default_agent, then manifest order', () => {
    expect(
      projectConfigAgentsToOpenCodeAgents(
        config({ open_code_default_agent: 'b', agents: [{ name: 'a' }, { name: 'b' }] }),
      ).map((a) => a.name),
    ).toEqual(['b', 'a']);
    expect(
      projectConfigAgentsToOpenCodeAgents(config({ agents: [{ name: 'a' }, { name: 'b' }] })).map(
        (a) => a.name,
      ),
    ).toEqual(['a', 'b']);
  });

  test('a disabled manifest agent becomes hidden', () => {
    const [off, on] = projectConfigAgentsToOpenCodeAgents(
      config({ agents: [{ name: 'off', enabled: false }, { name: 'on' }] }),
    );
    expect(off?.hidden).toBe(true);
    expect(on?.hidden).toBe(false);
  });
});

describe('composerSelectableAgents', () => {
  const roster = [
    agent('kortix'),
    agent('ghost', { hidden: true }),
    agent('helper', { mode: 'subagent' }),
    agent('project-manager'),
  ];

  test('default: drops hidden agents and subagents, keeps project-manager (web picker contract)', () => {
    expect(composerSelectableAgents(roster).map((a) => a.name)).toEqual([
      'kortix',
      'project-manager',
    ]);
  });

  test('enableProjects: false drops project-manager', () => {
    expect(
      composerSelectableAgents(roster, { enableProjects: false }).map((a) => a.name),
    ).toEqual(['kortix']);
  });

  test('includeSubagents keeps subagents (the runtime roster), still drops hidden', () => {
    expect(
      composerSelectableAgents(roster, { includeSubagents: true, enableProjects: false }).map(
        (a) => a.name,
      ),
    ).toEqual(['kortix', 'helper']);
  });

  test('a non-array roster is empty', () => {
    expect(composerSelectableAgents(undefined)).toEqual([]);
  });
});

describe('resolveComposerAgent', () => {
  test('an empty roster refuses an unbound composer', () => {
    expect(resolveComposerAgent({ agents: [], defaultAgent: 'kortix' })).toEqual({
      selected: null,
      disabled: true,
      reason: 'no_access',
    });
  });

  test('a pending roster refuses nothing and shows the pick', () => {
    expect(resolveComposerAgent({ agents: undefined, selectedAgent: 'support' })).toEqual({
      selected: 'support',
      disabled: false,
      reason: 'loading',
    });
  });

  test('pick > bound > accessible default > first accessible', () => {
    const agents = [agent('meta'), agent('kortix')];
    expect(resolveComposerAgent({ agents, selectedAgent: 'kortix', boundAgent: 'meta' }).reason).toBe(
      'selected',
    );
    expect(resolveComposerAgent({ agents, boundAgent: 'meta', defaultAgent: 'kortix' })).toEqual({
      selected: 'meta',
      disabled: false,
      reason: 'bound',
    });
    expect(resolveComposerAgent({ agents, defaultAgent: 'kortix' }).selected).toBe('kortix');
    expect(resolveComposerAgent({ agents, defaultAgent: 'nope' })).toEqual({
      selected: 'meta',
      disabled: false,
      reason: 'first_accessible',
    });
  });
});

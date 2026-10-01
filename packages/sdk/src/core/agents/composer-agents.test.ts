import { afterEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2/client';

import { configureKortix } from '../http/config';
import type { ProjectConfigSummary } from '../rest/projects-client';
import {
  composerSelectableAgents,
  projectConfigAgentsToRuntimeAgents,
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

describe('projectConfigAgentsToRuntimeAgents', () => {
  test('default_agent sorts first and wins over the deprecated open_code_default_agent', () => {
    const agents = projectConfigAgentsToRuntimeAgents(
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
      projectConfigAgentsToRuntimeAgents(
        config({ open_code_default_agent: 'b', agents: [{ name: 'a' }, { name: 'b' }] }),
      ).map((a) => a.name),
    ).toEqual(['b', 'a']);
    expect(
      projectConfigAgentsToRuntimeAgents(config({ agents: [{ name: 'a' }, { name: 'b' }] })).map(
        (a) => a.name,
      ),
    ).toEqual(['a', 'b']);
  });

  test('a disabled manifest agent becomes hidden', () => {
    const [off, on] = projectConfigAgentsToRuntimeAgents(
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

  const base = { backendUrl: '', getToken: async () => null };
  afterEach(() => configureKortix(base));

  test('isSelectableAgent (#8007): drops hidden agents and subagents; project-manager only with enableProjects', () => {
    configureKortix({ ...base, featureFlags: { enableProjects: false } });
    expect(composerSelectableAgents(roster).map((a) => a.name)).toEqual(['kortix']);
    configureKortix({ ...base, featureFlags: { enableProjects: true } });
    expect(composerSelectableAgents(roster).map((a) => a.name)).toEqual(['kortix', 'project-manager']);
  });

  test('includeSubagents keeps subagents (the runtime roster), still drops hidden', () => {
    configureKortix({ ...base, featureFlags: { enableProjects: false } });
    expect(composerSelectableAgents(roster, { includeSubagents: true }).map((a) => a.name)).toEqual([
      'kortix',
      'helper',
    ]);
  });

  test('nothing to offer from no roster', () => {
    expect(composerSelectableAgents(undefined)).toEqual([]);
  });

  test('drops the OpenCode built-ins the runtime list carries (KRTX-642)', () => {
    configureKortix({ ...base, featureFlags: { enableProjects: false } });
    const runtime = [
      agent('kortix'),
      agent('build', { native: true }),
      agent('plan', { native: true }),
      agent('explore', { mode: 'subagent', native: true }),
      agent('helper', { mode: 'subagent' }),
    ];
    expect(composerSelectableAgents(runtime).map((a) => a.name)).toEqual(['kortix']);
    // Lifting the subagent check for the runtime roster must not readmit them.
    expect(
      composerSelectableAgents(runtime, { includeSubagents: true }).map((a) => a.name),
    ).toEqual(['kortix', 'helper']);
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

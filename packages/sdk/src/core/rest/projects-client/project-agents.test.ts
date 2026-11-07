import { afterEach, describe, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { isSelectableAgent, selectableWorkspaceAgents } from './project-agents';
import type { ProjectConfigSummary } from './projects';

type ConfigAgent = ProjectConfigSummary['agents'][number];

function agent(name: string, extra: Partial<ConfigAgent> = {}): ConfigAgent {
  return { name, path: `.kortix/agents/${name}.md`, description: null, mode: null, ...extra };
}

function config(agents: ConfigAgent[], defaultAgent: string | null = null): ProjectConfigSummary {
  return {
    is_kortix_repo: true,
    signals: {},
    manifest_raw: null,
    default_agent: defaultAgent,
    agent_discovery: 'declarative',
    agents,
  } as ProjectConfigSummary;
}

const base = { backendUrl: '', getToken: async () => null };

afterEach(() => configureKortix(base));

describe('isSelectableAgent', () => {
  test('accepts primary, all, and mode-less agents', () => {
    expect(isSelectableAgent({ name: 'a', mode: 'primary' })).toBe(true);
    expect(isSelectableAgent({ name: 'b', mode: 'all' })).toBe(true);
    expect(isSelectableAgent({ name: 'c', mode: null })).toBe(true);
    expect(isSelectableAgent({ name: 'd' })).toBe(true);
  });

  test('rejects subagents, hidden agents, and disabled agents', () => {
    expect(isSelectableAgent({ name: 'a', mode: 'subagent' })).toBe(false);
    expect(isSelectableAgent({ name: 'b', hidden: true })).toBe(false);
    expect(isSelectableAgent({ name: 'c', enabled: false })).toBe(false);
  });

  test('rejects the OpenCode built-ins, which the runtime marks native', () => {
    // The runtime's own agent list carries `native: true` for build/plan/general/
    // explore; they are not project agents and must never reach a picker.
    expect(isSelectableAgent({ name: 'build', mode: 'primary', native: true })).toBe(false);
    expect(isSelectableAgent({ name: 'plan', mode: 'primary', native: true })).toBe(false);
    expect(isSelectableAgent({ name: 'general', mode: 'subagent', native: true })).toBe(false);
    expect(isSelectableAgent({ name: 'explore', mode: 'subagent', native: true })).toBe(false);
  });

  test('gates project-manager behind the projects flag', () => {
    configureKortix({ ...base, featureFlags: { enableProjects: false } });
    expect(isSelectableAgent({ name: 'project-manager' })).toBe(false);
    configureKortix({ ...base, featureFlags: { enableProjects: true } });
    expect(isSelectableAgent({ name: 'project-manager' })).toBe(true);
  });

  test('does not filter by name: a project agent called build (native: false) stays selectable', () => {
    expect(isSelectableAgent({ name: 'build', mode: 'primary' })).toBe(true);
    expect(isSelectableAgent({ name: 'build', mode: 'primary', native: false })).toBe(true);
  });
});

describe('selectableProjectAgents', () => {
  test('returns only the selectable project agents, default first', () => {
    const roster = selectableWorkspaceAgents(
      config(
        [
          agent('engineering', { mode: 'primary' }),
          agent('explore', { mode: 'subagent' }),
          agent('archived', { enabled: false }),
          agent('kortix', { mode: 'primary' }),
        ],
        'kortix',
      ),
    );
    expect(roster.map((a) => a.name)).toEqual(['kortix', 'engineering']);
  });

  test('reads only default_agent: the deprecated open_code_default_agent does not reorder', () => {
    const summary = config([agent('a'), agent('b')]);
    summary.open_code_default_agent = 'b';
    expect(selectableWorkspaceAgents(summary).map((a) => a.name)).toEqual(['a', 'b']);
  });

  test('does not mutate the config it reads', () => {
    const summary = config([agent('a'), agent('b')], 'b');
    selectableWorkspaceAgents(summary);
    expect(summary.agents.map((a) => a.name)).toEqual(['a', 'b']);
  });

  test('returns an empty roster for a config without agents', () => {
    expect(selectableWorkspaceAgents(config([]))).toEqual([]);
  });
});

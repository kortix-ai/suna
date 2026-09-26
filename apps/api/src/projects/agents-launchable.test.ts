import { describe, expect, test } from 'bun:test';
import { type AgentSpec, type LoadedAgents, isLaunchableAgentName } from './agents';

function spec(name: string, enabled = true): AgentSpec {
  return {
    name,
    path: `kortix.yaml#agents.${name}`,
    enabled,
    connectors: 'all',
    permissions: 'all',
    env: 'all',
    file: null,
    model: null,
  };
}

const governed: LoadedAgents = {
  specs: [spec('galileo'), spec('galileo-admin'), spec('retired', false)],
  errors: [],
  defaultAgent: 'galileo',
};

describe('isLaunchableAgentName', () => {
  test('a declared, enabled agent is launchable', () => {
    expect(isLaunchableAgentName('galileo', governed)).toBe(true);
  });

  test('an agent another project declares is NOT launchable here', () => {
    // INC-2026-09-15: `chief-of-staff` (declared in a different project) was
    // written onto session tokens of unrelated projects.
    expect(isLaunchableAgentName('chief-of-staff', governed)).toBe(false);
  });

  test('a disabled agent is not launchable', () => {
    expect(isLaunchableAgentName('retired', governed)).toBe(false);
  });

  test('the default sentinel and the platform meta agent are always launchable', () => {
    expect(isLaunchableAgentName('default', governed)).toBe(true);
    expect(isLaunchableAgentName('meta', governed)).toBe(true);
  });

  test("OpenCode's built-in agents stay launchable in a governed project — a plan/build pick keeps running", () => {
    for (const builtin of ['build', 'plan', 'general', 'explore']) {
      expect(isLaunchableAgentName(builtin, governed)).toBe(true);
    }
  });

  test('a project with no per-agent governance keeps the runtime roster as the authority', () => {
    expect(isLaunchableAgentName('build', { specs: [], errors: [] })).toBe(true);
  });

  test('a manifest that failed to parse proves nothing: fail closed', () => {
    const broken: LoadedAgents = {
      specs: [],
      errors: [{ name: '(manifest)', path: 'kortix.yaml', error: 'bad yaml' }],
    };
    expect(isLaunchableAgentName('chief-of-staff', broken)).toBe(false);
  });

  test('names are compared exactly after trimming', () => {
    expect(isLaunchableAgentName('  galileo ', governed)).toBe(true);
    expect(isLaunchableAgentName('Galileo', governed)).toBe(false);
    expect(isLaunchableAgentName('', governed)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import { projectConfigAgentsToRuntimeAgents } from './agents';

const config = (defaultAgent: string | null, legacyDefaultAgent = defaultAgent) =>
  ({
    runtime_default_agent: defaultAgent,
    open_code_default_agent: legacyDefaultAgent,
    agents: [
      { name: 'kortix', path: 'kortix.md', description: null, mode: 'primary' },
      {
        name: 'memory-reflector',
        path: 'memory-reflector.md',
        description: null,
        mode: 'primary',
      },
    ],
  }) as any;

describe('projectConfigAgentsToRuntimeAgents', () => {
  test('places the declared project default first for fallback consumers', () => {
    expect(
      projectConfigAgentsToRuntimeAgents(config('memory-reflector')).map((agent) => agent.name),
    ).toEqual(['memory-reflector', 'kortix']);
  });

  test('falls back to the legacy default field for older API responses', () => {
    expect(
      projectConfigAgentsToRuntimeAgents(config(null, 'memory-reflector')).map((agent) => agent.name),
    ).toEqual(['memory-reflector', 'kortix']);
  });

  test('preserves manifest order when there is no declared default', () => {
    expect(projectConfigAgentsToRuntimeAgents(config(null)).map((agent) => agent.name)).toEqual([
      'kortix',
      'memory-reflector',
    ]);
  });
});

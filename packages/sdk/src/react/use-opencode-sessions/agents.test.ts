import { describe, expect, test } from 'bun:test';

import type { ProjectConfigSummary } from '../../core/rest/projects-client';
import { projectConfigAgentsToOpenCodeAgents } from './agents';

const config = (defaultAgent: string | null) =>
  ({
    open_code_default_agent: defaultAgent,
    agents: [
      { name: 'kortix', path: 'kortix.md', description: null, mode: 'primary' },
      {
        name: 'memory-reflector',
        path: 'memory-reflector.md',
        description: null,
        mode: 'primary',
      },
    ],
  }) as ProjectConfigSummary;

describe('projectConfigAgentsToOpenCodeAgents', () => {
  test('places the declared project default first for fallback consumers', () => {
    expect(
      projectConfigAgentsToOpenCodeAgents(config('memory-reflector')).map((agent) => agent.name),
    ).toEqual(['memory-reflector', 'kortix']);
  });

  test('preserves manifest order when there is no declared default', () => {
    expect(projectConfigAgentsToOpenCodeAgents(config(null)).map((agent) => agent.name)).toEqual([
      'kortix',
      'memory-reflector',
    ]);
  });

  test('preserves runtime and harness metadata for project agent consumers', () => {
    const input = config('memory-reflector');
    input.agents[1] = {
      ...input.agents[1],
      runtime: 'codex',
      harness: 'codex',
      native_agent: 'reviewer',
    };

    expect(projectConfigAgentsToOpenCodeAgents(input)[0]).toMatchObject({
      name: 'memory-reflector',
      runtime: 'codex',
      harness: 'codex',
      nativeAgent: 'reviewer',
    });
  });
});

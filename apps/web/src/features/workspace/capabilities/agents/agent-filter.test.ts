import { describe, expect, test } from 'bun:test';
import { agentInMode, filterAgents } from './agent-filter';

const agent = (name: string, mode: string | null, description: string | null = null) => ({
  name,
  path: `.kortix/opencode/agents/${name}.md`,
  description,
  mode,
});

describe('agentInMode', () => {
  test('matches its own declared mode', () => {
    expect(agentInMode(agent('kortix', 'primary'), 'primary')).toBe(true);
    expect(agentInMode(agent('kortix', 'primary'), 'subagent')).toBe(false);
    expect(agentInMode(agent('reviewer', 'subagent'), 'subagent')).toBe(true);
  });

  test("mode 'all' matches BOTH filters", () => {
    // Not a third bucket — 'all' means usable both ways, so filtering it into
    // a tab of its own would hide it from the two people looking for it.
    expect(agentInMode(agent('both', 'all'), 'primary')).toBe(true);
    expect(agentInMode(agent('both', 'all'), 'subagent')).toBe(true);
  });

  test('an undeclared mode reads as primary', () => {
    // The runtime assumes primary when the frontmatter omits `mode`. If this
    // filtered as "neither", the project default agent would vanish under the
    // Primary tab.
    expect(agentInMode(agent('kortix', null), 'primary')).toBe(true);
    expect(agentInMode(agent('kortix', null), 'subagent')).toBe(false);
  });

  test('is case-insensitive on the declared value', () => {
    expect(agentInMode(agent('kortix', 'Primary'), 'primary')).toBe(true);
    expect(agentInMode(agent('both', 'ALL'), 'subagent')).toBe(true);
  });
});

describe('filterAgents', () => {
  const all = [
    agent('kortix', 'primary', 'Generic Kortix general knowledge worker'),
    agent('memory-reflector', 'primary', 'Reflects on recent project activity'),
    agent('reviewer', 'subagent'),
    agent('utility', 'all'),
  ];

  test('mode null returns everything', () => {
    expect(filterAgents(all, { mode: null, query: '' })).toHaveLength(4);
  });

  test('mode narrows, keeping the both-ways agent in each', () => {
    expect(filterAgents(all, { mode: 'primary', query: '' }).map((a) => a.name)).toEqual([
      'kortix',
      'memory-reflector',
      'utility',
    ]);
    expect(filterAgents(all, { mode: 'subagent', query: '' }).map((a) => a.name)).toEqual([
      'reviewer',
      'utility',
    ]);
  });

  test('query matches name and description, case-insensitively', () => {
    expect(filterAgents(all, { mode: null, query: 'MEMORY' }).map((a) => a.name)).toEqual([
      'memory-reflector',
    ]);
    expect(filterAgents(all, { mode: null, query: 'knowledge' }).map((a) => a.name)).toEqual([
      'kortix',
    ]);
  });

  test('a null description never throws on search', () => {
    expect(filterAgents([agent('reviewer', 'subagent')], { mode: null, query: 'x' })).toEqual([]);
  });

  test('mode and query compose', () => {
    expect(filterAgents(all, { mode: 'subagent', query: 'memory' })).toHaveLength(0);
  });
});

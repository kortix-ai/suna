import { describe, expect, test } from 'bun:test';
import { filterAgents } from './agent-filter';

const agent = (name: string, mode: string | null, description: string | null = null) => ({
  name,
  path: `.kortix/opencode/agents/${name}.md`,
  description,
  mode,
});

describe('filterAgents', () => {
  const all = [
    agent('kortix', 'primary', 'Generic Kortix general knowledge worker'),
    agent('memory-reflector', 'primary', 'Reflects on recent project activity'),
    agent('reviewer', 'subagent'),
    agent('utility', 'all'),
  ];

  test('mode null returns everything', () => {
    expect(filterAgents(all, { query: '' })).toHaveLength(4);
  });

  test('query matches name and description, case-insensitively', () => {
    expect(filterAgents(all, { query: 'MEMORY' }).map((a) => a.name)).toEqual(['memory-reflector']);
    expect(filterAgents(all, { query: 'knowledge' }).map((a) => a.name)).toEqual(['kortix']);
  });

  test('a null description never throws on search', () => {
    expect(filterAgents([agent('reviewer', 'subagent')], { query: 'x' })).toEqual([]);
  });
});

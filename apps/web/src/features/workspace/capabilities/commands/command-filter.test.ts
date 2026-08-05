import { describe, expect, test } from 'bun:test';
import { filterCommands } from './command-filter';

const command = (name: string, description: string | null = null) => ({
  name,
  path: `.opencode/command/${name}.md`,
  description,
});

describe('filterCommands', () => {
  const all = [
    command('deploy', 'Ship the current branch'),
    command('rollback'),
    command('status', 'Check deploy health'),
  ];

  test('empty query returns everything', () => {
    expect(filterCommands(all, { query: '' }).map((c) => c.name)).toEqual([
      'deploy',
      'rollback',
      'status',
    ]);
  });

  test('query matches name, case-insensitively', () => {
    expect(filterCommands(all, { query: 'ROLL' }).map((c) => c.name)).toEqual(['rollback']);
  });

  test('query matches description, case-insensitively', () => {
    expect(filterCommands(all, { query: 'health' }).map((c) => c.name)).toEqual(['status']);
  });

  test('a command with no description still matches by name', () => {
    expect(filterCommands(all, { query: 'rollback' })).toHaveLength(1);
  });

  test('no match returns an empty array', () => {
    expect(filterCommands(all, { query: 'nonexistent' })).toEqual([]);
  });

  test('whitespace-only query behaves like empty', () => {
    expect(filterCommands(all, { query: '   ' })).toHaveLength(3);
  });
});

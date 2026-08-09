import { describe, expect, test } from 'bun:test';

import { SLASH_ACTIONS } from './slash-actions';
import { buildSlashSections, groupCommandsBySource } from './slash-items';

const cmd = (name: string, source?: 'command' | 'mcp' | 'skill', description = '') =>
  ({ name, description, template: '', hints: [], source }) as never;

describe('groupCommandsBySource', () => {
  test('no commands produces no groups', () => {
    expect(groupCommandsBySource([])).toEqual([]);
  });

  test('every command with source undefined degrades to a single "Commands" group', () => {
    const groups = groupCommandsBySource([cmd('build'), cmd('test')]);
    expect(groups.map((g) => g.heading)).toEqual(['Commands']);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['build', 'test']);
  });

  // Correction over the brief: the live server may not populate
  // `source: 'skill'` at all today, so "every command shares one source" —
  // even when that source is explicitly 'skill', not just undefined — must
  // ALSO degrade to a plain "Commands" heading, never a lone "Skills"
  // heading with nothing to contrast it against.
  test('every command sharing one explicit source ALSO degrades to a single "Commands" group', () => {
    const groups = groupCommandsBySource([cmd('deploy', 'skill'), cmd('release', 'skill')]);
    expect(groups.map((g) => g.heading)).toEqual(['Commands']);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['deploy', 'release']);
  });

  test('mixing skill and plain commands splits into Skills and Commands, in that order', () => {
    const groups = groupCommandsBySource([cmd('build'), cmd('deploy', 'skill')]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills', 'Commands']);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['deploy']);
    expect(groups[1].commands.map((c) => c.name)).toEqual(['build']);
  });

  test('mixing all three sources renders Skills, MCP, Commands in that fixed order', () => {
    const groups = groupCommandsBySource([
      cmd('build'),
      cmd('fetch-issue', 'mcp'),
      cmd('deploy', 'skill'),
    ]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills', 'MCP', 'Commands']);
  });

  test('a bucket with zero matches is omitted — no empty heading', () => {
    const groups = groupCommandsBySource([cmd('deploy', 'skill'), cmd('fetch-issue', 'mcp')]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills', 'MCP']);
  });
});

describe('buildSlashSections', () => {
  test('assigns a contiguous flat index across every command group and the actions section', () => {
    const sections = buildSlashSections({
      commands: [cmd('build'), cmd('fetch-issue', 'mcp'), cmd('deploy', 'skill')],
      query: '',
    });
    const indices = sections.flatMap((s) => s.rows.map((r) => r.index));
    expect(indices).toEqual(Array.from({ length: indices.length }, (_, i) => i));
    // Skills, MCP, Commands, Actions — in that order.
    expect(sections.map((s) => s.heading)).toEqual(['Skills', 'MCP', 'Commands', 'Actions']);
  });

  test('an empty query returns every command and every action', () => {
    const sections = buildSlashSections({ commands: [cmd('build'), cmd('test')], query: '' });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows.filter((r) => r.type === 'command')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'action')).toHaveLength(SLASH_ACTIONS.length);
  });

  test('filters commands by name', () => {
    const sections = buildSlashSections({
      commands: [cmd('build'), cmd('test-runner')],
      query: 'test',
    });
    const commandRows = sections.flatMap((s) => s.rows).filter((r) => r.type === 'command');
    expect(commandRows.map((r) => r.name)).toEqual(['test-runner']);
  });

  test('filters commands by description too', () => {
    const sections = buildSlashSections({
      commands: [cmd('build', undefined, 'Compiles the project'), cmd('lint', undefined, 'Checks style')],
      query: 'compile',
    });
    const commandRows = sections.flatMap((s) => s.rows).filter((r) => r.type === 'command');
    expect(commandRows.map((r) => r.name)).toEqual(['build']);
  });

  test('filters actions via the same query, alongside commands', () => {
    const sections = buildSlashSections({ commands: [cmd('build')], query: 'voice' });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.name)).toEqual(['Start voice input']);
  });

  test('no commands leaves just the Actions section, indices starting at 0', () => {
    const sections = buildSlashSections({ commands: [], query: '' });
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Actions');
    expect(sections[0].rows[0].index).toBe(0);
  });

  test('no commands and a non-matching query returns no sections at all', () => {
    const sections = buildSlashSections({ commands: [], query: 'zzzzz-nothing-matches' });
    expect(sections).toEqual([]);
  });

  test('each command row carries its source Command object for selection', () => {
    const c = cmd('build');
    const sections = buildSlashSections({ commands: [c], query: '' });
    const row = sections.flatMap((s) => s.rows).find((r) => r.type === 'command');
    expect(row?.command).toBe(c);
  });

  test('each action row carries its source SlashAction object for selection', () => {
    const sections = buildSlashSections({ commands: [], query: 'model' });
    const row = sections.flatMap((s) => s.rows).find((r) => r.type === 'action');
    expect(row?.action?.id).toBe('switch-model');
  });

  test('a custom actions list overrides the SLASH_ACTIONS default', () => {
    const sections = buildSlashSections({
      commands: [],
      actions: [{ id: 'set-scope', label: 'Set scope', description: 'x' }],
      query: '',
    });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Set scope');
  });
});

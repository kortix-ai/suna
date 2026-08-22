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

  // REVERSED (deliberately, see `groupCommandsBySource`'s doc comment). This
  // previously asserted a lone 'skill' bucket degrades to a "Commands"
  // heading. That rule only ever considered the unfiltered list; against real
  // data it relabelled rows mid-keystroke, because a query that happens to
  // match only skills leaves exactly one non-empty bucket. The rows do not
  // change — only the heading above them does — which reads as the list having
  // been swapped out. A lone "Skills" heading is accurate and is what the
  // reference UX shows.
  test('a lone explicit source keeps its own heading rather than degrading', () => {
    const groups = groupCommandsBySource([cmd('deploy', 'skill'), cmd('release', 'skill')]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills']);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['deploy', 'release']);
  });

  // The regression the reversal above must not reintroduce: filtering a mixed
  // list down to one bucket keeps that bucket's heading stable.
  test('filtering a mixed list down to skills alone keeps the "Skills" heading', () => {
    const all = [cmd('build'), cmd('deploy', 'skill'), cmd('design', 'skill')];
    expect(groupCommandsBySource(all).map((g) => g.heading)).toEqual(['Skills', 'Commands']);

    const filtered = all.filter((c) => (c as unknown as { name: string }).name.includes('de'));
    expect(groupCommandsBySource(filtered).map((g) => g.heading)).toEqual(['Skills']);
  });

  test('mixing skill and plain commands splits into Skills and Commands, in that order', () => {
    const groups = groupCommandsBySource([cmd('build'), cmd('deploy', 'skill')]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills', 'Commands']);
    expect(groups[0].commands.map((c) => c.name)).toEqual(['deploy']);
    expect(groups[1].commands.map((c) => c.name)).toEqual(['build']);
  });

  test('mixing all three sources renders Skills, Commands, MCP in that fixed order', () => {
    const groups = groupCommandsBySource([
      cmd('build'),
      cmd('fetch-issue', 'mcp'),
      cmd('deploy', 'skill'),
    ]);
    expect(groups.map((g) => g.heading)).toEqual(['Skills', 'Commands', 'MCP']);
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
    expect(sections.map((s) => s.heading)).toEqual(['Actions', 'Skills', 'Commands', 'MCP']);
  });

  test('the flat index starts in Actions, so the default selection is the first action', () => {
    // Actions render first, so index 0 must BE an action. `MenuNavState`
    // opens at index 0 and `slash-menu.tsx` paints the highlight from the
    // same number — if the counter were still assigned commands-first while
    // Actions rendered on top, the highlight would sit on a row the user
    // cannot see at the position the keyboard thinks it is on.
    const sections = buildSlashSections({
      commands: [cmd('build'), cmd('deploy', 'skill')],
      query: '',
    });
    const first = sections[0].rows[0];

    expect(first.index).toBe(0);
    expect(first.type).toBe('action');
  });

  test('MCP renders after plain Commands, not between Skills and Commands', () => {
    const sections = buildSlashSections({
      commands: [cmd('fetch-issue', 'mcp'), cmd('build'), cmd('deploy', 'skill')],
      query: '',
    });

    expect(sections.map((s) => s.heading)).toEqual(['Actions', 'Skills', 'Commands', 'MCP']);
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
    // 'voice' matches one of each — the "alongside commands" the test name
    // claims — and the expected order doubles as a check that Actions render
    // before Commands. It queried 'scope' while `set-scope` existed; that row
    // was removed because it opened nothing, and `start-voice` came back with
    // a real control behind it (`VoiceRecorder` in the composer toolbar).
    const sections = buildSlashSections({
      commands: [cmd('build'), cmd('voice-check')],
      query: 'voice',
    });
    const rows = sections.flatMap((s) => s.rows);

    expect(rows.map((r) => r.name)).toEqual(['Start voice input', 'voice-check']);
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
      actions: [{ id: 'attach-file', label: 'Only row', description: 'x' }],
      query: '',
    });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Only row');
  });
});

describe('buildSlashSections — the Actions section renders without its heading', () => {
  test('Actions is marked hideHeading; the command sections are not', () => {
    // Actions render first and are the fixed rows, so a heading above them
    // would label the top of the list rather than separate anything. The
    // headings BELOW still separate, which is the job headings are here for.
    const sections = buildSlashSections({
      commands: [cmd('build'), cmd('deploy', 'skill')],
      query: '',
    });
    const byHeading = Object.fromEntries(sections.map((s) => [s.heading, s.hideHeading]));

    expect(byHeading.Actions).toBe(true);
    expect(byHeading.Skills).toBeUndefined();
    expect(byHeading.Commands).toBeUndefined();
  });

  test('`heading` stays populated even when hidden', () => {
    // It is still the React key in `slash-menu.tsx` AND what `SlashRowIcon`
    // reads to pick a glyph. Blanking it to hide the label would break both.
    const sections = buildSlashSections({ commands: [], query: '' });

    expect(sections[0].heading).toBe('Actions');
    expect(sections[0].hideHeading).toBe(true);
  });
});

describe('buildSlashSections — an action carries its current value', () => {
  const withAgent = [
    { id: 'switch-agent' as const, label: 'Switch agent', description: 'x', value: 'Orchestrator' },
  ];

  test("the host's value reaches the row, so the palette shows the live agent", () => {
    const sections = buildSlashSections({ commands: [], actions: withAgent, query: '' });

    expect(sections[0].rows[0].value).toBe('Orchestrator');
  });

  test('an action with no value leaves the row undefined rather than empty-string', () => {
    // `slash-menu.tsx` renders on truthiness; an empty string would be
    // falsy too, but `undefined` is what "this control has no current
    // setting to show" actually means.
    const sections = buildSlashSections({
      commands: [],
      actions: [{ id: 'attach-file', label: 'Attach file', description: 'x' }],
      query: '',
    });

    expect(sections[0].rows[0].value).toBeUndefined();
  });

  test('value is NOT searched — typing an agent name does not surface Switch agent', () => {
    // Guards a tempting "improvement": adding `value` to the filter would
    // make `/orchestrator` rank a composer action above real commands.
    const sections = buildSlashSections({ commands: [], actions: withAgent, query: 'orchestrator' });

    expect(sections).toEqual([]);
  });
});

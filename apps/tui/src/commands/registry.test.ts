import { describe, expect, test } from 'bun:test';

import { allBindings } from '../keymap.ts';
import {
  COMMANDS,
  type CommandContext,
  findCommand,
  matchScore,
  menuEntries,
  parseSlash,
  unavailableReason,
} from './registry.ts';

const FULL: CommandContext = {
  hasProject: true,
  hasSession: true,
  hasAccount: true,
  capabilities: ['session.commands', 'session.compact', 'session.fork'],
};
const EMPTY: CommandContext = {
  hasProject: true,
  hasSession: false,
  hasAccount: true,
  capabilities: null,
};

describe('the command table', () => {
  test('every name and alias is unique', () => {
    const words = COMMANDS.flatMap((spec) => [
      spec.name,
      ...(('aliases' in spec ? spec.aliases : []) as readonly string[]),
    ]);
    expect(new Set(words).size).toBe(words.length);
  });

  test('every binding a command names exists in the keymap', () => {
    const ids = new Set(allBindings().map((binding) => binding.id));
    for (const spec of COMMANDS) {
      if ('binding' in spec && spec.binding) expect(ids.has(spec.binding)).toBe(true);
    }
  });
});

describe('parseSlash', () => {
  test('splits the name from its arguments', () => {
    expect(parseSlash('/rename  Fix the login bug ')).toEqual({
      name: 'rename',
      args: 'Fix the login bug',
    });
    expect(parseSlash('/Sessions')).toEqual({ name: 'sessions', args: '' });
  });

  test('ignores text that is not one slash line', () => {
    expect(parseSlash('hello /new')).toBeNull();
    expect(parseSlash('/new\nsecond line')).toBeNull();
  });
});

describe('findCommand', () => {
  test('finds by name and by alias', () => {
    expect(findCommand('sessions')?.name).toBe('sessions');
    expect(findCommand('switch')?.name).toBe('sessions');
    expect(findCommand('exit')?.name).toBe('quit');
    expect(findCommand('nope')).toBeNull();
  });
});

describe('ranking', () => {
  test('prefix beats substring beats subsequence', () => {
    expect(matchScore('sessions', 'se')).toBeGreaterThan(matchScore('rename', 'na'));
    expect(matchScore('sessions', 'ss')).toBeGreaterThan(0);
    expect(matchScore('sessions', 'xz')).toBe(0);
  });

  test('/se lists sessions first', () => {
    expect(menuEntries('se', FULL)[0]?.name).toBe('sessions');
  });

  test('an alias finds its command', () => {
    expect(menuEntries('exit', FULL)[0]?.name).toBe('quit');
  });

  test('an empty query lists every built-in in table order when all can run', () => {
    const names = menuEntries('', FULL)
      .filter((entry) => entry.source === 'builtin')
      .map((entry) => entry.name);
    expect(names).toEqual(COMMANDS.map((spec) => spec.name));
  });
});

describe('availability', () => {
  test('session commands are dimmed with a reason when no session is open', () => {
    const rename = menuEntries('rename', EMPTY)[0];
    expect(rename?.name).toBe('rename');
    expect(rename?.unavailable).toBe('needs an open session');
    expect(menuEntries('new', EMPTY)[0]?.unavailable).toBeNull();
  });

  test('a capability-gated command is unavailable on a runtime without it', () => {
    const compact = findCommand('compact');
    if (!compact) throw new Error('compact missing');
    expect(unavailableReason(compact, { ...FULL, capabilities: ['session.commands'] })).toBe(
      "this session's runtime does not support it",
    );
    // Not read yet: hide nothing.
    expect(unavailableReason(compact, { ...FULL, capabilities: null })).toBeNull();
  });

  test('within one match tier, what can run here ranks first', () => {
    // No session: `stop` is a shorter prefix match than `sessions`, but it
    // cannot run, so `sessions` leads.
    expect(menuEntries('s', EMPTY)[0]?.name).toBe('sessions');
    expect(menuEntries('s', FULL)[0]?.name).toBe('stop');
  });
});

describe('the empty query with no session', () => {
  test('lists what can run first, then the dimmed rest, each in table order', () => {
    const rows = menuEntries('', EMPTY);
    const firstDim = rows.findIndex((row) => row.unavailable);
    expect(firstDim).toBeGreaterThan(0);
    expect(rows.slice(firstDim).every((row) => row.unavailable)).toBe(true);
    expect(rows[0]?.name).toBe('new');
  });
});

describe('project commands', () => {
  test('are listed after the built-ins when the runtime serves them', () => {
    const rows = menuEntries('', FULL, [{ name: 'deploy', description: 'Ship it' }]);
    expect(rows.at(-1)).toMatchObject({ name: 'deploy', source: 'runtime', group: 'project' });
  });

  test('are hidden on a runtime without session.commands', () => {
    const rows = menuEntries('', { ...FULL, capabilities: ['session.compact'] }, [
      { name: 'deploy' },
    ]);
    expect(rows.some((row) => row.name === 'deploy')).toBe(false);
  });

  test('never shadow a built-in and survive a malformed list', () => {
    const rows = menuEntries('new', FULL, [{ name: 'new', description: 'a project new' }]);
    expect(rows.filter((row) => row.name === 'new')).toHaveLength(1);
    expect(menuEntries('', FULL, { bogus: true } as never).length).toBe(COMMANDS.length);
  });
});

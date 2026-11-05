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

describe('multi-agent commands', () => {
  test('/agents and its aliases open the agents panel; /agent still picks the agent', () => {
    expect(findCommand('agents')?.name).toBe('agents');
    expect(findCommand('subagents')?.name).toBe('agents');
    expect(findCommand('team')?.name).toBe('agents');
    expect(findCommand('agent')?.name).toBe('agent');
    expect(menuEntries('agent', FULL)[0]?.name).toBe('agent');
  });

  test('/workflows, /runs, /tasks and /parent parse and resolve', () => {
    expect(findCommand(parseSlash('/workflows')?.name ?? '')?.name).toBe('workflows');
    expect(findCommand('runs')?.name).toBe('workflows');
    expect(findCommand('tasks')?.name).toBe('tasks');
    expect(findCommand('parent')?.name).toBe('parent');
  });

  test('every one needs an open session; /tasks is off where agent teams are off', () => {
    for (const name of ['agents', 'workflows', 'tasks', 'parent']) {
      const spec = findCommand(name);
      if (!spec) throw new Error(`${name} missing`);
      expect(unavailableReason(spec, EMPTY)).toBe('needs an open session');
    }
    const tasks = findCommand('tasks');
    if (!tasks) throw new Error('tasks missing');
    expect(unavailableReason(tasks, { ...FULL, flags: { agent_teams: false } })).toBe(
      'turned off for this workspace',
    );
    expect(unavailableReason(tasks, { ...FULL, flags: { agent_teams: true } })).toBeNull();
  });
});

describe('workspaces', () => {
  test('/workspaces is the command; /projects, /project, /accounts and /org still open it', () => {
    for (const word of ['workspaces', 'workspace', 'projects', 'project', 'accounts', 'org']) {
      expect(findCommand(word)?.name).toBe('workspaces');
    }
    expect(menuEntries('workspa', FULL)[0]?.name).toBe('workspaces');
  });

  test('the members screen keeps /account as an alias', () => {
    expect(findCommand('members')?.name).toBe('members');
    expect(findCommand('account')?.name).toBe('members');
  });

  test('a command that needs a workspace says so and names /workspaces', () => {
    const none = { ...FULL, hasProject: false, hasAccount: false };
    const spec = findCommand('new');
    expect(spec && unavailableReason(spec, none)).toBe('needs a workspace: /workspaces');
    const members = findCommand('members');
    expect(members && unavailableReason(members, none)).toBe('needs a workspace: /workspaces');
  });

  test('no command name, alias or description says "project"', () => {
    for (const spec of COMMANDS) {
      expect(spec.description).not.toMatch(/\bproject/i);
      expect(spec.name).not.toMatch(/project|account/);
    }
  });
});

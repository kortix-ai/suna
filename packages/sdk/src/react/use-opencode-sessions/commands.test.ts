import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Command } from '../../core/runtime/runtime-types';

let commandResult: { data?: unknown; error?: unknown; response?: Response } = { data: {} };
let capturedCommand: unknown;
let queryConfig: { queryKey: unknown[]; select?: (commands: Command[]) => Command[] } | undefined;

mock.module('../../core/runtime/client', () => ({
  getClient: () => ({
    session: {
      command: async (input: unknown) => {
        capturedCommand = input;
        return commandResult;
      },
    },
  }),
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: typeof queryConfig) => {
    queryConfig = config;
    return { data: undefined };
  },
  useMutation: () => ({}),
}));

const realKeys = await import('./keys');
mock.module('./keys', () => ({ ...realKeys, useRuntimeReady: () => true }));
mock.module('../use-runtime-supports', () => ({ useRuntimeSupports: () => true }));

// The session-log action route of the active runtime: null = an older box (the default here).
let actionImpl: (method: string, path: string, body?: unknown) => Promise<Response | null> = async () => null;
const actionCalls: unknown[] = [];
const realRuntimeActions = await import('../../core/session/runtime-actions');
mock.module('../../core/session/runtime-actions', () => ({
  ...realRuntimeActions,
  activeRuntimeAction: (method: string, path: string, body?: unknown) => (actionCalls.push([method, path, body]), actionImpl(method, path, body)),
}));

const { CommandNotEnabledError, executeRuntimeCommand, useRuntimeCommands } = await import('./commands');

const command = (name: string, agents?: string[]): Command => ({
  name,
  template: `run ${name}`,
  hints: [],
  ...(agents ? { agents } : {}),
});

beforeEach(() => {
  commandResult = { data: {} };
  queryConfig = undefined;
  actionImpl = async () => null;
  actionCalls.length = 0;
});

describe('on a box with the session-log actions', () => {
  test('the command list is the commands route, as commands without templates', async () => {
    actionImpl = async () =>
      Response.json({
        commands: [
          { name: 'review', description: 'Review a change', source: 'command', agents: ['coder'] },
          { name: 'notes', description: null, source: 'template' },
          { name: 'pdf', description: 'Read PDFs', source: 'skill' },
        ],
      });
    useRuntimeCommands();
    const commands = await (queryConfig as unknown as { queryFn: () => Promise<Command[]> }).queryFn();
    expect(actionCalls).toEqual([['GET', '/kortix/runtime/commands', undefined]]);
    expect(commands).toEqual([
      { name: 'review', description: 'Review a change', source: 'command', agents: ['coder'], template: '', hints: [] },
      { name: 'notes', source: 'command', template: '', hints: [] },
      { name: 'pdf', description: 'Read PDFs', source: 'skill', template: '', hints: [] },
    ]);
  });

  test('a command runs through the command route with its model, agent and variant', async () => {
    actionImpl = async () => Response.json({ message_id: 'msg_1' }, { status: 202 });
    await executeRuntimeCommand({ sessionId: 'ses_root', command: 'review', args: 'src', agent: 'coder', model: 'kortix/m', variant: 'high' });
    expect(actionCalls).toEqual([
      ['POST', '/kortix/runtime/sessions/ses_root/command', { name: 'review', arguments: 'src', agent: 'coder', model: 'kortix/m', variant: 'high' }],
    ]);
    expect(capturedCommand).toBeUndefined();
  });

  test('a 403 command_not_enabled throws CommandNotEnabledError; another refusal throws its message', async () => {
    actionImpl = async () => Response.json({ error: 'command_not_enabled', command: 'deploy', agent: 'coder' }, { status: 403 });
    const refused = await executeRuntimeCommand({ sessionId: 'ses_root', command: 'deploy' }).catch((e) => e);
    expect(refused).toBeInstanceOf(CommandNotEnabledError);
    expect(refused).toMatchObject({ command: 'deploy', agent: 'coder' });
    actionImpl = async () => Response.json({ error: 'unknown command "nope"' }, { status: 400 });
    await expect(executeRuntimeCommand({ sessionId: 'ses_root', command: 'nope' })).rejects.toThrow('unknown command "nope"');
  });
});

describe('useRuntimeCommands', () => {
  const list = [command('review', ['coder']), command('deploy', ['ops']), command('help')];

  test('lists only the commands the selected agent enables, plus commands without agents', () => {
    useRuntimeCommands({ agent: 'coder' });
    expect(queryConfig?.select?.(list).map((c) => c.name)).toEqual(['review', 'help']);
  });

  test('lists every command when no agent is selected', () => {
    useRuntimeCommands();
    expect(queryConfig?.select).toBeUndefined();
  });

  test('every agent shares one cached command list', () => {
    useRuntimeCommands({ agent: 'coder' });
    const coderKey = queryConfig?.queryKey;
    useRuntimeCommands({ agent: 'ops' });
    expect(queryConfig?.queryKey).toEqual(coderKey);
  });
});

describe('executeRuntimeCommand', () => {
  test('forwards model, agent, and variant overrides to the runtime client', async () => {
    await executeRuntimeCommand({
      sessionId: 'ses_root',
      command: 'review',
      args: 'src',
      agent: 'coder',
      model: 'kortix/anthropic/claude-sonnet-4-6',
      variant: 'high',
    });

    expect(capturedCommand).toEqual({
      sessionID: 'ses_root',
      command: 'review',
      arguments: 'src',
      agent: 'coder',
      model: 'kortix/anthropic/claude-sonnet-4-6',
      variant: 'high',
    });
  });

  test('a 403 command_not_enabled throws CommandNotEnabledError naming the command and agent', async () => {
    commandResult = {
      error: { error: 'command_not_enabled', command: 'deploy', agent: 'coder' },
      response: new Response(null, { status: 403 }),
    };
    const error = await executeRuntimeCommand({ sessionId: 'ses_root', command: 'deploy' }).catch((e) => e);
    expect(error).toBeInstanceOf(CommandNotEnabledError);
    expect(error).toMatchObject({ status: 403, code: 'command_not_enabled', command: 'deploy', agent: 'coder' });
    expect(error.message).toBe('The agent "coder" cannot run /deploy.');
  });

  test('another 403 keeps the generic error', async () => {
    commandResult = { error: { message: 'forbidden' }, response: new Response(null, { status: 403 }) };
    const error = await executeRuntimeCommand({ sessionId: 'ses_root', command: 'deploy' }).catch((e) => e);
    expect(error).not.toBeInstanceOf(CommandNotEnabledError);
    expect(error).toMatchObject({ status: 403, message: 'forbidden' });
  });
});

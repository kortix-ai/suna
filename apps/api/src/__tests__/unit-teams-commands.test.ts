import { describe, expect, test } from 'bun:test';
import { parseTeamsCommand, stripTeamsMentions } from '../channels/teams/util';

describe('stripTeamsMentions', () => {
  test('removes <at> mentions and collapses whitespace', () => {
    expect(stripTeamsMentions('<at>Kortix</at> do the thing')).toBe('do the thing');
    expect(stripTeamsMentions('<at id="1">Kortix Bot</at>&nbsp;hello')).toBe('hello');
  });
});

describe('parseTeamsCommand', () => {
  test('parses a slash command after a mention', () => {
    expect(parseTeamsCommand('<at>Kortix</at> /help')).toEqual({ verb: 'help', arg: '' });
    expect(parseTeamsCommand('/model anthropic/claude-sonnet-4.6')).toEqual({
      verb: 'model',
      arg: 'anthropic/claude-sonnet-4.6',
    });
    expect(parseTeamsCommand('/use Acme Corp')).toEqual({ verb: 'use', arg: 'Acme Corp' });
  });

  test('ignores non-command messages', () => {
    expect(parseTeamsCommand('use the api to fetch data')).toBeNull();
    expect(parseTeamsCommand('hello there')).toBeNull();
    expect(parseTeamsCommand('/unknowncmd foo')).toBeNull();
    expect(parseTeamsCommand('')).toBeNull();
    expect(parseTeamsCommand(undefined)).toBeNull();
  });
});

describe('parseTeamsCommand — /policy', () => {
  test('parses the policy verb and its argument', () => {
    expect(parseTeamsCommand('<at>Kortix Dev</at> /policy approval')).toEqual({ verb: 'policy', arg: 'approval' });
    expect(parseTeamsCommand('/policy')).toEqual({ verb: 'policy', arg: '' });
  });
});

// A chat is one conversation id for life. `/new` is the only way to give its
// next task a clean session, so the parser must not swallow it.
describe('parseTeamsCommand — /new', () => {
  test('/new and /reset both parse, with or without a message after them', () => {
    expect(parseTeamsCommand('/new')).toEqual({ verb: 'new', arg: '' });
    expect(parseTeamsCommand('<at>Kortix</at> /reset')).toEqual({ verb: 'reset', arg: '' });
    expect(parseTeamsCommand('/new plan the sprint')).toEqual({ verb: 'new', arg: 'plan the sprint' });
  });

  test('"new" without the slash is a message to the agent', () => {
    expect(parseTeamsCommand('new idea: ship it')).toBeNull();
  });
});

// `/stop` is the lever that ends a run after the live card's Stop button has
// scrolled out of reach. It is useless if the parser drops it.
describe('parseTeamsCommand — /stop', () => {
  test('/stop and /cancel both parse', () => {
    expect(parseTeamsCommand('/stop')).toEqual({ verb: 'stop', arg: '' });
    expect(parseTeamsCommand('<at>Kortix</at> /cancel')).toEqual({ verb: 'cancel', arg: '' });
  });

  test('a trailing word is carried, not treated as an unknown command', () => {
    expect(parseTeamsCommand('/stop please')).toEqual({ verb: 'stop', arg: 'please' });
  });

  test('"stop" on its own is a message to the agent, not a command', () => {
    expect(parseTeamsCommand('stop')).toBeNull();
    expect(parseTeamsCommand('please stop what you are doing')).toBeNull();
  });
});

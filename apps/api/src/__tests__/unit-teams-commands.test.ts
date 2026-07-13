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

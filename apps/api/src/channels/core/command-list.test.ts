import { describe, expect, test } from 'bun:test';
import { CHANNEL_COMMANDS, parseChannelCommand } from './command-list';

const parse = (text: string, bot: string | null = 'synthetic_bot') => parseChannelCommand(text, bot);

describe('parseChannelCommand', () => {
  test('a verb or an alias, any case, alone or addressed to this bot', () => {
    for (const text of ['/new', '/NEW', '/new@synthetic_bot', '/new@Synthetic_Bot', '/reset']) {
      expect(parse(text)).toEqual({ name: 'new', arg: '' });
    }
    expect(parse('/models')).toEqual({ name: 'model', arg: '' });
    expect(parse('/cancel')).toEqual({ name: 'stop', arg: '' });
    expect(parse('/start x')).toEqual({ name: 'help', arg: 'x' });
  });

  test('the argument is the rest, trimmed, with its line breaks', () => {
    expect(parse('/new  write\nline 2 ')).toEqual({ name: 'new', arg: 'write\nline 2' });
    expect(parse('/model@synthetic_bot cmd-m1')).toEqual({ name: 'model', arg: 'cmd-m1' });
  });

  test('with no stored bot name, any @suffix counts', () => {
    expect(parse('/status@any_bot', null)).toEqual({ name: 'status', arg: '' });
  });

  test('anything else goes to the agent', () => {
    for (const text of ['/new@other_bot', '/new-york', '/newer', '/stop.', '//stop', 'hello /new', '/', `/${'a'.repeat(33)}`, '/deploy now', '']) {
      expect(parse(text)).toBeNull();
    }
  });
});

describe('the command registry', () => {
  test('names and aliases are unique and valid on every platform; descriptions fit a menu', () => {
    const verbs = CHANNEL_COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(verbs).size).toBe(verbs.length);
    for (const verb of verbs) expect(verb).toMatch(/^[a-z0-9_]{1,32}$/);
    for (const c of CHANNEL_COMMANDS) expect(c.description.length).toBeGreaterThanOrEqual(3);
    for (const c of CHANNEL_COMMANDS) expect(c.description.length).toBeLessThanOrEqual(100);
  });
});

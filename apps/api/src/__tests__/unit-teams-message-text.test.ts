import { describe, expect, test } from 'bun:test';

import { stripTeamsMentions, teamsMessageText } from '../channels/teams/util';

// What the agent reads of a Teams message. The prompt used the command
// parser's flattener, which turned every run of whitespace into one space and
// deleted every mention: a pasted stack trace arrived as one line, and
// "ask @Alice" arrived as "ask".

const BOT = '28:bot';
const botMention = (name = 'Kortix') => ({
  type: 'mention',
  mentioned: { id: BOT, name },
  text: `<at>${name}</at>`,
});
const userMention = (name: string, id: string) => ({
  type: 'mention',
  mentioned: { id, name },
  text: `<at>${name}</at>`,
});

describe('teamsMessageText', () => {
  test('keeps the line breaks of a multi-line message', () => {
    const text = 'Why does this fail?\r\nTraceback (most recent call last):\r\n  File "app.py", line 3\r\nKeyError: \'id\'';
    expect(teamsMessageText({ text, recipient: { id: BOT } })).toBe(
      'Why does this fail?\nTraceback (most recent call last):\n  File "app.py", line 3\nKeyError: \'id\'',
    );
  });

  test('keeps the indentation inside a pasted block', () => {
    const text = 'Refactor this:\ndef f(x):\n    return x + 1';
    expect(teamsMessageText({ text })).toContain('\n    return x + 1');
  });

  test('drops the bot`s own mention wherever it sits', () => {
    const activity = {
      text: 'hey <at>Kortix</at> summarize the README',
      entities: [botMention()],
      recipient: { id: BOT },
    };
    expect(teamsMessageText(activity)).toBe('hey summarize the README');
  });

  test('keeps anyone else mentioned, by name', () => {
    const activity = {
      text: '<at>Kortix</at> ask <at>Alice Park</at> about the deploy',
      entities: [botMention(), userMention('Alice Park', '29:alice')],
      recipient: { id: BOT },
    };
    expect(teamsMessageText(activity)).toBe('ask @Alice Park about the deploy');
  });

  test('without mention entities, only a leading mention is taken as the address', () => {
    expect(teamsMessageText({ text: '<at>Kortix Dev</at>summarize the README' })).toBe('summarize the README');
    expect(teamsMessageText({ text: '<at>Kortix</at> loop in <at>Bob</at>' })).toBe('loop in @Bob');
  });

  test('decodes the entities Teams escapes, and <br> line breaks', () => {
    expect(teamsMessageText({ text: 'if a &lt; b &amp;&amp; c&nbsp;&gt; d<br>then &quot;ok&quot;' })).toBe(
      'if a < b && c > d\nthen "ok"',
    );
  });

  test('collapses runs of blank lines and trims the ends, nothing more', () => {
    expect(teamsMessageText({ text: '\n\nfirst\n\n\n\nsecond   \n\n' })).toBe('first\n\nsecond');
  });

  test('an empty or missing text is an empty string', () => {
    expect(teamsMessageText({})).toBe('');
    expect(teamsMessageText({ text: '<at>Kortix</at>', entities: [botMention()], recipient: { id: BOT } })).toBe('');
  });

  test('the command parser still gets one flattened line', () => {
    // Titles and slash commands want one line; that is what stripTeamsMentions is for.
    expect(stripTeamsMentions('<at>Kortix</at> /new\nsecond line')).toBe('/new second line');
  });
});

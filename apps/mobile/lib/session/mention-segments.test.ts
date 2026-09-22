import { describe, expect, test } from 'bun:test';

import {
  buildMentionSegments,
  chipAccessibilityLabel,
  chipText,
  classifyMentionToken,
} from './mention-segments';

describe('chipText', () => {
  test('a command chip reads /name', () => {
    expect(chipText('command', 'review')).toBe('/review');
  });

  test('every reference kind reads @name', () => {
    expect(chipText('file', 'README.md')).toBe('@README.md');
    expect(chipText('agent', 'build')).toBe('@build');
    expect(chipText('session', 'Fix the parser')).toBe('@Fix the parser');
  });
});

describe('chipAccessibilityLabel', () => {
  test('names the kind and the label', () => {
    expect(chipAccessibilityLabel('command', 'review')).toBe('command: /review');
    expect(chipAccessibilityLabel('file', 'a.ts')).toBe('file mention: a.ts');
  });
});

describe('classifyMentionToken', () => {
  const agents = new Set(['build']);

  test('ses_ ids are sessions', () => {
    expect(classifyMentionToken('ses_123', agents)).toBe('session');
  });

  test('known agent names are agents', () => {
    expect(classifyMentionToken('build', agents)).toBe('agent');
  });

  test('everything else is a file', () => {
    expect(classifyMentionToken('src/app.ts', agents)).toBe('file');
  });
});

describe('buildMentionSegments', () => {
  test('empty text has no segments', () => {
    expect(buildMentionSegments({ text: '' })).toEqual([]);
  });

  test('plain text is one plain segment', () => {
    expect(buildMentionSegments({ text: 'hello there' })).toEqual([{ text: 'hello there' }]);
  });

  test('an @token at a word start is a file mention', () => {
    expect(buildMentionSegments({ text: 'open @README.md now' })).toEqual([
      { text: 'open ' },
      { text: '@README.md', type: 'file' },
      { text: ' now' },
    ]);
  });

  test('an email address is not a mention', () => {
    expect(buildMentionSegments({ text: 'mail jay@kortix.com' })).toEqual([
      { text: 'mail jay@kortix.com' },
    ]);
  });

  test('trailing punctuation stays outside the chip', () => {
    expect(buildMentionSegments({ text: 'see @a.md, then' })).toEqual([
      { text: 'see ' },
      { text: '@a.md', type: 'file' },
      { text: ', then' },
    ]);
  });

  test('a known agent name is an agent mention', () => {
    expect(buildMentionSegments({ text: '@build go', agentNames: ['build'] })).toEqual([
      { text: '@build', type: 'agent' },
      { text: ' go' },
    ]);
  });

  test('a session title with spaces claims its whole range', () => {
    expect(
      buildMentionSegments({ text: 'like @Fix the parser ok', sessionTitles: ['Fix the parser'] }),
    ).toEqual([
      { text: 'like ' },
      { text: '@Fix the parser', type: 'session' },
      { text: ' ok' },
    ]);
  });

  test('a session ref does not stop the regex fill for other mentions', () => {
    expect(
      buildMentionSegments({ text: '@Old one and @b.ts', sessionTitles: ['Old one'] }),
    ).toEqual([
      { text: '@Old one', type: 'session' },
      { text: ' and ' },
      { text: '@b.ts', type: 'file' },
    ]);
  });

  test('line breaks are preserved inside plain segments', () => {
    expect(buildMentionSegments({ text: 'a\n\nb @c' })).toEqual([
      { text: 'a\n\nb ' },
      { text: '@c', type: 'file' },
    ]);
  });
});

import { describe, expect, test } from 'bun:test';
import { extractMessageLinks, MESSAGE_LINKS_MAX } from './message-links';

describe('extractMessageLinks', () => {
  test('a bare link, normalized', () => {
    expect(extractMessageLinks('see HTTPS://Example.com/a b')).toEqual(['https://example.com/a']);
  });

  test('trailing sentence punctuation is not part of the link', () => {
    expect(extractMessageLinks('Read https://a.com/x. Then https://b.com/y, and https://c.com/z!?')).toEqual([
      'https://a.com/x',
      'https://b.com/y',
      'https://c.com/z',
    ]);
  });

  test('markdown link and bold', () => {
    expect(extractMessageLinks('[docs](https://a.com/docs) and **https://b.com/q**')).toEqual([
      'https://a.com/docs',
      'https://b.com/q',
    ]);
  });

  test('balanced parentheses stay; an unopened closing one goes', () => {
    expect(extractMessageLinks('(see https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  test('angle brackets and quotes end the link', () => {
    expect(extractMessageLinks('<https://a.com/x> "https://b.com/y"')).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  test('javascript:, data:, ftp: and scheme-less text are not links', () => {
    expect(
      extractMessageLinks('javascript:alert(1) data:text/html,<b>x</b> ftp://a.com/f www.example.com example.com/x'),
    ).toEqual([]);
  });

  test('credentials in a link drop it', () => {
    expect(extractMessageLinks('https://user:secret@a.com/x https://b.com')).toEqual(['https://b.com/']);
  });

  test('duplicates collapse to one, in first-seen order', () => {
    expect(extractMessageLinks('https://a.com/x https://b.com https://a.com/x')).toEqual([
      'https://a.com/x',
      'https://b.com/',
    ]);
  });

  test(`at most ${MESSAGE_LINKS_MAX}`, () => {
    const text = Array.from({ length: 30 }, (_, i) => `https://a.com/${i}`).join(' ');
    const links = extractMessageLinks(text);
    expect(links).toHaveLength(MESSAGE_LINKS_MAX);
    expect(links[19]).toBe('https://a.com/19');
  });

  test('a link longer than 2,048 characters after normalization is dropped', () => {
    expect(extractMessageLinks(`https://a.com/${'x'.repeat(2040)}`)).toEqual([]);
  });

  test('a quoted reply is not the person’s own text', () => {
    expect(
      extractMessageLinks('<reply_context from="agent">see https://agent.com/x</reply_context>\nmine: https://me.com'),
    ).toEqual(['https://me.com/']);
  });
});

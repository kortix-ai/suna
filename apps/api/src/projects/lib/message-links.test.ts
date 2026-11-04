import { describe, expect, test } from 'bun:test';
import { extractMessageLinks, MESSAGE_LINKS_MAX, MESSAGE_SCAN_MAX } from './message-links';

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

  test('trailing punctuation mixed with unopened closers is trimmed in one pass', () => {
    expect(extractMessageLinks('(see https://a.com/x).) and https://b.com/y?).')).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  for (const [name, tail] of [
    ['100k closing parens', ')'.repeat(100_000)],
    ['100k ".)" pairs', '.)'.repeat(50_000)],
    ['100k "(" then ")"', '('.repeat(50_000) + ')'.repeat(50_000)],
  ] as const) {
    test(`adversarial input (${name}) finishes in under 50 ms`, () => {
      const started = performance.now();
      const links = extractMessageLinks(`https://a.com/${tail}`);
      expect(performance.now() - started).toBeLessThan(50);
      expect(links).toEqual([]);
    });
  }

  test('a 12 MB message is scanned only in its first 64 KB, fast', () => {
    const text = `https://a.com/first ${'x '.repeat(6_000_000)} https://b.com/late`;
    const started = performance.now();
    expect(extractMessageLinks(text)).toEqual(['https://a.com/first']);
    expect(performance.now() - started).toBeLessThan(50);
    expect(MESSAGE_SCAN_MAX).toBe(65_536);
  });

  for (const [name, text] of [
    ['64 KB of unclosed "<reply_context"', '<reply_context'.repeat(4682) + ' https://a.com/x'],
    ['64 KB of unclosed "<reply_context>"', '<reply_context>'.repeat(4369)],
    ['64 KB of openers alternating with a closer at the end', '<reply_context> <reply_context '.repeat(2100) + '</reply_context> https://a.com/after'],
  ] as const) {
    test(`reply-context stripping on ${name} finishes in under 50 ms`, () => {
      const started = performance.now();
      extractMessageLinks(text);
      expect(performance.now() - started).toBeLessThan(50);
    });
  }

  test('an unclosed reply quote drops the rest; several quotes each drop out', () => {
    expect(extractMessageLinks('mine https://me.com/a <reply_context>quoted https://agent.com/x')).toEqual(['https://me.com/a']);
    expect(
      extractMessageLinks(
        '<reply_context>https://q.com/1</reply_context> https://me.com/b <reply_context id="2">https://q.com/2</reply_context> https://me.com/c',
      ),
    ).toEqual(['https://me.com/b', 'https://me.com/c']);
    expect(extractMessageLinks('<reply_contexts> https://me.com/d')).toEqual(['https://me.com/d']);
  });
});

import { describe, expect, test } from 'bun:test';
import { readLegacyChannelHeader } from './channel-header';

/** The regex web and mobile both used, kept ONLY as the parity oracle. */
function legacy(text: string) {
  const m = /^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/.exec(text);
  if (!m) return null;
  const [whole, platform = '', context = '', userName = ''] = m;
  return { platform, context: context.trim(), userName: userName.trim(), length: whole.length };
}

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('readLegacyChannelHeader', () => {
  test('reads the same header as the regex on 3000 random header-shaped prompts', () => {
    const next = random(89);
    const pick = (options: readonly string[]) => options[Math.floor(next() * options.length)] ?? '';
    const some = (options: readonly string[], max: number) =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(options)).join('');
    let read = 0;
    for (let i = 0; i < 3000; i++) {
      // Mostly well-formed, with each part sometimes empty, doubled, or missing.
      const text =
        `${pick(['[', '[', '[', ' ['])}${pick(['Slack', 'Teams', 'Telegram', 'x1', ''])}${some([' ', '\t'], 2)}` +
        `${pick(['·', '·', '·', ''])}${some(['a', 'a', ' ', '\t', '#g', '·'], 3)}${pick(['·', '·', '·', ''])}` +
        `${some([' ', '\n'], 2)}message from${pick([' ', ' ', '\t', '', 'x'])}` +
        `${some(['b', 'b', ' ', '\t', '\n', '·', ']'], 3)}${pick([']', ']', '] ', ']\n', ''])}${some(['hi', ' ', '\n'], 3)}`;
      const expected = legacy(text);
      expect(readLegacyChannelHeader(text)).toEqual(expected);
      if (expected) read++;
    }
    expect(read).toBeGreaterThan(150);
  });

  test('reads a real header', () => {
    expect(readLegacyChannelHeader('[Slack · #general · message from U0SAMPLE]\nhello')).toEqual({
      platform: 'Slack',
      context: '#general',
      userName: 'U0SAMPLE',
      length: 43,
    });
    expect(readLegacyChannelHeader('hello [Slack · #g · message from a]')).toBeNull();
  });

  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // The regex took 1.4 s at 60k characters with Bun and quadrupled per doubling.
  within('a context of 240k spaces', () =>
    readLegacyChannelHeader(`[Slack·a${' '.repeat(240_000)}x`),
  );
  within('a sender of 240k spaces', () =>
    readLegacyChannelHeader(`[Slack·a·message from${' '.repeat(240_000)}x`),
  );
});

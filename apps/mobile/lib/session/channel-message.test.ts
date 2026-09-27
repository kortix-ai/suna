import { describe, expect, test } from 'bun:test';

import { instructionsStart, parseLegacyChannelMessage } from './channel-message';

/**
 * The user message component's regex version, kept ONLY as the parity oracle.
 * Its header regex was quadratic in a long space run, and its instruction
 * search was quadratic in a long blank run: every newline was retried.
 */
const TAIL = /\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/;
function legacy(rawText: string) {
  if (!rawText) return undefined;
  const headerMatch = rawText.match(/^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/);
  if (!headerMatch) return undefined;
  const platform = headerMatch[1] as 'Telegram' | 'Slack';
  const userName = (headerMatch[3] ?? '').trim();
  const afterHeader = rawText.slice(headerMatch[0].length);
  const instrStart = afterHeader.search(TAIL);
  const messageText = instrStart >= 0 ? afterHeader.slice(0, instrStart).trim() : afterHeader.trim();
  return { platform, userName, messageText };
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

describe('instructionsStart', () => {
  test('finds what the regex search found on 3000 random tails', () => {
    const tokens = ['\n', ' ', '\t', '\r', 'Chat ID:', '── Telegram instructions', '── Slack instructions', 'x', '──',
      'Chat ID', ' Chat ID:', 'hi'];
    const next = random(97);
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const length = Math.floor(next() * 16);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = text.search(TAIL);
      expect(instructionsStart(text)).toBe(expected);
      if (expected >= 0) found++;
    }
    expect(found).toBeGreaterThan(500);
  });
});

describe('parseLegacyChannelMessage', () => {
  test('returns exactly what the regex version returned on 3000 random prompts', () => {
    const next = random(101);
    const pick = (options: readonly string[]) => options[Math.floor(next() * options.length)] ?? '';
    const some = (options: readonly string[], max: number) =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(options)).join('');
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      // Mostly well-formed headers, then a body with or without the scaffold's instructions.
      const text =
        `[${pick(['Slack', 'Telegram', 'Teams', ''])}${some([' ', '\t'], 2)}${pick(['·', '·', '·', ''])}` +
        `${some(['a', 'a', ' ', '#g', '·'], 3)}${pick(['·', '·', '·', ''])}${some([' ', '\n'], 2)}message from` +
        `${pick([' ', ' ', '\t', ''])}${some(['b', 'b', ' ', '\n', ']'], 3)}${pick([']', ']', '] ', ''])}` +
        `${some(['hello', ' ', '\n', '\n\n', '\t', 'Chat ID: 1', '── Slack instructions', '── Telegram instructions'], 6)}`;
      const expected = legacy(text);
      expect(parseLegacyChannelMessage(text)).toEqual(expected);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(200);
  });

  test('reads a real Telegram prompt and stops before its instructions', () => {
    const text = '[Telegram · 12345 · message from @sample]\nping from telegram\n\nChat ID: 12345\nreply with telegram send';
    expect(parseLegacyChannelMessage(text)).toEqual({
      platform: 'Telegram',
      userName: '@sample',
      messageText: 'ping from telegram',
    });
    expect(parseLegacyChannelMessage('an ordinary prompt')).toBeUndefined();
    expect(parseLegacyChannelMessage('')).toBeUndefined();
  });
});

describe('no channel prompt can freeze the app', () => {
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // The header regex took 1.4 s at 60k characters with Bun, and quadrupled per doubling.
  within('a header whose context holds 240k spaces', () => parseLegacyChannelMessage(`[Slack·a${' '.repeat(240_000)}x`));
  within('a header whose sender holds 240k spaces', () =>
    parseLegacyChannelMessage(`[Slack·a·message from${' '.repeat(240_000)}x`));
  // The instruction search took 2.7 s at 60k blank lines.
  within('240k blank lines after the header', () =>
    parseLegacyChannelMessage(`[Slack · c · message from a]\nhi${'\n'.repeat(240_000)}x`));
  within('240k mixed whitespace after the header', () =>
    parseLegacyChannelMessage(`[Slack · c · message from a]\nhi${'\n \t'.repeat(80_000)}x`));
});

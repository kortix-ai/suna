import { describe, expect, test } from 'bun:test';
import { parseTriggerEvent } from './trigger-event';

/** The regex version web and mobile both used, kept ONLY as the parity oracle. */
function legacy(rawText: string) {
  if (!rawText) return undefined;
  const match = rawText.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
  if (!match) return undefined;
  try {
    const data = JSON.parse(match[1] ?? '');
    const prompt = rawText.replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '').trim();
    return { data, prompt };
  } catch {
    return undefined;
  }
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

describe('parseTriggerEvent', () => {
  test('returns exactly what the regex version returned on 3000 random prompts', () => {
    const tokens = [
      '<trigger_event>',
      '</trigger_event>',
      '<trigger_event',
      ' ',
      '\n',
      '\t',
      '{"trigger":"cron"}',
      '{"data":{"manual":true}}',
      '{',
      '"',
      'prompt',
      'x',
      '[1, 2]',
      'null',
      '<trigger_event> {"trigger":"cron"} </trigger_event>',
      '<trigger_event>\n{"data":{"manual":true}}\n</trigger_event>',
    ];
    const next = random(83);
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const length = Math.floor(next() * 12);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = legacy(text);
      expect(parseTriggerEvent(text)).toEqual(expected);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(300);
  });

  test('reads the event and the prompt around it', () => {
    const text =
      '<trigger_event>\n{"trigger":"daily-report","data":{"manual":true}}\n</trigger_event>\n\nSummarize the day.';
    expect(parseTriggerEvent(text)).toEqual({
      data: { trigger: 'daily-report', data: { manual: true } },
      prompt: 'Summarize the day.',
    });
  });

  test('no tag, an unclosed tag, or invalid JSON is not a trigger event', () => {
    expect(parseTriggerEvent('just a prompt')).toBeUndefined();
    expect(parseTriggerEvent('<trigger_event>{"a":1}')).toBeUndefined();
    expect(parseTriggerEvent('<trigger_event>{not json}</trigger_event>')).toBeUndefined();
    expect(parseTriggerEvent('')).toBeUndefined();
    expect(parseTriggerEvent(undefined)).toBeUndefined();
  });

  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // The regex was CUBIC here: 1,000 characters took ~180 ms, 10,000 took minutes.
  within('an unclosed tag followed by 240k spaces', () =>
    parseTriggerEvent(`<trigger_event>${' '.repeat(240_000)}x`),
  );
  // Quadratic: a JSON string of 60k spaces took 1.4 s.
  within('a payload holding a 240k-space string', () =>
    parseTriggerEvent(`<trigger_event>\n{"a":"${' '.repeat(240_000)}"}\n</trigger_event>`),
  );
});

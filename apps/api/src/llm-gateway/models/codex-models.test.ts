import { describe, expect, test } from 'bun:test';

import { parseCodexContextWindows, parseCodexModelIds } from './codex-models';

describe('parseCodexModelIds', () => {
  test('drops slugs the ChatGPT backend refuses even though models.json lists them', () => {
    // gpt-5.5 is still `visibility: "list"` upstream but the backend answers
    // "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT
    // account" — a picker entry would 400 every turn.
    const ids = parseCodexModelIds({
      models: [
        { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 },
        { slug: 'gpt-5.5', visibility: 'list', priority: 13 },
      ],
    });
    expect(ids).toEqual(['gpt-6.1-sol']);
  });
});

describe('parseCodexContextWindows', () => {
  test('reads each slug\'s context_window and skips a missing or bad one', () => {
    expect(parseCodexContextWindows({ models: [
      { slug: 'gpt-6-sol', context_window: 272_000 },
      { slug: 'gpt-x', context_window: 0 },
      { slug: 'gpt-y' },
    ] })).toEqual({ 'gpt-6-sol': 272_000 });
    expect(parseCodexContextWindows(null)).toEqual({});
  });
});

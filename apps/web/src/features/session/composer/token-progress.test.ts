import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@kortix/sdk/react';
import type { FlatModel } from '../model-flatten';
import { STATUS_TEXT } from '@/components/ui/status';
import {
  CONTEXT_DANGER_RATIO,
  CONTEXT_WARNING_RATIO,
  contextTone,
  contextUsageHeadlineKind,
  formatContextCount,
  getContextLimit,
  getLastAssistantTokenBreakdown,
  getLastAssistantTokenTotal,
  getSelectedModelName,
} from './token-progress';

function assistantMessage(tokens: Record<string, unknown> | undefined): MessageWithParts {
  return {
    info: { role: 'assistant', tokens } as any,
    parts: [],
  } as unknown as MessageWithParts;
}

function userMessage(): MessageWithParts {
  return { info: { role: 'user' } as any, parts: [] } as unknown as MessageWithParts;
}

function flatModel(overrides: Partial<FlatModel> = {}): FlatModel {
  return {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: 'claude-5',
    modelName: 'Claude 5',
    ...overrides,
  };
}

describe('getLastAssistantTokenTotal', () => {
  test('returns 0 for undefined or empty message lists', () => {
    expect(getLastAssistantTokenTotal(undefined)).toBe(0);
    expect(getLastAssistantTokenTotal([])).toBe(0);
  });

  test('sums input/output/reasoning/cache tokens from the most recent assistant message', () => {
    const messages = [
      userMessage(),
      assistantMessage({ input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } }),
    ];
    expect(getLastAssistantTokenTotal(messages)).toBe(167);
  });

  test('skips trailing assistant messages with no token total and finds the last real one', () => {
    const messages = [
      assistantMessage({ input: 100, output: 50 }),
      userMessage(),
      assistantMessage(undefined),
    ];
    expect(getLastAssistantTokenTotal(messages)).toBe(150);
  });

  test('ignores user messages entirely, even if they carry a tokens-shaped field', () => {
    const messages = [assistantMessage({ input: 10, output: 10 }), userMessage()];
    expect(getLastAssistantTokenTotal(messages)).toBe(20);
  });
});

describe('getLastAssistantTokenBreakdown', () => {
  test('returns an all-zero breakdown for undefined or empty message lists', () => {
    expect(getLastAssistantTokenBreakdown(undefined)).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: 0,
      total: 0,
    });
    expect(getLastAssistantTokenBreakdown([])).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: 0,
      total: 0,
    });
  });

  test('splits the reading per kind and folds cache read+write into one number', () => {
    const messages = [
      userMessage(),
      assistantMessage({ input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } }),
    ];
    expect(getLastAssistantTokenBreakdown(messages)).toEqual({
      input: 100,
      output: 50,
      reasoning: 10,
      cache: 7,
      total: 167,
    });
  });

  test('every field defaults to 0 when the model omits it', () => {
    // The card only renders rows above zero; a missing `reasoning` must read as
    // 0 rather than NaN, which would render as "0" but poison `total`.
    const breakdown = getLastAssistantTokenBreakdown([assistantMessage({ input: 40 })]);
    expect(breakdown).toEqual({ input: 40, output: 0, reasoning: 0, cache: 0, total: 40 });
    expect(Number.isNaN(breakdown.total)).toBe(false);
  });

  test('the parts always sum to the total it reports', () => {
    // The bar is a fraction of `total` and the rows below it are the parts —
    // if these drift the card contradicts itself on screen.
    const b = getLastAssistantTokenBreakdown([
      assistantMessage({ input: 1234, output: 99, reasoning: 7, cache: { read: 500, write: 21 } }),
    ]);
    expect(b.input + b.output + b.reasoning + b.cache).toBe(b.total);
  });

  test('skips a still-streaming trailing turn and reports the last real reading', () => {
    const messages = [
      assistantMessage({ input: 100, output: 50 }),
      userMessage(),
      assistantMessage(undefined),
    ];
    expect(getLastAssistantTokenBreakdown(messages).total).toBe(150);
    expect(getLastAssistantTokenBreakdown(messages).input).toBe(100);
  });

  test('getLastAssistantTokenTotal stays exactly the breakdown total', () => {
    const messages = [
      assistantMessage({ input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } }),
    ];
    expect(getLastAssistantTokenTotal(messages)).toBe(
      getLastAssistantTokenBreakdown(messages).total,
    );
  });
});

describe('getSelectedModelName', () => {
  test('returns null when there is nothing to resolve against', () => {
    expect(getSelectedModelName(undefined, undefined)).toBeNull();
    expect(getSelectedModelName([flatModel()], null)).toBeNull();
  });

  test('returns the catalog display name for the selected model', () => {
    const models = [flatModel({ modelID: 'claude-5', modelName: 'Claude Opus 5' })];
    expect(getSelectedModelName(models, { providerID: 'anthropic', modelID: 'claude-5' })).toBe(
      'Claude Opus 5',
    );
  });

  test('returns null rather than a raw id when the catalog does not know the model', () => {
    // A bare `anthropic/claude-…-20250929` is worse than no line at all in a
    // card this small, so the card falls back to its own generic label.
    const models = [flatModel({ modelID: 'claude-5' })];
    expect(getSelectedModelName(models, { providerID: 'openai', modelID: 'gpt-5' })).toBeNull();
  });

  test('treats a blank or whitespace-only name as absent', () => {
    const models = [flatModel({ modelID: 'claude-5', modelName: '   ' })];
    expect(getSelectedModelName(models, { providerID: 'anthropic', modelID: 'claude-5' })).toBeNull();
  });
});

describe('getContextLimit', () => {
  test('falls back to 200k when no model is selected', () => {
    expect(getContextLimit(undefined, undefined)).toBe(200000);
    expect(getContextLimit([flatModel()], null)).toBe(200000);
  });

  test('uses the selected model contextWindow when present', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 500000 })];
    expect(
      getContextLimit(models, { providerID: 'anthropic', modelID: 'claude-5' }),
    ).toBe(500000);
  });

  test('falls back to 200k when the selected model has no positive contextWindow', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 0 })];
    expect(
      getContextLimit(models, { providerID: 'anthropic', modelID: 'claude-5' }),
    ).toBe(200000);
  });

  test('falls back to 200k when the selected model is not found in the list', () => {
    const models = [flatModel({ modelID: 'claude-5', contextWindow: 500000 })];
    expect(
      getContextLimit(models, { providerID: 'openai', modelID: 'gpt-5' }),
    ).toBe(200000);
  });
});

describe('contextTone', () => {
  test('an empty or barely-used context is blue, not grey', () => {
    // `info`, not `neutral`: the ring carries no label, so a muted grey arc
    // reads as chrome rather than as a reading.
    expect(contextTone(0)).toBe('info');
    expect(contextTone(0.42)).toBe('info');
  });

  test('blue right up to the warning threshold, yellow AT it', () => {
    // `>=`, not `>`. Exactly 70% is already the warning, otherwise the band
    // starts one floating-point hair late and 0.7 renders blue.
    expect(contextTone(CONTEXT_WARNING_RATIO - 0.001)).toBe('info');
    expect(contextTone(CONTEXT_WARNING_RATIO)).toBe('warning');
  });

  test('yellow across the whole warning band', () => {
    expect(contextTone(0.7)).toBe('warning');
    expect(contextTone(0.8)).toBe('warning');
    expect(contextTone(CONTEXT_DANGER_RATIO - 0.001)).toBe('warning');
  });

  test('destructive AT the danger threshold and above, including a full ring', () => {
    expect(contextTone(CONTEXT_DANGER_RATIO)).toBe('destructive');
    expect(contextTone(0.95)).toBe('destructive');
    // `ratio` is clamped to 1 by the component, but the function must not
    // depend on that to stay correct.
    expect(contextTone(1)).toBe('destructive');
  });

  test('the two thresholds leave a real warning band, not a flicker', () => {
    // The guard on the numbers themselves: collapsing them would make yellow
    // unreachable in practice while every assertion above still passed.
    expect(CONTEXT_DANGER_RATIO - CONTEXT_WARNING_RATIO).toBeGreaterThanOrEqual(0.1);
  });

  test('every tone it returns exists in the status family', () => {
    // `STATUS_TEXT[tone]` is looked up directly in the render; a tone with no
    // entry would produce `undefined` and an uncoloured ring.
    for (const ratio of [0, 0.7, 0.85, 1]) {
      expect(STATUS_TEXT[contextTone(ratio)]).toBeTruthy();
    }
  });
});

describe('formatContextCount', () => {
  test('returns 0 for empty or invalid input', () => {
    expect(formatContextCount(0)).toBe('0');
    expect(formatContextCount(-1)).toBe('0');
    expect(formatContextCount(Number.NaN)).toBe('0');
  });

  test('keeps small counts as integers', () => {
    expect(formatContextCount(512)).toBe('512');
    expect(formatContextCount(999)).toBe('999');
  });

  test('compacts thousands with a lowercase k', () => {
    expect(formatContextCount(1234)).toBe('1.2k');
    expect(formatContextCount(12300)).toBe('12.3k');
    expect(formatContextCount(200000)).toBe('200k');
  });

  test('compacts millions with a lowercase m', () => {
    expect(formatContextCount(1_000_000)).toBe('1m');
    expect(formatContextCount(1_500_000)).toBe('1.5m');
  });
});

describe('contextUsageHeadlineKind', () => {
  test('maps ring tones to plain-language headline bands', () => {
    expect(contextUsageHeadlineKind('info')).toBe('healthy');
    expect(contextUsageHeadlineKind('warning')).toBe('warning');
    expect(contextUsageHeadlineKind('destructive')).toBe('danger');
  });
});

import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, StepFinishPart } from '@kortix/sdk/opencode-client';

import {
  COST_MARKUP,
  formatCost,
  getSessionCost,
  getTurnCost,
  type ModelPricingLookup,
} from './turns';
import type { MessageWithParts, PartWithMessage } from './types';

const deepseekRates = {
  inputPer1M: 0.435,
  outputPer1M: 0.87,
};

const lookup: ModelPricingLookup = (providerID, modelID) => {
  if (providerID === 'kortix' && modelID === 'deepseek-v4-pro') return deepseekRates;
  return null;
};

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-assistant-1',
    sessionID: 'session-1',
    role: 'assistant',
    providerID: 'kortix',
    modelID: 'deepseek-v4-pro',
    time: { created: 1 },
    ...overrides,
  } as AssistantMessage;
}

function stepFinishPart(overrides: Partial<StepFinishPart> = {}): StepFinishPart {
  return {
    type: 'step-finish',
    id: 'step-1',
    cost: 0,
    tokens: { input: 1_000_000, output: 0 },
    ...overrides,
  };
}

describe('getSessionCost', () => {
  test('returns zero when step-finish cost is unset and no pricing lookup is provided', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo(),
        parts: [stepFinishPart()],
      },
    ];
    expect(getSessionCost(messages)).toBe(0);
  });

  test('estimates billed cost from step-finish tokens when reported cost is zero', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo(),
        parts: [stepFinishPart({ tokens: { input: 1_000_000, output: 0 } })],
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('uses reported step-finish cost without re-estimating from tokens', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo(),
        parts: [stepFinishPart({ cost: 0.5, tokens: { input: 1, output: 1 } })],
      },
    ];
    expect(getSessionCost(messages, lookup)).toBeCloseTo(0.5 * COST_MARKUP, 8);
  });

  test('falls back to assistant message tokens when no step-finish parts exist', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo({
          tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('sums costs across multiple assistant messages', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo({ id: 'a1' }),
        parts: [stepFinishPart({ id: 's1', tokens: { input: 500_000, output: 0 } })],
      },
      {
        info: assistantInfo({ id: 'a2' }),
        parts: [stepFinishPart({ id: 's2', tokens: { input: 500_000, output: 0 } })],
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('regression: gateway session with tokens but step-finish.cost zero shows billed spend', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo(),
        parts: [
          stepFinishPart({
            cost: 0,
            tokens: { input: 23_330, output: 217, reasoning: 40 },
          }),
        ],
      },
    ];
    const raw =
      (23_330 / 1_000_000) * deepseekRates.inputPer1M +
      ((217 + 40) / 1_000_000) * deepseekRates.outputPer1M;
    const billed = getSessionCost(messages, lookup);
    expect(billed).toBeGreaterThan(0);
    expect(billed).toBeCloseTo(raw * COST_MARKUP, 8);
    expect(formatCost(billed)).not.toBe('$0.00');
  });

  test('includes reasoning tokens in output-side pricing', () => {
    const messages: MessageWithParts[] = [
      {
        info: assistantInfo(),
        parts: [
          stepFinishPart({
            tokens: { input: 0, output: 0, reasoning: 1_000_000 },
          }),
        ],
      },
    ];
    const raw = 1 * deepseekRates.outputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });
});

describe('getTurnCost', () => {
  test('returns undefined when the turn has no billable usage', () => {
    expect(getTurnCost([])).toBeUndefined();
  });

  test('estimates turn cost from zero-cost step-finish parts', () => {
    const parts: PartWithMessage[] = [
      {
        part: stepFinishPart({ tokens: { input: 1_000_000, output: 0 } }),
        message: { info: assistantInfo(), parts: [] },
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    const result = getTurnCost(parts, lookup);
    expect(result?.cost).toBeCloseTo(raw * COST_MARKUP, 8);
    expect(result?.tokens.input).toBe(1_000_000);
  });

  test('falls back to assistant tokens when step-finish parts are missing', () => {
    const parts: PartWithMessage[] = [
      {
        part: { type: 'text', id: 'text-1', text: 'hello' },
        message: {
          info: assistantInfo({
            tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
          parts: [],
        },
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getTurnCost(parts, lookup)?.cost).toBeCloseTo(raw * COST_MARKUP, 8);
  });
});

describe('formatCost', () => {
  test('formats sub-cent amounts with extra precision', () => {
    expect(formatCost(0.00032)).toBe('$0.0003');
    expect(formatCost(0.0032)).toBe('$0.003');
  });

  test('formats whole-cent amounts with two decimals', () => {
    expect(formatCost(2.22)).toBe('$2.22');
  });
});

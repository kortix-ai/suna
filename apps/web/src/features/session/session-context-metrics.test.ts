/**
 * Characterization tests for the context-modal metric math (KRTX-406 phase 1).
 *
 * These pin the CURRENT behavior of `getSessionContextMetrics` and
 * `estimateBreakdown` before the modal is split into modules, so the phase-2/3
 * moves can prove the numeric output is unchanged. Every expected value here
 * is computed by hand from the implementation, not from another abstraction.
 */
import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, ModelPricingLookup, Part, UserMessage } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import type { MessageWithParts } from '@/ui/types';
import { estimateBreakdown } from './session-context-modal';
import { getSessionContextMetrics } from './session-context-metrics';

// ─── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  seq += 1;
  const base: AssistantMessage = {
    id: `asst-${seq}`,
    sessionID: 'sess-test',
    role: 'assistant',
    time: { created: 1_700_000_000_000 + seq },
    parentID: 'user-0',
    modelID: 'claude-x',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/tmp/demo', root: '/tmp/demo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return {
    ...base,
    ...overrides,
  };
}

function user(): UserMessage {
  seq += 1;
  return {
    id: `user-${seq}`,
    sessionID: 'sess-test',
    role: 'user',
    time: { created: 1_700_000_000_000 + seq },
    agent: 'build',
    model: { providerID: 'kortix', modelID: 'claude-x' },
  };
}

function row(info: Message, parts: Part[] = []): MessageWithParts {
  return { info, parts };
}

let partSeq = 0;

function textPart(text: string): Part {
  partSeq += 1;
  return { id: `p-${partSeq}`, sessionID: 'sess-test', messageID: 'm', type: 'text', text };
}

function reasoningPart(text: string): Part {
  partSeq += 1;
  return {
    id: `p-${partSeq}`,
    sessionID: 'sess-test',
    messageID: 'm',
    type: 'reasoning',
    text,
    time: { start: 0 },
  };
}

function toolPart(state: Extract<Part, { type: 'tool' }>['state']): Part {
  partSeq += 1;
  return {
    id: `p-${partSeq}`,
    sessionID: 'sess-test',
    messageID: 'm',
    type: 'tool',
    tool: 'bash',
    callID: `call-${partSeq}`,
    state,
  };
}

function filePart(sourceText?: string): Part {
  partSeq += 1;
  return {
    id: `p-${partSeq}`,
    sessionID: 'sess-test',
    messageID: 'm',
    type: 'file',
    mime: 'text/plain',
    url: 'file:///demo/x.txt',
    source:
      sourceText === undefined
        ? undefined
        : { text: { value: sourceText, start: 0, end: sourceText.length }, type: 'file', path: 'x.txt' },
  };
}

function agentPart(sourceValue?: string): Part {
  partSeq += 1;
  return {
    id: `p-${partSeq}`,
    sessionID: 'sess-test',
    messageID: 'm',
    type: 'agent',
    name: 'explore',
    source:
      sourceValue === undefined ? undefined : { value: sourceValue, start: 0, end: sourceValue.length },
  };
}

function stepStartPart(): Part {
  partSeq += 1;
  return { id: `p-${partSeq}`, sessionID: 'sess-test', messageID: 'm', type: 'step-start' };
}

type FixtureModel = { name: string; provider?: string; limitContext?: number };

/**
 * The gateway serves `model.provider` as the REAL upstream provider id (a
 * string, e.g. "anthropic") while the generated opencode type says
 * `{ npm: string }`; the modal reads the string form. One cast here keeps the
 * fixture on the runtime shape.
 */
function providersOf(id: string, models: Record<string, FixtureModel>): ProviderListResponse {
  return {
    all: [
      {
        id,
        name: id === 'kortix' ? 'Kortix' : 'Acme Corp',
        env: [],
        models: Object.fromEntries(
          Object.entries(models).map(([modelID, m]) => [
            modelID,
            {
              id: modelID,
              name: m.name,
              provider: m.provider,
              limit: m.limitContext ? { context: m.limitContext, output: 8192 } : undefined,
            },
          ]),
        ),
      },
    ],
  } as unknown as ProviderListResponse;
}

function positiveTokens(): AssistantMessage['tokens'] {
  return { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

const freeLookup: ModelPricingLookup = () => null;
const lookup: ModelPricingLookup = () => ({
  inputPer1M: 1,
  outputPer1M: 2,
  cacheReadPer1M: 0.1,
  cacheWritePer1M: 2,
});

// ─── getSessionContextMetrics ────────────────────────────────────────────────

describe('getSessionContextMetrics', () => {
  test('empty messages → no context, no cost', () => {
    const metrics = getSessionContextMetrics([], undefined, freeLookup);
    expect(metrics.totalCost).toBe(0);
    expect(metrics.context).toBeUndefined();
  });

  test('no assistant message → no context', () => {
    const metrics = getSessionContextMetrics([row(user())], undefined, freeLookup);
    expect(metrics.context).toBeUndefined();
    expect(metrics.totalCost).toBe(0);
  });

  test('assistant with zero tokens is skipped → no context', () => {
    const msg = assistant();
    const metrics = getSessionContextMetrics(
      [row(user()), row(msg)],
      providersOf('kortix', { 'claude-x': { name: 'Claude X' } }),
      freeLookup,
    );
    expect(metrics.context).toBeUndefined();
  });

  test('picks the LAST assistant with positive tokens', () => {
    const earlier = assistant({ tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    const later = assistant(); // all-zero tokens
    const metrics = getSessionContextMetrics(
      [row(user()), row(earlier), row(user()), row(later)],
      undefined,
      freeLookup,
    );
    expect(metrics.context?.message.id).toBe(earlier.id);
    expect(metrics.context?.input).toBe(10);
  });

  test('maps every token field and total = input+output+reasoning+cache', () => {
    const msg = assistant({
      tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 120, write: 50 } },
    });
    const metrics = getSessionContextMetrics([row(msg)], undefined, freeLookup);
    const ctx = metrics.context;
    expect(ctx?.input).toBe(100);
    expect(ctx?.output).toBe(200);
    expect(ctx?.reasoning).toBe(30);
    expect(ctx?.cacheRead).toBe(120);
    expect(ctx?.cacheWrite).toBe(50);
    expect(ctx?.total).toBe(500);
  });

  test('usage = round(total / limit * 100); limit passes through', () => {
    const msg = assistant({
      providerID: 'kortix',
      tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 120, write: 50 } },
    });
    const metrics = getSessionContextMetrics(
      [row(msg)],
      providersOf('kortix', { 'claude-x': { name: 'Claude X', limitContext: 2000 } }),
      freeLookup,
    );
    expect(metrics.context?.limit).toBe(2000);
    expect(metrics.context?.usage).toBe(25);
  });

  test('no model → limit undefined, usage null', () => {
    const msg = assistant({ providerID: 'kortix', tokens: positiveTokens() });
    const metrics = getSessionContextMetrics(
      [row(msg)],
      providersOf('kortix', {}),
      freeLookup,
    );
    expect(metrics.context?.limit).toBeUndefined();
    expect(metrics.context?.usage).toBeNull();
    expect(metrics.context?.modelLabel).toBe('claude-x');
  });

  test('gateway provider resolves the upstream label from model.provider', () => {
    const msg = assistant({ providerID: 'kortix', tokens: positiveTokens() });
    const metrics = getSessionContextMetrics(
      [row(msg)],
      providersOf('kortix', { 'claude-x': { name: 'Claude X', provider: 'anthropic' } }),
      freeLookup,
    );
    expect(metrics.context?.providerLabel).toBe('Anthropic');
    expect(metrics.context?.modelLabel).toBe('Claude X');
  });

  test('gateway model without a provider field keeps the synthetic kortix label', () => {
    const msg = assistant({ providerID: 'kortix', tokens: positiveTokens() });
    const metrics = getSessionContextMetrics(
      [row(msg)],
      providersOf('kortix', { 'claude-x': { name: 'Claude X' } }),
      freeLookup,
    );
    expect(metrics.context?.providerLabel).toBe('Kortix');
  });

  test('known provider id maps through PROVIDER_LABELS without a providers list', () => {
    const msg = assistant({ providerID: 'anthropic', tokens: positiveTokens() });
    const metrics = getSessionContextMetrics([row(msg)], undefined, freeLookup);
    expect(metrics.context?.providerLabel).toBe('Anthropic');
  });

  test('unknown provider falls back to the provider entry name, then the raw id', () => {
    const msg = assistant({ providerID: 'acme', tokens: positiveTokens() });
    const withEntry = getSessionContextMetrics(
      [row(msg)],
      providersOf('acme', {}),
      freeLookup,
    );
    expect(withEntry.context?.providerLabel).toBe('Acme Corp');

    const withoutEntry = getSessionContextMetrics([row(msg)], undefined, freeLookup);
    expect(withoutEntry.context?.providerLabel).toBe('acme');
  });

  test('totalCost prices tokens through the lookup (raw provider cost × 1.2)', () => {
    const msg = assistant({
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(getSessionContextMetrics([row(msg)], undefined, freeLookup).totalCost).toBe(0);
    const priced = getSessionContextMetrics([row(msg)], undefined, lookup);
    expect(priced.totalCost).toBeCloseTo(1.2, 9);
  });
});

// ─── estimateBreakdown ───────────────────────────────────────────────────────

describe('estimateBreakdown', () => {
  test('zero input → no segments', () => {
    expect(estimateBreakdown([row(user(), [textPart('a'.repeat(40))])], 0)).toEqual([]);
  });

  test('under budget: system prompt counts, other absorbs the remainder', () => {
    const segments = estimateBreakdown([], 100, 'x'.repeat(80));
    expect(segments).toEqual([
      { key: 'system', tokens: 20, width: 20, percent: 20 },
      { key: 'other', tokens: 80, width: 80, percent: 80 },
    ]);
  });

  test('percent rounds half-up to one decimal; width does not round', () => {
    const segments = estimateBreakdown([], 3, 'a'.repeat(4));
    expect(segments.map((s) => s.key)).toEqual(['system', 'other']);
    expect(segments[0]?.tokens).toBe(1);
    expect(segments[0]?.percent).toBe(33.3);
    expect(segments[0]?.width).toBeCloseTo(33.3333, 3);
    expect(segments[1]?.tokens).toBe(2);
    expect(segments[1]?.percent).toBe(66.7);
    expect(segments[1]?.width).toBeCloseTo(66.6667, 3);
  });

  test('counts user text/file/agent parts, assistant text/reasoning, and every tool state', () => {
    const messages = [
      row(user(), [
        textPart('u'.repeat(40)),
        filePart('f'.repeat(32)),
        agentPart('g'.repeat(16)),
        filePart(), // no source → 0 chars
        agentPart(), // no source → 0 chars
      ]),
      row(assistant(), [
        textPart('a'.repeat(60)),
        reasoningPart('r'.repeat(20)),
        toolPart({ status: 'pending', input: { a: 1, b: 2 }, raw: 'w'.repeat(20) }),
        toolPart({
          status: 'completed',
          input: { a: 1 },
          output: 'o'.repeat(24),
          title: '',
          metadata: {},
          time: { start: 0, end: 1 },
        }),
        toolPart({ status: 'error', input: {}, error: 'e'.repeat(8), time: { start: 0, end: 1 } }),
        toolPart({ status: 'running', input: { a: 1, b: 2, c: 3 }, time: { start: 0 } }),
      ]),
    ];
    // user = (40+32+16)/4 = 22 · assistant = (60+20)/4 = 20 ·
    // tool = (2·16+20 + 1·16+24 + 0 + 3·16)/4 = 148/4 = 37 · system = 0 → omitted
    const segments = estimateBreakdown(messages, 400);
    expect(segments).toEqual([
      { key: 'user', tokens: 22, width: 5.5, percent: 5.5 },
      { key: 'assistant', tokens: 20, width: 5, percent: 5 },
      { key: 'tool', tokens: 37, width: 9.25, percent: 9.3 }, // round(92.5)/10, half-up
      { key: 'other', tokens: 321, width: 80.25, percent: 80.3 }, // round(802.5)/10
    ]);
  });

  test('over budget: scales each segment with floor and keeps other at the remainder', () => {
    const messages = [row(user(), [textPart('u'.repeat(800))])]; // 200 estimated tokens
    const segments = estimateBreakdown(messages, 100, 's'.repeat(40)); // system 10 · estimated 210
    expect(segments).toEqual([
      { key: 'system', tokens: 4, width: 4, percent: 4 }, // floor(10 · 100/210)
      { key: 'user', tokens: 95, width: 95, percent: 95 }, // floor(200 · 100/210)
      { key: 'other', tokens: 1, width: 1, percent: 1 }, // max(0, 100 − 99)
    ]);
  });

  test('exactly at budget → other is zero and omitted', () => {
    const messages = [row(user(), [textPart('u'.repeat(800))])];
    const segments = estimateBreakdown(messages, 200);
    expect(segments).toEqual([{ key: 'user', tokens: 200, width: 100, percent: 100 }]);
  });

  test('non-countable parts contribute nothing', () => {
    const messages = [row(assistant(), [stepStartPart(), textPart('')])];
    const segments = estimateBreakdown(messages, 100);
    expect(segments).toEqual([{ key: 'other', tokens: 100, width: 100, percent: 100 }]);
  });
});

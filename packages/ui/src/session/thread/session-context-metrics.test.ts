/**
 * Characterization tests for the context-modal metric math (KRTX-406 phase 1).
 *
 * These pin the behavior of `getSessionContextMetrics` and
 * `estimateBreakdown` on session-log messages (P5.2: the modal reads the
 * `fromV1` view of the v1 rows while v2 is off). Every expected value here is
 * computed by hand from the implementation, not from another abstraction.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelPricingLookup, SessionLogBlock, SessionLogMessage, SessionLogThread } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { estimateBreakdown } from './session-context-modal';
import { getSessionContextMetrics } from './session-context-metrics';

// ─── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
type Usage = NonNullable<SessionLogMessage['usage']>;

function assistant(overrides: Partial<SessionLogMessage> = {}, blocks: SessionLogBlock[] = []): SessionLogMessage {
  seq += 1;
  return {
    schema: 'kortix.session/2', v: 1,
    message_id: `asst-${seq}`, thread_id: 'sess-test', seq, role: 'assistant', kind: 'turn', status: 'complete', in_context: true,
    model: { provider: 'anthropic', model: 'claude-x' },
    usage: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0 },
    finish: 'stop', error: null,
    created_at: new Date(1_700_000_000_000 + seq).toISOString(), completed_at: null,
    producer: { harness: 'kortix-v1-import', harness_version: '', adapter_version: '' },
    blocks,
    ...overrides,
  };
}

function user(blocks: SessionLogBlock[] = []): SessionLogMessage {
  seq += 1;
  return assistant({ message_id: `user-${seq}`, role: 'user', model: { provider: 'kortix', model: 'claude-x' }, usage: null, finish: null }, blocks);
}

/** The thread the modal reads: `null` while the store holds no row. */
const thread = (messages: SessionLogMessage[]): SessionLogThread =>
  ({ schema: 'kortix.session/2', v: 1, thread_id: 'sess-test', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages });

/** A compaction: the v1 marker and its summary reply folded into one record. */
function compaction(status: SessionLogMessage['status'], summary: string | null): SessionLogMessage {
  seq += 1;
  return assistant(
    { message_id: `cmp-${seq}`, role: 'user', kind: 'compaction', status, usage: null, finish: null },
    [{ type: 'compaction', id: 'c', summary, first_kept_message_id: null }],
  );
}

let partSeq = 0;
const text = (t: string, extra: Partial<Extract<SessionLogBlock, { type: 'text' }>> = {}): SessionLogBlock => ({ type: 'text', id: `p-${++partSeq}`, text: t, ...extra });
const reasoning = (t: string): SessionLogBlock => ({ type: 'reasoning', id: `p-${++partSeq}`, text: t });
const tool = (call: Partial<Extract<SessionLogBlock, { type: 'tool_call' }>>): SessionLogBlock =>
  ({ type: 'tool_call', id: `p-${++partSeq}`, call_id: `call-${partSeq}`, name: 'bash', kind: 'shell', input: {}, status: 'complete', ...call }) as SessionLogBlock;
/** An `@file` / `@agent` mention: a v1 part the model never saw as-is, kept as a harness block. */
const mention = (kind: 'file' | 'agent', source?: unknown): SessionLogBlock =>
  ({ type: 'harness', id: `p-${++partSeq}`, harness: 'opencode', kind, data: { type: kind, source }, model_visible: false });
const step = (): SessionLogBlock => ({ type: 'step', id: `p-${++partSeq}`, phase: 'start' });

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

const positiveTokens = (): Usage => ({ input: 10, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });
const kortix = { provider: 'kortix', model: 'claude-x' };

const freeLookup: ModelPricingLookup = () => null;
const lookup: ModelPricingLookup = () => ({
  inputPer1M: 1,
  outputPer1M: 2,
  cacheReadPer1M: 0.1,
  cacheWritePer1M: 2,
});

// ─── getSessionContextMetrics ────────────────────────────────────────────────

describe('getSessionContextMetrics', () => {
  test('no thread, or an empty one → no context, no cost', () => {
    expect(getSessionContextMetrics(null, undefined, freeLookup)).toEqual({ totalCost: 0, messages: { all: 0, user: 0, assistant: 0 }, context: undefined });
    const metrics = getSessionContextMetrics(thread([]), undefined, freeLookup);
    expect(metrics.totalCost).toBe(0);
    expect(metrics.context).toBeUndefined();
  });

  test('no reply → no context', () => {
    const metrics = getSessionContextMetrics(thread([user()]), undefined, freeLookup);
    expect(metrics.context).toBeUndefined();
    expect(metrics.totalCost).toBe(0);
  });

  test('a reply with zero tokens is skipped → no context', () => {
    const metrics = getSessionContextMetrics(
      thread([user(), assistant()]),
      providersOf('kortix', { 'claude-x': { name: 'Claude X' } }),
      freeLookup,
    );
    expect(metrics.context).toBeUndefined();
  });

  test('picks the LAST reply with positive tokens', () => {
    const earlier = assistant({ usage: positiveTokens() });
    const later = assistant(); // all-zero usage
    const metrics = getSessionContextMetrics(thread([user(), earlier, user(), later]), undefined, freeLookup);
    expect(metrics.context?.message.message_id).toBe(earlier.message_id);
    expect(metrics.context?.input).toBe(10);
  });

  test('a compaction is a reply: its summary\'s usage is the context', () => {
    const cmp = compaction('complete', 'summary');
    cmp.usage = { input: 5, output: 1, cache_read: 0, cache_write: 0 };
    const metrics = getSessionContextMetrics(thread([user(), assistant({ usage: positiveTokens() }), cmp]), undefined, freeLookup);
    expect(metrics.context?.message.message_id).toBe(cmp.message_id);
    expect(metrics.context?.total).toBe(6);
    // The counts are the SDK's: the compaction is its marker plus its summary reply.
    expect(metrics.messages).toEqual({ all: 4, user: 2, assistant: 2 });
    expect(metrics.context?.reasoning).toBe(0);
  });

  test('maps every token field and total = input+output+reasoning+cache', () => {
    const msg = assistant({ usage: { input: 100, output: 200, reasoning: 30, cache_read: 120, cache_write: 50 } });
    const ctx = getSessionContextMetrics(thread([msg]), undefined, freeLookup).context;
    expect(ctx?.input).toBe(100);
    expect(ctx?.output).toBe(200);
    expect(ctx?.reasoning).toBe(30);
    expect(ctx?.cacheRead).toBe(120);
    expect(ctx?.cacheWrite).toBe(50);
    expect(ctx?.total).toBe(500);
  });

  test('usage = round(total / limit * 100); limit passes through', () => {
    const msg = assistant({ model: kortix, usage: { input: 100, output: 200, reasoning: 30, cache_read: 120, cache_write: 50 } });
    const metrics = getSessionContextMetrics(
      thread([msg]),
      providersOf('kortix', { 'claude-x': { name: 'Claude X', limitContext: 2000 } }),
      freeLookup,
    );
    expect(metrics.context?.limit).toBe(2000);
    expect(metrics.context?.usage).toBe(25);
  });

  test('no model → limit undefined, usage null', () => {
    const msg = assistant({ model: kortix, usage: positiveTokens() });
    const metrics = getSessionContextMetrics(thread([msg]), providersOf('kortix', {}), freeLookup);
    expect(metrics.context?.limit).toBeUndefined();
    expect(metrics.context?.usage).toBeNull();
    expect(metrics.context?.modelLabel).toBe('claude-x');
  });

  test('missing provider entry keeps raw model id and leaves limits undefined', () => {
    const msg = assistant({ model: { provider: 'missing-provider', model: 'claude-x' }, usage: positiveTokens() });
    const context = getSessionContextMetrics(thread([msg]), providersOf('kortix', {}), freeLookup).context;
    expect(context?.providerLabel).toBe('missing-provider');
    expect(context?.modelLabel).toBe('claude-x');
    expect(context?.limit).toBeUndefined();
    expect(context?.usage).toBeNull();
  });

  test('gateway provider resolves the upstream label from model.provider', () => {
    const msg = assistant({ model: kortix, usage: positiveTokens() });
    const metrics = getSessionContextMetrics(
      thread([msg]),
      providersOf('kortix', { 'claude-x': { name: 'Claude X', provider: 'anthropic' } }),
      freeLookup,
    );
    expect(metrics.context?.providerLabel).toBe('Anthropic');
    expect(metrics.context?.modelLabel).toBe('Claude X');
  });

  test('gateway model without a provider field keeps the synthetic kortix label', () => {
    const msg = assistant({ model: kortix, usage: positiveTokens() });
    const metrics = getSessionContextMetrics(thread([msg]), providersOf('kortix', { 'claude-x': { name: 'Claude X' } }), freeLookup);
    expect(metrics.context?.providerLabel).toBe('Kortix');
  });

  test('known provider id maps through PROVIDER_LABELS without a providers list', () => {
    const msg = assistant({ usage: positiveTokens() });
    const metrics = getSessionContextMetrics(thread([msg]), undefined, freeLookup);
    expect(metrics.context?.providerLabel).toBe('Anthropic');
  });

  test('unknown provider falls back to the provider entry name, then the raw id', () => {
    const msg = assistant({ model: { provider: 'acme', model: 'claude-x' }, usage: positiveTokens() });
    expect(getSessionContextMetrics(thread([msg]), providersOf('acme', {}), freeLookup).context?.providerLabel).toBe('Acme Corp');
    expect(getSessionContextMetrics(thread([msg]), undefined, freeLookup).context?.providerLabel).toBe('acme');
  });

  test('totalCost prices tokens through the lookup (raw provider cost × 1.055); a reported cost wins', () => {
    const msg = assistant({ usage: { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 } });
    expect(getSessionContextMetrics(thread([msg]), undefined, freeLookup).totalCost).toBe(0);
    expect(getSessionContextMetrics(thread([msg]), undefined, lookup).totalCost).toBeCloseTo(1.055, 9);
    const reported = assistant({ usage: { ...positiveTokens(), cost: 0.5 } });
    expect(getSessionContextMetrics(thread([reported]), undefined, lookup).totalCost).toBeCloseTo(0.5275, 9);
    // A message without a model has no price; a user message never costs.
    expect(getSessionContextMetrics(thread([assistant({ model: null, usage: positiveTokens() }), user()]), undefined, lookup).totalCost).toBe(0);
  });
});

// ─── estimateBreakdown ───────────────────────────────────────────────────────

describe('estimateBreakdown', () => {
  test('zero input → no segments', () => {
    expect(estimateBreakdown([user([text('a'.repeat(40))])], 0)).toEqual([]);
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

  test('counts user text/file/agent blocks, assistant text/reasoning, and every tool state', () => {
    const messages = [
      user([
        text('u'.repeat(40)),
        mention('file', { text: { value: 'f'.repeat(32), start: 0, end: 32 }, type: 'file', path: 'x.txt' }),
        mention('agent', { value: 'g'.repeat(16), start: 0, end: 16 }),
        mention('file'), // no source → 0 chars
        mention('agent'), // no source → 0 chars
      ]),
      assistant({}, [
        text('a'.repeat(60)),
        reasoning('r'.repeat(20)),
        // A pending call still streaming its arguments as text: the text so far.
        tool({ status: 'pending', input: 'w'.repeat(20) }),
        tool({ status: 'complete', input: { a: 1 }, result: { content: [{ type: 'text', text: 'o'.repeat(24) }], is_error: false } }),
        tool({ status: 'error', input: {}, result: { content: [], is_error: true, error: { message: 'e'.repeat(8) } } }),
        tool({ status: 'running', input: { a: 1, b: 2, c: 3 } }),
      ]),
    ];
    // user = (40+32+16)/4 = 22 · assistant = (60+20)/4 = 20 ·
    // tool = (20 + 1·16+24 + 8 + 3·16)/4 = 116/4 = 29 · system = 0 → omitted
    const segments = estimateBreakdown(messages, 400);
    expect(segments.map((s) => ({ ...s, width: Math.round(s.width * 100) / 100 }))).toEqual([
      { key: 'user', tokens: 22, width: 5.5, percent: 5.5 },
      { key: 'assistant', tokens: 20, width: 5, percent: 5 },
      { key: 'tool', tokens: 29, width: 7.25, percent: 7.3 }, // round(72.5)/10, half-up
      { key: 'other', tokens: 329, width: 82.25, percent: 82.3 }, // round(822.5)/10
    ]);
  });

  test('an offloaded text counts its whole length; a compaction summary counts as a reply', () => {
    const messages = [user([text('p', { bytes: 400 })]), compaction('complete', 's'.repeat(80))];
    expect(estimateBreakdown(messages, 200)).toEqual([
      { key: 'user', tokens: 100, width: 50, percent: 50 },
      { key: 'assistant', tokens: 20, width: 10, percent: 10 },
      { key: 'other', tokens: 80, width: 40, percent: 40 },
    ]);
  });

  test('over budget: scales each segment with floor and keeps other at the remainder', () => {
    const messages = [user([text('u'.repeat(800))])]; // 200 estimated tokens
    const segments = estimateBreakdown(messages, 100, 's'.repeat(40)); // system 10 · estimated 210
    expect(segments).toEqual([
      { key: 'system', tokens: 4, width: 4, percent: 4 }, // floor(10 · 100/210)
      { key: 'user', tokens: 95, width: 95, percent: 95 }, // floor(200 · 100/210)
      { key: 'other', tokens: 1, width: 1, percent: 1 }, // max(0, 100 − 99)
    ]);
  });

  test('exactly at budget → other is zero and omitted', () => {
    const segments = estimateBreakdown([user([text('u'.repeat(800))])], 200);
    expect(segments).toEqual([{ key: 'user', tokens: 200, width: 100, percent: 100 }]);
  });

  test('non-countable blocks contribute nothing', () => {
    const segments = estimateBreakdown([assistant({}, [step(), text('')])], 100);
    expect(segments).toEqual([{ key: 'other', tokens: 100, width: 100, percent: 100 }]);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  PLATFORM_DEFAULT_MODEL_ID,
  catalogModelForWireModel,
  getManagedModel,
  isManagedModelId,
} from './index';

const served = [
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
];

// Kortix Platinum inference serves every managed model (README). Vision is per model.
describe('managed catalog', () => {
  test('serves the selected managed models', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual(served);
    expect(PLATFORM_DEFAULT_MODEL_ID).toBe('deepseek-v4.1-flash');
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe('deepseek-v4.1-flash');
  });

  test('every managed model has explicit credit pricing and never shows an upstream brand', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.pricing?.inputPerMillion).toBeGreaterThan(0);
      expect(model.pricing?.outputPerMillion).toBeGreaterThan(0);
      expect(model.providerBrand).toBeUndefined();
    }
  });

  // Platinum's price list: the gateway bills Platinum's usage.cost and falls
  // back to this table. A change here is a price change for every customer.
  test('managed prices match the Platinum inference price list', () => {
    expect(getManagedModel('deepseek-v4.1-flash')?.pricing).toEqual({
      inputPerMillion: 0.15,
      cachedInputPerMillion: 0.003,
      outputPerMillion: 0.6,
    });
    expect(getManagedModel('glm-5.3-flash')?.pricing).toEqual({
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 0.35,
    });
    expect(getManagedModel('kimi-k3')).toBeUndefined();
    expect(getManagedModel('morph-dsv4flash')).toBeUndefined();
  });

  test('old Kortix managed IDs and BYOK refs do not resolve as managed', () => {
    for (const old of [
      'grok-4.6', 'deepseek-v4-flash', 'muse-spark-1.2',
      'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813', 'kimi-k3-fast',
      'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
      'claude-opus-5.5', 'gpt-6-sol', 'gpt-6-luna',
      'anthropic/claude-opus-4.8', 'nope',
    ]) {
      expect(getManagedModel(old)).toBeUndefined();
      expect(isManagedModelId(old)).toBe(false);
    }
    expect(getManagedModel('deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash');
  });
});

// Prod 2026-09-30: a long GLM session hit `context_length_exceeded` on every
// turn. `limit.context` equalled the endpoint window, so OpenCode's compaction
// point was the rejection point and the step that crossed it was refused.
//
// The smallest window any serving upstream accepted, probed on 2026-09-30 with
// synthetic prompts at the edge. A Platinum upstream change needs a new probe.
// A new managed model needs a measured entry before it ships.
const MEASURED_CONTEXT_WINDOW: Record<string, number> = {
  'glm-5.3-flash': 1_048_573,
  // 1017 snapshot (2026-10-18): prompt + max_tokens <= 1,048,576.
  'deepseek-v4.1-flash': 1_048_576,
  'kimi-k3': 1_048_575,
};

// OpenCode 1.18.23 (session/overflow.ts) compacts after a step that used
// `limit.context - maxTokens` tokens, and sends `max_tokens = maxTokens`
// (capped at OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = 65,536 in the sandbox). A route
// that checks prompt + max_tokens rejects any prompt above `window - maxTokens`.
// The difference is what one more step may add: a new message plus tool results
// (OpenCode truncates each tool result at 50 KB, about 12,000 tokens).
const MIN_STEP_HEADROOM = 32_768;

describe('managed context windows', () => {
  test.each(MANAGED_MODELS.map((model) => [model.id, model] as const))(
    '%s compacts before a serving route rejects the next request',
    (id, model) => {
      const window = MEASURED_CONTEXT_WINDOW[id];
      expect(window, `probe every route of ${id} and record its window`).toBeGreaterThan(0);
      const maxTokens = Math.min(model.limit.output, 65_536);
      const compactsAt = model.limit.context - maxTokens;
      const largestAcceptedPrompt = window! - maxTokens;
      expect(largestAcceptedPrompt - compactsAt).toBeGreaterThanOrEqual(MIN_STEP_HEADROOM);
    },
  );
});

// Product rule: Kortix-managed models are open-weight models only. OpenAI and
// Anthropic models reach members through BYOK (`openai/…`, `anthropic/…`) or a
// ChatGPT plan (`codex/…`), never through Kortix credits. Claude Opus 5.5,
// GPT-6 Sol, GPT-6 Luna and GPT-6 Astra were each added as managed and removed.
describe('OpenAI and Anthropic models are never Kortix-managed', () => {
  test('no managed model is an OpenAI or Anthropic model', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.pricingRef, model.id).not.toMatch(/^(openai|anthropic)\//);
      expect(model.id, model.id).not.toMatch(/^(gpt|claude|o\d)/);
    }
  });
});

// The BYOK and ChatGPT routes read these bundled records for temperature and
// reasoning_options (released 2026-09-22).
describe('GPT-6 Sol, GPT-6 Luna and Claude Opus 5.5 BYOK and ChatGPT records', () => {
  test.each([
    ['codex/gpt-6-sol', 'GPT-6 Sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['codex/gpt-6-luna', 'GPT-6 Luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic/claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('%s resolves to its bundled catalog record', (wireId, name, efforts) => {
    const record = catalogModelForWireModel(wireId, CATALOG);
    expect(record?.name).toBe(name);
    expect(record?.modalities?.input).toContain('image');
    expect(record?.tool_call).toBe(true);
    expect(record?.reasoning_options).toContainEqual({ type: 'effort', values: efforts });
  });

  test('the GPT-6 records reject a client temperature', () => {
    for (const wireId of ['codex/gpt-6-sol', 'codex/gpt-6-luna']) {
      expect(catalogModelForWireModel(wireId, CATALOG)?.temperature).toBe(false);
    }
  });
});

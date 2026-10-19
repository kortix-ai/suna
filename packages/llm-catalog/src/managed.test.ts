import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  PLATFORM_DEFAULT_MODEL_ID,
  VERIFIED_MANAGED_ENDPOINTS,
  catalogModelForWireModel,
  getManagedModel,
  isManagedModelId,
} from './index';

const served = [
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
];

// Every bundled route pins endpoints from OpenRouter's ZDR feed that passed the
// 2026-10-19 probes (README). Vision is per model.
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

  test('direct Morph fallback prices match the current public rate card', () => {
    expect(getManagedModel('deepseek-v4.1-flash')?.morphPricing).toEqual({
      inputPerMillion: 0.15,
      cachedInputPerMillion: 0.003,
      outputPerMillion: 0.6,
    });
    expect(getManagedModel('glm-5.3-flash')?.morphPricing).toEqual({
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 0.35,
    });
  });

  test('every managed route pins verified ZDR endpoints and excludes Morph', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.transport).toBe('openrouter');
      const route = model.openrouterProvider as {
        only: string[]; allow_fallbacks: boolean; zdr: boolean; data_collection: string;
        max_price: { prompt: number; completion: number };
      };
      expect(route).toMatchObject({ allow_fallbacks: true, zdr: true, data_collection: 'deny' });
      expect(route.only.length, model.id).toBeGreaterThanOrEqual(1);
      for (const tag of route.only) expect(VERIFIED_MANAGED_ENDPOINTS as readonly string[], `${model.id} ${tag}`).toContain(tag);
      expect(route.only.some((tag) => tag.startsWith('morph')), model.id).toBe(false);
      expect(new Set(route.only).size, model.id).toBe(route.only.length);
      expect(route.max_price.prompt).toBeGreaterThanOrEqual(model.pricing!.inputPerMillion);
      expect(route.max_price.completion).toBeGreaterThanOrEqual(model.pricing!.outputPerMillion);
    }
  });

  test('fallback billing covers every allowed OpenRouter endpoint price', () => {
    for (const model of MANAGED_MODELS) {
      const allowed = (model.openrouterProvider as { only: string[] }).only;
      expect(Object.keys(model.openrouterEndpointPricing ?? {})).toEqual(allowed);
      for (const tag of allowed) {
        const endpoint = model.openrouterEndpointPricing?.[tag];
        expect(endpoint, `${model.id} ${tag}`).toBeDefined();
        expect(model.pricing!.inputPerMillion).toBeGreaterThanOrEqual(endpoint!.inputPerMillion);
        expect(model.pricing!.cachedInputPerMillion!).toBeGreaterThanOrEqual(endpoint!.cachedInputPerMillion);
        expect(model.pricing!.outputPerMillion).toBeGreaterThanOrEqual(endpoint!.outputPerMillion);
      }
    }
  });

  test('fallback pools exclude endpoints that failed the 2026-10-19 probes', () => {
    const only = (id: string) => (getManagedModel(id)?.openrouterProvider as { only: string[] }).only;
    // 429 from a shared pool on most requests.
    for (const tag of ['coreweave/fp8', 'coreweave/nvfp4', 'decart/fp4', 'baseten', 'baseten/fp8', 'baseten/fp8/us']) {
      expect(only('deepseek-v4.1-flash'), tag).not.toContain(tag);
      expect(only('glm-5.3-flash'), tag).not.toContain(tag);
    }
    // Garbled text (GLM) or failed image input.
    expect(only('deepseek-v4.1-flash')).not.toContain('relace');
    for (const tag of ['relace', 'digitalocean', 'sail-research/us', 'sail-research/fp4']) expect(only('glm-5.3-flash')).not.toContain(tag);
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
// The smallest window each route that serves the model accepted, probed on
// 2026-09-30 with synthetic prompts at the edge (README, "Context windows").
// A new managed model needs a measured entry before it ships.
const MEASURED_CONTEXT_WINDOW: Record<string, number> = {
  // Zen, prompt only. OpenRouter Decart and CoreWeave: prompt + max_tokens <= 1,048,576.
  'glm-5.3-flash': 1_048_573,
  // OpenRouter Morph, 1017 snapshot (2026-10-18): prompt + max_tokens <= 1,048,576.
  'deepseek-v4.1-flash': 1_048_576,
  // OpenRouter Fireworks, prompt only. Morph answered 429 to every probe.
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
  test('no managed model routes to an OpenAI or Anthropic upstream', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.upstreamModelId, model.id).not.toMatch(/^(openai|anthropic)\//);
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

import { describe, expect, test } from 'bun:test';
import { type CatalogModel, clampGenerationConfig, generationControlCapabilities } from './index';

// gpt-5.6-sol-shaped: reasoning with an explicit effort enum, fixed temperature.
const REASONING_FIXED_TEMP: CatalogModel = {
  id: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  reasoning: true,
  reasoning_options: [
    { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  temperature: false,
  limit: { context: 1_050_000, output: 128_000 },
};

// A reasoning model with NO explicit reasoning_options (task's documented fallback case).
const REASONING_NO_OPTIONS: CatalogModel = {
  id: 'mystery-reasoner',
  name: 'Mystery Reasoner',
  reasoning: true,
  temperature: true,
  limit: { output: 8_192 },
};

// A plain non-reasoning, temperature-tunable model.
const PLAIN_TEMP_MODEL: CatalogModel = {
  id: 'gpt-4.1',
  name: 'GPT-4.1',
  reasoning: false,
  temperature: true,
  limit: { context: 128_000, output: 16_384 },
};

// No limit.output at all.
const NO_LIMIT_MODEL: CatalogModel = {
  id: 'no-limit',
  name: 'No Limit',
  temperature: true,
};

describe('generationControlCapabilities', () => {
  test('undefined/null model → nothing is capability-gated on', () => {
    expect(generationControlCapabilities(undefined)).toEqual({ temperature: false, topP: false });
    expect(generationControlCapabilities(null)).toEqual({ temperature: false, topP: false });
  });

  test('exposes the model EXACT reasoning_options values verbatim (gpt-5.6-sol shape)', () => {
    const caps = generationControlCapabilities(REASONING_FIXED_TEMP);
    expect(caps.reasoningEffort).toEqual({
      values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  test('temperature:false HIDES the temperature (and top_p) control', () => {
    const caps = generationControlCapabilities(REASONING_FIXED_TEMP);
    expect(caps.temperature).toBe(false);
    expect(caps.topP).toBe(false);
  });

  test('a reasoning:true model with no reasoning_options exposes NO effort control (never fabricated)', () => {
    const caps = generationControlCapabilities(REASONING_NO_OPTIONS);
    expect(caps.reasoningEffort).toBeUndefined();
  });

  test('reasoning:false / absent → no reasoningEffort control at all', () => {
    const caps = generationControlCapabilities(PLAIN_TEMP_MODEL);
    expect(caps.reasoningEffort).toBeUndefined();
  });

  test('temperature:true shows both temperature and top_p (documented heuristic)', () => {
    const caps = generationControlCapabilities(PLAIN_TEMP_MODEL);
    expect(caps.temperature).toBe(true);
    expect(caps.topP).toBe(true);
  });

  test('maxOutputTokens ceiling mirrors limit.output when positive', () => {
    expect(generationControlCapabilities(PLAIN_TEMP_MODEL).maxOutputTokens).toEqual({
      ceiling: 16_384,
    });
  });

  test('no limit.output → no maxOutputTokens control', () => {
    expect(generationControlCapabilities(NO_LIMIT_MODEL).maxOutputTokens).toBeUndefined();
  });
});

describe('clampGenerationConfig', () => {
  test('null/undefined config → {}', () => {
    expect(clampGenerationConfig(undefined, PLAIN_TEMP_MODEL)).toEqual({});
    expect(clampGenerationConfig(null, PLAIN_TEMP_MODEL)).toEqual({});
  });

  test('drops temperature for a temperature:false model (never send to gpt-5.6-sol)', () => {
    const out = clampGenerationConfig({ temperature: 0.7 }, REASONING_FIXED_TEMP);
    expect(out.temperature).toBeUndefined();
  });

  test('drops top_p alongside temperature for a temperature:false model', () => {
    const out = clampGenerationConfig({ topP: 0.9 }, REASONING_FIXED_TEMP);
    expect(out.topP).toBeUndefined();
  });

  test('keeps a valid reasoningEffort that is one of the model exact values', () => {
    const out = clampGenerationConfig({ reasoningEffort: 'xhigh' }, REASONING_FIXED_TEMP);
    expect(out.reasoningEffort).toBe('xhigh');
  });

  test('drops a reasoningEffort value not in the model reasoning_options', () => {
    const out = clampGenerationConfig({ reasoningEffort: 'ultra' }, REASONING_FIXED_TEMP);
    expect(out.reasoningEffort).toBeUndefined();
  });

  test('drops reasoningEffort entirely for a non-reasoning model', () => {
    const out = clampGenerationConfig({ reasoningEffort: 'low' }, PLAIN_TEMP_MODEL);
    expect(out.reasoningEffort).toBeUndefined();
  });

  test('clamps temperature into [0, 2]', () => {
    expect(clampGenerationConfig({ temperature: 5 }, PLAIN_TEMP_MODEL).temperature).toBe(2);
    expect(clampGenerationConfig({ temperature: -1 }, PLAIN_TEMP_MODEL).temperature).toBe(0);
    expect(clampGenerationConfig({ temperature: 0.6 }, PLAIN_TEMP_MODEL).temperature).toBe(0.6);
  });

  test('clamps top_p into [0, 1]', () => {
    expect(clampGenerationConfig({ topP: 3 }, PLAIN_TEMP_MODEL).topP).toBe(1);
    expect(clampGenerationConfig({ topP: -0.5 }, PLAIN_TEMP_MODEL).topP).toBe(0);
  });

  test('clamps maxOutputTokens to the model ceiling (limit.output)', () => {
    const out = clampGenerationConfig({ maxOutputTokens: 999_999 }, PLAIN_TEMP_MODEL);
    expect(out.maxOutputTokens).toBe(16_384);
  });

  test('drops maxOutputTokens for a model with no limit.output', () => {
    const out = clampGenerationConfig({ maxOutputTokens: 100 }, NO_LIMIT_MODEL);
    expect(out.maxOutputTokens).toBeUndefined();
  });

  test('floors a fractional maxOutputTokens and enforces a floor of 1', () => {
    expect(
      clampGenerationConfig({ maxOutputTokens: 100.7 }, PLAIN_TEMP_MODEL).maxOutputTokens,
    ).toBe(100);
    expect(clampGenerationConfig({ maxOutputTokens: -5 }, PLAIN_TEMP_MODEL).maxOutputTokens).toBe(
      1,
    );
  });

  test('full round-trip: only capability-supported fields survive, everything else silently dropped', () => {
    const out = clampGenerationConfig(
      { reasoningEffort: 'high', temperature: 1.5, topP: 0.5, maxOutputTokens: 50_000 },
      REASONING_FIXED_TEMP,
    );
    expect(out).toEqual({ reasoningEffort: 'high', maxOutputTokens: 50_000 });
  });
});

describe('generationControlCapabilities — effort only from real reasoning_options', () => {
  test('exposes effort values ONLY from a real models.dev reasoning_options entry', () => {
    const caps = generationControlCapabilities({
      id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
      temperature: false,
    } as CatalogModel);
    expect(caps.reasoningEffort?.values).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('exposes NO effort control for a reasoning:true model with no reasoning_options (never fabricated)', () => {
    const caps = generationControlCapabilities({
      id: 'x/thinks-but-no-knob', name: 'Thinks', reasoning: true, temperature: true,
    } as CatalogModel);
    expect(caps.reasoningEffort).toBeUndefined();
  });

  test('exposes NO effort control for a non-reasoning model', () => {
    const caps = generationControlCapabilities({
      id: 'x/plain', name: 'Plain', reasoning: false, temperature: true,
    } as CatalogModel);
    expect(caps.reasoningEffort).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  freeOpencodeZenModelIds,
  getModelPricing,
  initModelPricing,
  isFreeOpencodeZenModel,
  stopModelPricing,
} from './model-pricing';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  stopModelPricing();
});

function stubModelsDev(payload: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('model-pricing — free OpenCode Zen extraction', () => {
  test('collects opencode models with zero/absent cost as free; prices the rest', async () => {
    stubModelsDev({
      opencode: {
        models: {
          'deepseek-v4-flash-free': { id: 'deepseek-v4-flash-free', cost: { input: 0, output: 0 } },
          // codename free model — no `-free` suffix, no cost at all
          'big-pickle': { id: 'big-pickle' },
          'grok-code': { id: 'grok-code', cost: {} },
          // paid Zen model — must NOT be flagged free
          'gpt-5.5': { id: 'gpt-5.5', cost: { input: 5, output: 30 } },
        },
      },
      // a non-opencode provider's free model must NOT be treated as a free Zen model
      openrouter: {
        models: { 'something-free': { id: 'something-free', cost: { input: 0, output: 0 } } },
      },
    });

    await initModelPricing();

    expect(isFreeOpencodeZenModel('deepseek-v4-flash-free')).toBe(true);
    expect(isFreeOpencodeZenModel('big-pickle')).toBe(true);
    expect(isFreeOpencodeZenModel('grok-code')).toBe(true);
    expect(isFreeOpencodeZenModel('gpt-5.5')).toBe(false); // paid
    expect(isFreeOpencodeZenModel('something-free')).toBe(false); // not opencode

    expect(new Set(freeOpencodeZenModelIds())).toEqual(
      new Set(['deepseek-v4-flash-free', 'big-pickle', 'grok-code']),
    );

    // paid models still get a price; free ones are absent from the price map
    expect(getModelPricing('gpt-5.5')).toMatchObject({ inputPer1M: 5, outputPer1M: 30 });
    expect(getModelPricing('big-pickle')).toBeNull();
  });
});

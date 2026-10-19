import { describe, expect, test } from 'bun:test';
import type { SessionModelUsage } from '@kortix/sdk';
import { modelNameOfWire, servedModelNotice, sessionBilledCost, turnServedModel, turnServedModelResolver } from './served-model';

const models = [
  { providerID: 'kortix', providerName: 'Kortix', modelID: 'codex/gpt-6.1-sol', modelName: 'GPT-6.1 Sol (ChatGPT)' },
  { providerID: 'kortix', providerName: 'Kortix', modelID: 'glm-5.3-flash', modelName: 'GLM 5.3 Flash' },
  { providerID: 'anthropic', providerName: 'Anthropic', modelID: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5' },
];
const fallback: SessionModelUsage = {
  latest: { served_model: 'glm-5.3-flash', fallback_from: 'codex/gpt-6.1-sol', at: '2026-10-02T15:02:50.697Z', outcome: 'answered' },
  billed_cost: 0.875,
  turns: {
    msg_a: { served_models: ['glm-5.3-flash', 'codex/gpt-6.1-sol'], fallback_from: 'codex/gpt-6.1-sol', billed_cost: 0.75 },
    msg_b: { served_models: ['codex/gpt-6.1-sol'], fallback_from: null, billed_cost: 0 },
  },
};
const direct: SessionModelUsage = {
  latest: { served_model: 'codex/gpt-6.1-sol', fallback_from: null, at: '2026-10-02T15:02:50.697Z', outcome: 'answered' },
  billed_cost: 0,
  turns: { msg_b: { served_models: ['codex/gpt-6.1-sol'], fallback_from: null, billed_cost: 0 } },
};

describe('modelNameOfWire', () => {
  test('a gateway wire id reads as the picker names it', () => {
    expect(modelNameOfWire(models, 'glm-5.3-flash')).toBe('GLM 5.3 Flash');
    expect(modelNameOfWire(models, 'codex/gpt-6.1-sol')).toBe('GPT-6.1 Sol (ChatGPT)');
    expect(modelNameOfWire(models, 'anthropic/claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
  });

  test('a model the picker does not list keeps its id', () => {
    expect(modelNameOfWire(models, 'deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(modelNameOfWire(undefined, 'glm-5.3-flash')).toBe('glm-5.3-flash');
  });
});

describe('servedModelNotice', () => {
  // Incident 2026-10-02: the composer named the selected ChatGPT model while a
  // Kortix model answered every request of the session. The notice now feeds
  // the session modal; the composer strip is gone (KRTX-2685).
  test('a fallback answer is named', () => {
    expect(servedModelNotice(fallback, models)).toEqual({
      served: 'GLM 5.3 Flash',
      fallbackFrom: 'GPT-6.1 Sol (ChatGPT)',
    });
  });

  test('an older API response without an outcome still reports a fallback answer', () => {
    expect(servedModelNotice({ ...fallback, latest: {
      served_model: 'glm-5.3-flash', fallback_from: 'codex/gpt-6.1-sol', at: '2026-10-02T15:02:50.697Z',
    } }, models)).toEqual({ served: 'GLM 5.3 Flash', fallbackFrom: 'GPT-6.1 Sol (ChatGPT)' });
  });

  test('no notice when the session asked for the model that answered, or before any answer', () => {
    expect(servedModelNotice(direct, models)).toBeNull();
    expect(servedModelNotice({ latest: null, billed_cost: 0, turns: {} }, models)).toBeNull();
    expect(servedModelNotice(undefined, models)).toBeNull();
  });

  // KRTX-2572: the user cancels a running turn and the strip tells them the
  // selected model "did not answer the last request" — an intentional cancel
  // presented as a model failure. The newest request ended because the user
  // stopped it; that is not a fallback to report.
  test('no notice when the newest request ended in a client abort (intentional cancel)', () => {
    const canceled: SessionModelUsage = {
      latest: {
        served_model: 'glm-5.3-flash', fallback_from: 'codex/gpt-6.1-sol', at: '2026-10-17T01:44:33.035Z',
        outcome: 'client_aborted',
      },
      billed_cost: 0.875,
      turns: { msg_c: { served_models: [], fallback_from: 'codex/gpt-6.1-sol', billed_cost: 0.875 } },
    };
    expect(servedModelNotice(canceled, models)).toBeNull();
  });

  test('no notice when the newest request failed outright; the notice returns once a model answers again', () => {
    const failed: SessionModelUsage = {
      latest: {
        served_model: 'glm-5.3-flash', fallback_from: 'codex/gpt-6.1-sol', at: '2026-10-17T01:44:33.035Z',
        outcome: 'error',
      },
      billed_cost: 0,
      turns: {},
    };
    expect(servedModelNotice(failed, models)).toBeNull();
  });
});

describe('turnServedModel', () => {
  test('a turn names the models that answered it, the one they replaced, and the billed cost', () => {
    expect(turnServedModel(fallback, 'msg_a', models)).toEqual({
      models: ['GLM 5.3 Flash', 'GPT-6.1 Sol (ChatGPT)'],
      fallbackFrom: 'GPT-6.1 Sol (ChatGPT)',
      fallbacks: [],
      billedCost: 0.75,
    });
    expect(turnServedModel(fallback, 'msg_b', models)).toEqual({
      models: ['GPT-6.1 Sol (ChatGPT)'],
      fallbackFrom: null,
      fallbacks: [],
      billedCost: 0,
    });
  });

  test('a turn the ledger does not know has no entry', () => {
    expect(turnServedModel(fallback, 'msg_missing', models)).toBeUndefined();
    expect(turnServedModel(undefined, 'msg_a', models)).toBeUndefined();
  });
});

describe('turnServedModelResolver', () => {
  // The turn row is memoized: a new object for an unchanged turn would
  // re-render every row of the transcript on each refetch.
  test('an unchanged turn keeps its identity across refetches; a changed turn gets a new value', () => {
    const resolve = turnServedModelResolver(models);
    const first = resolve(fallback, 'msg_a');
    expect(first).toEqual(turnServedModel(fallback, 'msg_a', models)!);
    // A refetch that changed only msg_b: msg_a is the same object (structural sharing).
    const refetched: SessionModelUsage = {
      ...fallback,
      turns: { ...fallback.turns, msg_b: { served_models: ['glm-5.3-flash'], fallback_from: 'codex/gpt-6.1-sol', billed_cost: 0.5 } },
    };
    expect(resolve(refetched, 'msg_a')).toBe(first);
    expect(resolve(refetched, 'msg_b')).toEqual({ models: ['GLM 5.3 Flash'], fallbackFrom: 'GPT-6.1 Sol (ChatGPT)', fallbacks: [], billedCost: 0.5 });
    expect(resolve(refetched, 'msg_b')).not.toBe(resolve(fallback, 'msg_b'));
    expect(resolve(undefined, 'msg_a')).toBeUndefined();
  });
});

describe('sessionBilledCost', () => {
  test('a session with a fallback turn reports what Kortix billed, not the estimate for the selected model', () => {
    expect(sessionBilledCost(fallback)).toBe(0.875);
  });

  test('a session with no fallback keeps the estimate', () => {
    expect(sessionBilledCost(direct)).toBeNull();
    expect(sessionBilledCost(undefined)).toBeNull();
  });
});

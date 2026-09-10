import { expect, test } from 'bun:test';
import { sessionReasoningStorageKey, sessionReasoningVariants } from './session-reasoning';

const model = { providerID: 'kortix', modelID: 'openai/pinned' };
const config = {
  model: 'kortix/openai/pinned',
  provider: { kortix: { models: {
    'openai/pinned': { variants: { none: {}, low: {}, high: {} } },
    unrelated: { variants: { max: {} } },
  } } },
};

test('Pi uses the pinned worker capabilities instead of the gateway catalog', () => {
  expect(sessionReasoningVariants('pi-worker', config, { ultra: {}, max: {} }))
    .toEqual(['none', 'low', 'high']);
});

test('Pi keeps reasoning closed for missing, invalid, or older runtime config', () => {
  for (const value of [undefined, {}, { model: 'bad' }, { ...config, model: 'kortix/missing' }]) {
    expect(sessionReasoningVariants('pi-worker', value, { high: {} })).toEqual([]);
  }
  expect(sessionReasoningVariants('pi-worker', {
    ...config, provider: { kortix: { models: { 'openai/pinned': { variants: {} } } } },
  }, { high: {} })).toEqual([]);
});

test('OpenCode retains its model catalog reasoning choices', () => {
  expect(sessionReasoningVariants('opencode', config, { custom: {}, high: {} }))
    .toEqual(['custom', 'high']);
  expect(sessionReasoningVariants(undefined, config, undefined)).toEqual([]);
});

test('disabled reasoning levels are never offered', () => {
  expect(sessionReasoningVariants('pi-worker', {
    ...config, provider: { kortix: { models: {
      'openai/pinned': { variants: { low: {}, high: { disabled: true } } },
    } } },
  }, undefined)).toEqual(['low']);
});

test('Pi reasoning selections are scoped by session and model', () => {
  const first = sessionReasoningStorageKey('pi-worker', 'session-a', model);
  expect(first).toBeDefined();
  expect(first).toEqual(sessionReasoningStorageKey('pi-worker', 'session-a', model));
  expect(first).not.toEqual(sessionReasoningStorageKey('pi-worker', 'session-b', model));
  expect(first).not.toEqual(sessionReasoningStorageKey('pi-worker', 'session-a', { ...model, modelID: 'other' }));
  expect(first).not.toEqual(model);
  expect(sessionReasoningStorageKey('pi-worker', undefined, model)).toBeUndefined();
  expect(sessionReasoningStorageKey('pi-worker', 'session-a', undefined)).toBeUndefined();
  expect(sessionReasoningStorageKey('opencode', 'session-a', model)).toEqual(model);
});

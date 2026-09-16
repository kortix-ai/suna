import { expect, test } from 'bun:test';
import { resolveSessionDisplayModel } from './session-display-model';

const preferred = { providerID: 'kortix', modelID: 'grok-4.6' };

test('Pi displays the compiled model ahead of account and persisted selections', () => {
  expect(resolveSessionDisplayModel('pi-worker', 'kortix/gpt-5.6-luna', preferred)).toEqual({
    providerID: 'kortix', modelID: 'gpt-5.6-luna',
  });
  expect(resolveSessionDisplayModel('pi-worker', 'kortix/anthropic/claude-sonnet-4.5', preferred)).toEqual({
    providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5',
  });
});

test('Pi does not invent a model while its compiled config is unavailable', () => {
  expect(resolveSessionDisplayModel('pi-worker', undefined, preferred)).toBeUndefined();
  expect(resolveSessionDisplayModel('pi-worker', 'invalid', preferred)).toBeUndefined();
});

test('OpenCode preserves its existing model selection', () => {
  expect(resolveSessionDisplayModel('opencode', 'kortix/gpt-5.6-luna', preferred)).toEqual(preferred);
  expect(resolveSessionDisplayModel(undefined, 'kortix/gpt-5.6-luna', preferred)).toEqual(preferred);
});

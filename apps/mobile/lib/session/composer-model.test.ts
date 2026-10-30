import { describe, expect, test } from 'bun:test';

import { isModelUnavailable, sessionModelRef, selectComposerModel } from './composer-model';

describe('composer model pick', () => {
  test('picking the default clears the pick; any other model pins it', () => {
    expect(selectComposerModel('kortix/claude-sonnet-4-6', 'kortix/claude-sonnet-4-6')).toBeNull();
    expect(selectComposerModel('kortix/gpt-5', 'kortix/claude-sonnet-4-6')).toBe('kortix/gpt-5');
    expect(selectComposerModel('kortix/gpt-5', null)).toBe('kortix/gpt-5');
  });

  test('opencode_model: the bare gateway wire id', () => {
    expect(sessionModelRef({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-5' })).toBe('anthropic/claude-sonnet-5');
    expect(sessionModelRef({ providerID: 'kortix', modelID: 'kimi-k3' })).toBe('kimi-k3');
  });
});

describe('model availability (KRTX-251)', () => {
  test('the catalog loaded and offers no model: unavailable', () => {
    expect(isModelUnavailable({ loading: false, modelCount: 0 })).toBe(true);
  });

  test('the catalog is still loading: not unavailable, the send is not blocked', () => {
    expect(isModelUnavailable({ loading: true, modelCount: 0 })).toBe(false);
  });

  test('at least one model: available', () => {
    expect(isModelUnavailable({ loading: false, modelCount: 3 })).toBe(false);
  });
});

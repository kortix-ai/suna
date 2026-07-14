import { describe, expect, test } from 'bun:test';

import {
  connectionContextLine,
  connectionGroupLabel,
  defaultOptionCopy,
  harnessSubscriptionCopy,
  isSubscriptionConnection,
  shouldShowModelSearch,
} from './harness-model-selector-helpers';

describe('isSubscriptionConnection', () => {
  test('true only for claude_subscription and codex_subscription', () => {
    expect(isSubscriptionConnection('claude_subscription')).toBe(true);
    expect(isSubscriptionConnection('codex_subscription')).toBe(true);
    expect(isSubscriptionConnection('managed_gateway')).toBe(false);
    expect(isSubscriptionConnection('anthropic_api_key')).toBe(false);
    expect(isSubscriptionConnection(null)).toBe(false);
    expect(isSubscriptionConnection(undefined)).toBe(false);
  });
});

describe('harnessSubscriptionCopy', () => {
  test('Claude subscription reads "Models managed by Claude Code" / "via Claude subscription"', () => {
    expect(
      harnessSubscriptionCopy({
        connectionKind: 'claude_subscription',
        harnessLabel: 'Claude Code',
        connectionLabel: 'Claude subscription',
      }),
    ).toEqual({
      title: 'Models managed by Claude Code',
      subtitle: 'via Claude subscription',
    });
  });

  test('Codex subscription reads "Models managed by Codex" / "via ChatGPT subscription"', () => {
    expect(
      harnessSubscriptionCopy({
        connectionKind: 'codex_subscription',
        harnessLabel: 'Codex',
        connectionLabel: 'ChatGPT subscription',
      }),
    ).toEqual({
      title: 'Models managed by Codex',
      subtitle: 'via ChatGPT subscription',
    });
  });

  test('falls back to the harness label when no connection label is known', () => {
    expect(
      harnessSubscriptionCopy({
        connectionKind: 'claude_subscription',
        harnessLabel: 'Claude Code',
        connectionLabel: null,
      }),
    ).toEqual({
      title: 'Models managed by Claude Code',
      subtitle: 'via Claude Code',
    });
  });

  test('non-subscription connections render no copy', () => {
    expect(
      harnessSubscriptionCopy({
        connectionKind: 'anthropic_api_key',
        harnessLabel: 'Claude Code',
      }),
    ).toBeNull();
    expect(
      harnessSubscriptionCopy({ connectionKind: null, harnessLabel: 'Claude Code' }),
    ).toBeNull();
  });
});

describe('connectionContextLine', () => {
  test('renders plain-words connection context per kind', () => {
    expect(connectionContextLine({ connectionKind: 'managed_gateway' })).toBe('via Kortix (included)');
    expect(connectionContextLine({ connectionKind: 'anthropic_api_key' })).toBe('via your Anthropic key');
    expect(connectionContextLine({ connectionKind: 'openai_api_key' })).toBe('via your OpenAI key');
    expect(
      connectionContextLine({ connectionKind: 'openai_compatible', connectionLabel: 'Local vLLM' }),
    ).toBe('via Local vLLM');
    expect(connectionContextLine({ connectionKind: 'openai_compatible' })).toBe('via your custom endpoint');
  });

  test('omits the header for subscriptions (the note already says "via …") and unresolved connections', () => {
    expect(connectionContextLine({ connectionKind: 'claude_subscription' })).toBeNull();
    expect(connectionContextLine({ connectionKind: 'codex_subscription' })).toBeNull();
    expect(connectionContextLine({ connectionKind: null })).toBeNull();
    expect(connectionContextLine({ connectionKind: 'native_config' })).toBeNull();
  });
});

describe('connectionGroupLabel', () => {
  test('groups models under human connection labels, never raw ids', () => {
    expect(connectionGroupLabel({ connectionKind: 'managed_gateway' })).toBe('Kortix — included');
    expect(connectionGroupLabel({ connectionKind: 'anthropic_api_key' })).toBe('Your Anthropic key');
    expect(connectionGroupLabel({ connectionKind: 'openai_api_key' })).toBe('Your OpenAI key');
    expect(
      connectionGroupLabel({ connectionKind: 'anthropic_compatible', connectionLabel: 'Local proxy' }),
    ).toBe('Local proxy');
    expect(connectionGroupLabel({ connectionKind: 'anthropic_compatible' })).toBe('Custom endpoint');
  });
});

describe('defaultOptionCopy', () => {
  test('managed gateway pins "Automatic — Kortix picks the best model"', () => {
    expect(defaultOptionCopy({ connectionKind: 'managed_gateway', harnessLabel: 'OpenCode' })).toEqual({
      label: 'Automatic',
      subtitle: 'Kortix picks the best model',
    });
  });

  test('every other connection pins "Harness default — <Harness> decides"', () => {
    expect(defaultOptionCopy({ connectionKind: 'claude_subscription', harnessLabel: 'Claude Code' })).toEqual({
      label: 'Harness default',
      subtitle: 'Claude Code decides',
    });
    expect(defaultOptionCopy({ connectionKind: null, harnessLabel: 'Pi' })).toEqual({
      label: 'Harness default',
      subtitle: 'Pi decides',
    });
  });
});

describe('shouldShowModelSearch', () => {
  test('only once the usable list exceeds ~8 entries', () => {
    expect(shouldShowModelSearch(0)).toBe(false);
    expect(shouldShowModelSearch(8)).toBe(false);
    expect(shouldShowModelSearch(9)).toBe(true);
  });
});

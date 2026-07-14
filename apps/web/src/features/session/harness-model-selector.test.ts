import { describe, expect, test } from 'bun:test';

import { harnessSubscriptionCopy } from './harness-model-selector';

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

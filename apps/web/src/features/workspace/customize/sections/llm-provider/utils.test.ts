import { describe, expect, test } from 'bun:test';

import {
  buildClaudeSubscriptionProvider,
  buildCustomRestProvider,
  providerCredentialSummary,
} from './utils';

describe('LLM provider auth presentation', () => {
  test('does not invent a Claude subscription without its project secret', () => {
    expect(buildClaudeSubscriptionProvider(new Set())).toBeNull();
  });

  test('presents a stored Claude setup token as subscription auth', () => {
    const provider = buildClaudeSubscriptionProvider(new Set(['CLAUDE_CODE_OAUTH_TOKEN']));
    expect(provider).toMatchObject({
      id: 'claude-subscription',
      label: 'Claude subscription',
      envVars: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
    expect(providerCredentialSummary(provider!)).toBe('Claude subscription');
  });

  test('requires protocol and base URL before presenting custom REST auth', () => {
    expect(buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL']))).toBeNull();
    expect(
      buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL'])),
    ).toMatchObject({ id: 'custom-rest', label: 'Custom REST provider' });
  });
});

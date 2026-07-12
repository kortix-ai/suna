import { describe, expect, test } from 'bun:test';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';

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
    expect(provider!.models.map((model) => model.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5',
    ]);
    expect(providerCredentialSummary(provider!)).toBe('Claude subscription');
  });

  test('keeps Claude subscription and Anthropic API key as separate catalog providers', () => {
    expect(LLM_PROVIDER_BY_ID.get('claude-subscription')?.envVars).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(LLM_PROVIDER_BY_ID.get('anthropic')?.envVars).toContain('ANTHROPIC_API_KEY');
  });

  test('requires protocol and base URL before presenting custom REST auth', () => {
    expect(buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL']))).toBeNull();
    expect(
      buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL'])),
    ).toMatchObject({ id: 'custom-rest', label: 'Custom REST provider' });
  });
});

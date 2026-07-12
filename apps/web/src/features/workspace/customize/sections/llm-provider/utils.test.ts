import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import { describe, expect, test } from 'bun:test';

import {
  buildClaudeSubscriptionProvider,
  buildCustomRestProvider,
  providerCredentialSummary,
  providerModelsSummary,
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
    expect(provider!.models).toEqual([]);
    expect(providerModelsSummary(provider!)).toBe('Harness-managed models');
    expect(providerCredentialSummary(provider!)).toBe('Claude subscription');
  });

  test('keeps Claude subscription and Anthropic API key as separate catalog providers', () => {
    expect(LLM_PROVIDER_BY_ID.get('claude-subscription')?.envVars).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(LLM_PROVIDER_BY_ID.get('anthropic')?.envVars).toContain('ANTHROPIC_API_KEY');
  });

  test('keeps ChatGPT subscription and OpenAI API key as separate catalog providers', () => {
    expect(LLM_PROVIDER_BY_ID.get('codex')?.envVars).toContain('CODEX_AUTH_JSON');
    expect(LLM_PROVIDER_BY_ID.get('codex')?.modelsDynamic).toBe(true);
    expect(LLM_PROVIDER_BY_ID.get('openai')?.envVars).toContain('OPENAI_API_KEY');
  });

  test('requires protocol and base URL before presenting custom REST auth', () => {
    expect(buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL']))).toBeNull();
    expect(
      buildCustomRestProvider(new Set(['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL'])),
    ).toMatchObject({ id: 'custom-rest', label: 'Custom REST provider' });
  });
});

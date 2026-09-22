import { describe, expect, test } from 'bun:test';

import { keysToClear } from './sign-out-keys';

describe('keysToClear', () => {
  test('keeps theme, language and onboarding preferences', () => {
    expect(
      keysToClear(['@theme_preference', '@kortix_language', '@onboarding_completed_user1'])
    ).toEqual([]);
  });

  test('clears user data stored without an @ prefix', () => {
    const userData = [
      'kortix_message_queue_v1',
      'kortix-tab-state',
      'kortix.currentAccount',
      'kortix.lastProject',
      'selected-project-v1',
      'opencode-local-config',
      'presence_session_id',
      'kortix:ssh-access-meta:v1',
      'tab-screenshots',
    ];
    expect(keysToClear(userData)).toEqual(userData);
  });

  test('clears @-prefixed app data and Supabase session keys', () => {
    const keys = [
      '@selected_agent_id',
      '@selected_model_id',
      '@advanced_features_enabled',
      '@kortix_auth_callback_state',
      '@kortix_web_registration_handoff',
      'sb-abcd-auth-token',
      'sb-abcd-auth-token-code-verifier',
    ];
    expect(keysToClear(keys)).toEqual(keys);
  });

  test('matches preference keys exactly, not by substring', () => {
    expect(keysToClear(['@theme_preference_backup', 'kortix_language_cache'])).toEqual([
      '@theme_preference_backup',
      'kortix_language_cache',
    ]);
  });

  test('keeps the input order and returns an empty list for no keys', () => {
    expect(keysToClear(['b', '@theme_preference', 'a'])).toEqual(['b', 'a']);
    expect(keysToClear([])).toEqual([]);
  });
});

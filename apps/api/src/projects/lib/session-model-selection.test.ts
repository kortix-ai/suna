import { describe, expect, test } from 'bun:test';
import { requiresExplicitModelSelection } from './session-model-selection';

describe('requiresExplicitModelSelection', () => {
  test('requires a selection only for interactive Supabase catalog sessions', () => {
    expect(
      requiresExplicitModelSelection({
        authType: 'supabase',
        source: 'ui',
        ownsDefaultModel: false,
        hasExplicitSelection: false,
      }),
    ).toBe(true);
  });

  test('keeps defaults for marketplace and automation sessions', () => {
    for (const source of ['marketplace-install', 'trigger:cron', 'system:sandbox-build-fix']) {
      expect(
        requiresExplicitModelSelection({
          authType: 'supabase',
          source,
          ownsDefaultModel: false,
          hasExplicitSelection: false,
        }),
      ).toBe(false);
    }
  });

  test('keeps defaults for programmatic credentials', () => {
    for (const authType of ['pat', 'service_account', 'apiKey']) {
      expect(
        requiresExplicitModelSelection({
          authType,
          source: 'ui',
          ownsDefaultModel: false,
          hasExplicitSelection: false,
        }),
      ).toBe(false);
    }
  });

  test('accepts harness defaults and explicit catalog selections', () => {
    expect(
      requiresExplicitModelSelection({
        authType: 'supabase',
        source: 'ui',
        ownsDefaultModel: true,
        hasExplicitSelection: false,
      }),
    ).toBe(false);
    expect(
      requiresExplicitModelSelection({
        authType: 'supabase',
        source: 'ui',
        ownsDefaultModel: false,
        hasExplicitSelection: true,
      }),
    ).toBe(false);
  });
});

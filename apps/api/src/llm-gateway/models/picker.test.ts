import { describe, expect, test } from 'bun:test';
import { CATALOG, MANAGED_MODELS } from '@kortix/shared/llm-catalog';
import {
  connectedByokPickerModels,
  flagshipRefForEnvVar,
  labelForModelRef,
  managedPickerModels,
  providerFlagship,
} from './picker-catalog';

const catalogHas = (providerId: string, modelId: string): boolean =>
  CATALOG.providers.some((p) => p.id === providerId && p.models.some((m) => m.id === modelId));

describe('providerFlagship', () => {
  test('returns a model id that ACTUALLY exists in the catalog (no lies)', () => {
    for (const providerId of ['anthropic', 'openai', 'google']) {
      const flagship = providerFlagship(providerId);
      expect(flagship).toBeTruthy();
      expect(catalogHas(providerId, flagship!)).toBe(true);
    }
  });

  test('returns null for an unknown provider', () => {
    expect(providerFlagship('totally-not-a-provider')).toBeNull();
  });
});

describe('labelForModelRef', () => {
  test('managed ref (kortix/<id>) → the managed display name', () => {
    const sonnet = MANAGED_MODELS.find((m) => m.id === 'claude-sonnet-4.6');
    expect(labelForModelRef('kortix/claude-sonnet-4.6')).toBe(sonnet!.name);
    // bare managed id resolves too
    expect(labelForModelRef('claude-sonnet-4.6')).toBe(sonnet!.name);
  });

  test('an unknown ref falls back to the raw id (never throws)', () => {
    expect(labelForModelRef('madeup/model-x')).toBe('madeup/model-x');
  });
});

describe('managedPickerModels', () => {
  test('every managed model is offered as a kortix/<id> opencode ref', () => {
    const models = managedPickerModels();
    expect(models.length).toBe(MANAGED_MODELS.length);
    for (const m of models) {
      expect(m.id.startsWith('kortix/')).toBe(true);
      expect(m.managed).toBe(true);
      expect(m.provider).toBe('kortix');
    }
  });
});

describe('connectedByokPickerModels', () => {
  test('includes a connected provider flagship, real and provider-prefixed', () => {
    const models = connectedByokPickerModels(new Set(['ANTHROPIC_API_KEY']));
    const anthropic = models.find((m) => m.provider === 'anthropic');
    expect(anthropic).toBeTruthy();
    expect(anthropic!.id.startsWith('anthropic/')).toBe(true);
    expect(anthropic!.managed).toBe(false);
    expect(catalogHas('anthropic', anthropic!.id.slice('anthropic/'.length))).toBe(true);
  });

  test('no connected providers → no BYOK entries', () => {
    expect(connectedByokPickerModels(new Set())).toEqual([]);
  });
});

describe('flagshipRefForEnvVar (auto-seed mapping)', () => {
  test('maps a provider credential env var to that provider flagship ref', () => {
    const ref = flagshipRefForEnvVar('ANTHROPIC_API_KEY');
    expect(ref).toBeTruthy();
    expect(ref!.startsWith('anthropic/')).toBe(true);
    expect(catalogHas('anthropic', ref!.slice('anthropic/'.length))).toBe(true);
  });

  test('non-provider credentials (codex/opencode auth) map to null → skipped', () => {
    expect(flagshipRefForEnvVar('CODEX_AUTH_JSON')).toBeNull();
    expect(flagshipRefForEnvVar('OPENCODE_AUTH_JSON')).toBeNull();
    expect(flagshipRefForEnvVar('SOME_RANDOM_SECRET')).toBeNull();
  });
});

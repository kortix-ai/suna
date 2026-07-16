import { describe, expect, test } from 'bun:test';
import { CATALOG } from '@kortix/llm-catalog';
import { RUNTIME_MANAGED_MODELS } from './managed-models';
import {
  connectedByokPickerModels,
  flagshipRefForEnvVar,
  labelForModelRef,
  managedPickerModels,
  projectPickerCatalog,
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
    const sonnet = RUNTIME_MANAGED_MODELS.find((m) => m.id === 'claude-sonnet-4.6');
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
    expect(models.length).toBe(RUNTIME_MANAGED_MODELS.length);
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

describe('projectPickerCatalog', () => {
  test('keeps managed and connected-provider models without returning the full runtime catalog', () => {
    const full = {
      auto: { name: 'Auto' },
      'glm-5.2': { name: 'GLM 5.2' },
      'anthropic/claude-a': { name: 'Claude A' },
      'anthropic/claude-b': { name: 'Claude B' },
      'openai/gpt-a': { name: 'GPT A' },
      'codex/gpt-5.6-sol': { name: 'GPT-5.6 Sol' },
    };

    expect(
      projectPickerCatalog(full, new Set(['ANTHROPIC_API_KEY', 'CODEX_AUTH_JSON']), [
        'openai/gpt-a',
      ]),
    ).toEqual({
      auto: full.auto,
      'glm-5.2': full['glm-5.2'],
      'anthropic/claude-a': full['anthropic/claude-a'],
      'anthropic/claude-b': full['anthropic/claude-b'],
      'openai/gpt-a': full['openai/gpt-a'],
      'codex/gpt-5.6-sol': full['codex/gpt-5.6-sol'],
    });
  });

  test('does not expose disconnected provider catalogs', () => {
    const full = {
      auto: { name: 'Auto' },
      'anthropic/claude-a': { name: 'Claude A' },
      'openai/gpt-a': { name: 'GPT A' },
      'codex/gpt-5.6-sol': { name: 'GPT-5.6 Sol' },
    };

    expect(Object.keys(projectPickerCatalog(full, new Set(), []))).toEqual(['auto']);
  });
});

import { describe, expect, test } from 'bun:test';

import {
  capModelList,
  defaultOptionCopy,
  filterHarnessPresets,
  harnessSubscriptionCopy,
  isSubscriptionConnection,
  pickerGroupId,
  presetProviderTag,
  shouldShowModelSearch,
} from './model-selector-helpers';
import type { FlatModel } from './session-chat-input';

function model(overrides: Partial<FlatModel>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'claude-sonnet-4-6',
    modelName: 'Claude Sonnet 4.6',
    ...overrides,
  };
}

describe('pickerGroupId', () => {
  test('non-gateway models group under their own provider id', () => {
    expect(pickerGroupId(model({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }))).toBe(
      'anthropic',
    );
  });

  test('managed default ids stay grouped under kortix even though the id has no slash', () => {
    expect(pickerGroupId(model({ providerID: 'kortix', modelID: 'auto' }))).toBe('kortix');
  });

  test('namespaced gateway BYOK ids split into their real provider group', () => {
    expect(
      pickerGroupId(model({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' })),
    ).toBe('anthropic');
  });

  test('prefers the explicit `provider` field over string-splitting the wire id', () => {
    expect(
      pickerGroupId(
        model({
          providerID: 'kortix',
          modelID: 'anthropic/claude-opus-4-8',
          provider: 'anthropic',
        }),
      ),
    ).toBe('anthropic');
  });

  test('a kortix model id with no namespace and no managed match falls back to kortix', () => {
    expect(pickerGroupId(model({ providerID: 'kortix', modelID: 'glm-5.2' }))).toBe('kortix');
  });
});

// ─── capModelList — the catalog (grouped) picker's render cap ───────────────
// Regression coverage for the "gigantic lag on open" bug: the composer's
// managed_gateway preset list can be the ENTIRE gateway catalog (~4900
// entries, measured live), unconditioned on connected credentials. Mounting
// one CommandItem per model froze the popover open path. capModelList bounds
// how many rows actually mount, same contract as filterHarnessPresets.
describe('capModelList', () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    model({ providerID: 'anthropic', modelID: `model-${i}`, modelName: `Model ${i}` }),
  );

  test('renders the whole list when it fits under the cap', () => {
    const result = capModelList(many.slice(0, 10), null, 50);
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
  });

  test('caps a huge list and reports how many stayed hidden', () => {
    const result = capModelList(many, null, 50);
    expect(result.visible).toHaveLength(50);
    expect(result.hiddenCount).toBe(150);
  });

  test('the selected model is always visible, even when the cap would hide it', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-199' };
    const result = capModelList(many, selected, 50);
    expect(result.visible).toHaveLength(51);
    expect(
      result.visible.some((m) => m.providerID === 'anthropic' && m.modelID === 'model-199'),
    ).toBe(true);
    expect(result.hiddenCount).toBe(149);
  });

  test('a selected model already within the cap is not duplicated', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-0' };
    const result = capModelList(many, selected, 50);
    expect(result.visible).toHaveLength(50);
  });
});

// ─── Harness-native (Claude/Codex/Pi) selection helpers ─────────────────────
// Ported from the former harness-model-selector-helpers.test.ts when
// HarnessModelSelector was folded into ModelSelector.

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

describe('presetProviderTag', () => {
  test('gateway-style ids surface their provider prefix', () => {
    expect(presetProviderTag({ id: 'anthropic/claude-sonnet-5' })).toBe('anthropic');
    expect(presetProviderTag({ id: 'deepinfra/llama-3.1-70b' })).toBe('deepinfra');
  });

  test('the synthetic kortix/ namespace never tags as "kortix" — the REAL provider shows instead', () => {
    expect(presetProviderTag({ id: 'kortix/anthropic/claude-sonnet-5' })).toBe('anthropic');
    expect(presetProviderTag({ id: 'kortix/openai/gpt-5.4' })).toBe('openai');
    expect(presetProviderTag({ id: 'kortix/managed-model' })).toBeNull();
  });

  test('bare harness-native ids get no tag', () => {
    expect(presetProviderTag({ id: 'claude-sonnet-4-6' })).toBeNull();
    expect(presetProviderTag({ id: '/leading-slash' })).toBeNull();
  });
});

describe('filterHarnessPresets — synthetic Auto exclusion', () => {
  test("the gateway catalog's synthetic Auto entries never render — the pinned Auto row already IS that option", () => {
    const result = filterHarnessPresets({
      presets: [
        { id: 'kortix/auto', name: 'Auto', source: 'kortix-gateway' },
        { id: 'auto', name: 'Auto', source: 'kortix-gateway' },
        {
          id: 'kortix/anthropic/claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'kortix-gateway',
        },
      ],
      query: '',
      selectedModel: null,
      cap: 50,
    });
    expect(result.visible.map((p) => p.id)).toEqual(['kortix/anthropic/claude-sonnet-5']);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('defaultOptionCopy', () => {
  test('the default row always reads "Auto"; the gateway explanation credits Kortix', () => {
    expect(
      defaultOptionCopy({ connectionKind: 'managed_gateway', harnessLabel: 'OpenCode' }),
    ).toEqual({
      label: 'Auto',
      subtitle: 'Kortix picks the best model for you.',
    });
  });

  test('every other connection explains that the harness decides', () => {
    expect(
      defaultOptionCopy({ connectionKind: 'claude_subscription', harnessLabel: 'Claude Code' }),
    ).toEqual({
      label: 'Auto',
      subtitle: 'Claude Code decides which model to run.',
    });
    expect(defaultOptionCopy({ connectionKind: null, harnessLabel: 'Pi' })).toEqual({
      label: 'Auto',
      subtitle: 'Pi decides which model to run.',
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

describe('filterHarnessPresets', () => {
  const preset = (id: string, name = id) => ({ id, name, source: 'models.dev' });
  const many = Array.from({ length: 200 }, (_, i) => preset(`prov/model-${i}`, `Model ${i}`));

  test('renders the whole list when it fits under the cap', () => {
    const result = filterHarnessPresets({
      presets: many.slice(0, 10),
      query: '',
      selectedModel: null,
      cap: 50,
    });
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
  });

  test('caps a huge list and reports how many rows stayed hidden', () => {
    const result = filterHarnessPresets({ presets: many, query: '', selectedModel: null, cap: 50 });
    expect(result.visible).toHaveLength(50);
    expect(result.hiddenCount).toBe(150);
  });

  test('search filters the FULL list, not just the visible slice', () => {
    const result = filterHarnessPresets({
      presets: many,
      query: 'model 199',
      selectedModel: null,
      cap: 50,
    });
    expect(result.visible.map((p) => p.id)).toEqual(['prov/model-199']);
    expect(result.hiddenCount).toBe(0);
  });

  test('matches on id as well as name, case-insensitive', () => {
    const result = filterHarnessPresets({
      presets: many,
      query: 'PROV/MODEL-42',
      selectedModel: null,
      cap: 50,
    });
    expect(result.visible.map((p) => p.id)).toEqual(['prov/model-42']);
  });

  test('the selected model is always visible, even when the cap would hide it', () => {
    const result = filterHarnessPresets({
      presets: many,
      query: '',
      selectedModel: 'prov/model-199',
      cap: 50,
    });
    expect(result.visible).toHaveLength(51);
    expect(result.visible.some((p) => p.id === 'prov/model-199')).toBe(true);
    expect(result.hiddenCount).toBe(149);
  });
});

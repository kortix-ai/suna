import type { ModelPickerGroup } from '@kortix/sdk/react';
import { describe, expect, test } from 'bun:test';
import {
  boundSessionAgentName,
  buildComposerOptions,
  resolveUnifiedModelPickSelection,
} from './composer-chat-input';

describe('harness-aware composer options', () => {
  test('locks an existing session to its persisted logical agent', () => {
    expect(boundSessionAgentName('  claude  ')).toBe('claude');
    expect(boundSessionAgentName(null)).toBeNull();
  });

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} sends the agent without a stale gateway model override`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
        }),
      ).toEqual({ agent: harness });
    });
  }

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} carries an explicit harness-native model without a gateway model key`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'stale/model' },
          runtimeModel: ' native/model ',
        }),
      ).toEqual({
        agent: harness,
        runtimeModel: 'native/model',
        modelSelection: {
          kind: 'custom',
          modelId: 'native/model',
          connectionId: null,
        },
      });
    });
  }

  test('OpenCode retains the selected catalog model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      }),
    ).toEqual({
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      modelSelection: {
        kind: 'custom',
        modelId: 'kortix/openai/gpt-5.4',
        connectionId: null,
      },
    });
  });

  test('OpenCode ignores a stale harness-native model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        runtimeModel: 'native/model',
      }),
    ).toEqual({ agent: 'kortix' });
  });
});

describe('resolveUnifiedModelPickSelection — unified ModelPicker pre-session persistence seam', () => {
  const HARNESS_GROUPS: ModelPickerGroup[] = [
    {
      id: 'claude',
      label: 'Claude',
      connectAction: null,
      items: [
        {
          key: 'auto',
          kind: 'auto',
          label: 'Default',
          sublabel: 'Claude chooses',
          providerId: null,
          experimental: false,
          liveSwap: false,
          selectable: true,
        },
        {
          key: 'claude:claude-sonnet-4-6',
          kind: 'model',
          label: 'Sonnet 4.6',
          sublabel: null,
          providerId: 'claude',
          experimental: false,
          liveSwap: false,
          selectable: true,
        },
      ],
    },
  ];

  const CATALOG_GROUPS: ModelPickerGroup[] = [
    {
      id: 'default',
      label: 'Default',
      connectAction: null,
      items: [
        {
          key: 'auto',
          kind: 'auto',
          label: 'Default',
          sublabel: 'OpenCode chooses',
          providerId: null,
          experimental: false,
          liveSwap: false,
          selectable: true,
        },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      connectAction: null,
      items: [
        {
          key: 'anthropic:claude-sonnet-4-6',
          kind: 'model',
          label: 'Claude Sonnet 4.6',
          sublabel: null,
          providerId: 'anthropic',
          experimental: false,
          liveSwap: false,
          selectable: true,
        },
      ],
    },
  ];

  test('auto → harness resolution clears the per-agent runtime model', () => {
    expect(
      resolveUnifiedModelPickSelection('auto', {
        catalogModelRequired: false,
        groups: HARNESS_GROUPS,
      }),
    ).toEqual({ kind: 'harness', modelId: undefined });
  });

  test('auto → catalog resolution clears the gateway ModelKey', () => {
    expect(
      resolveUnifiedModelPickSelection('auto', {
        catalogModelRequired: true,
        groups: CATALOG_GROUPS,
      }),
    ).toEqual({ kind: 'catalog', model: undefined });
  });

  test('a harness preset key persists its bare model id via the runtime-model seam', () => {
    expect(
      resolveUnifiedModelPickSelection('claude:claude-sonnet-4-6', {
        catalogModelRequired: false,
        groups: HARNESS_GROUPS,
      }),
    ).toEqual({ kind: 'harness', modelId: 'claude-sonnet-4-6' });
  });

  test('a catalog preset key persists a full ModelKey via the local.model seam — never a blind colon-split', () => {
    expect(
      resolveUnifiedModelPickSelection('anthropic:claude-sonnet-4-6', {
        catalogModelRequired: true,
        groups: CATALOG_GROUPS,
      }),
    ).toEqual({
      kind: 'catalog',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
    });
  });

  test('a custom harness-native id persists as the bare typed string', () => {
    expect(
      resolveUnifiedModelPickSelection('custom:claude-sonnet-4-6-thinking', {
        catalogModelRequired: false,
        groups: HARNESS_GROUPS,
      }),
    ).toEqual({ kind: 'harness', modelId: 'claude-sonnet-4-6-thinking' });
  });

  test('a custom catalog id in provider/model shape persists as a ModelKey', () => {
    expect(
      resolveUnifiedModelPickSelection('custom:openrouter/gpt-5.4', {
        catalogModelRequired: true,
        groups: CATALOG_GROUPS,
      }),
    ).toEqual({
      kind: 'catalog',
      model: { providerID: 'openrouter', modelID: 'gpt-5.4' },
    });
  });

  test('a custom catalog id with no provider/model shape is a no-op, not a crash', () => {
    expect(
      resolveUnifiedModelPickSelection('custom:not-a-provider-model-id', {
        catalogModelRequired: true,
        groups: CATALOG_GROUPS,
      }),
    ).toEqual({ kind: 'noop' });
  });

  test('an unknown key (e.g. a disconnected-provider row) is a no-op', () => {
    expect(
      resolveUnifiedModelPickSelection('connect:codex_subscription', {
        catalogModelRequired: false,
        groups: HARNESS_GROUPS,
      }),
    ).toEqual({ kind: 'noop' });
  });
});

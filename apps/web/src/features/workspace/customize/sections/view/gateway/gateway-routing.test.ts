import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectPreviewTargets,
  editablePolicySignature,
  fallbackModeForPolicy,
  moveFallback,
  validateRoutingDraft,
} from './gateway-routing';

const routingSource = readFileSync(join(import.meta.dir, 'gateway-routing.tsx'), 'utf8');
const gatewayViewSource = readFileSync(join(import.meta.dir, '../../gateway-view.tsx'), 'utf8');
const manageConnectionModalSource = readFileSync(
  join(import.meta.dir, '../../llm-provider/manage-connection-modal.tsx'),
  'utf8',
);
const modelDefaultsSource = readFileSync(
  join(import.meta.dir, '../../../../../../hooks/runtime/use-model-defaults.ts'),
  'utf8',
);

describe('gateway routing editor helpers', () => {
  test('reorders a finite fallback chain without mutating the input', () => {
    const source = ['primary-a', 'fallback-b', 'fallback-c'];
    expect(moveFallback(source, 2, -1)).toEqual(['primary-a', 'fallback-c', 'fallback-b']);
    expect(source).toEqual(['primary-a', 'fallback-b', 'fallback-c']);
    expect(moveFallback(source, 0, -1)).toEqual(source);
  });

  test('rejects duplicate models, self fallback, and missing override primaries', () => {
    expect(
      validateRoutingDraft({
        defaultModel: 'model-a',
        defaultFallback: { models: ['model-b', 'model-b'], fallbackOn: 'any-error' },
        rules: [],
      }),
    ).toContain('only appear once');
    expect(
      validateRoutingDraft({
        defaultModel: 'model-a',
        defaultFallback: { models: ['model-a'], fallbackOn: 'any-error' },
        rules: [],
      }),
    ).toContain('cannot include the primary');
    expect(
      validateRoutingDraft({
        defaultModel: null,
        defaultFallback: null,
        rules: [{ model: '', fallbackModels: [], fallbackOn: 'transient' }],
      }),
    ).toContain('primary model');
  });

  test('accepts inherited policy and bounded ordered rules', () => {
    expect(
      validateRoutingDraft({
        defaultModel: null,
        defaultFallback: null,
        rules: [
          {
            model: 'anthropic/claude-opus',
            fallbackModels: ['anthropic/claude-sonnet', 'glm-5.2'],
            fallbackOn: 'transient',
          },
        ],
      }),
    ).toBeNull();
  });

  test('keeps custom and disabled fallback modes distinct', () => {
    expect(fallbackModeForPolicy(null)).toBe('inherit');
    expect(fallbackModeForPolicy({ models: [], fallbackOn: 'transient' })).toBe('disabled');
    expect(fallbackModeForPolicy({ models: ['glm-5.2'], fallbackOn: 'any-error' })).toBe('custom');
    expect(
      validateRoutingDraft(
        {
          defaultModel: 'codex/gpt-5.6-sol',
          defaultFallback: { models: [], fallbackOn: 'any-error' },
          rules: [],
        },
        'custom',
      ),
    ).toContain('at least one');
  });

  test('uses the shared model selector', () => {
    expect(routingSource).toContain("from '@/features/session/model-selector'");
    expect(routingSource).toContain('<ModelSelector');
  });

  test('renders an editable vision model override saved through the same routing policy', () => {
    expect(routingSource).toContain('Vision model');
    expect(routingSource).toContain('draft.visionModel');
    expect(routingSource).toContain('unsetLabel="Inherit platform"');
    expect(routingSource).toContain(
      'onChange={(visionModel) => setDraft({ ...draft, visionModel })}',
    );
    // Included in the dirty-check so an edit here enables Save, and shipped
    // in the same `routing.set.mutate({ ...draft, ... })` payload as the
    // fallback chain and rules.
    expect(routingSource).toContain('visionModel: policy.visionModel');
  });

  test('debounces a routing-policy/preview availability check and surfaces per-entry feedback', () => {
    expect(routingSource).toContain('routing.preview.mutateAsync');
    expect(routingSource).toContain('setTimeout');
    expect(routingSource).toContain('AvailabilityBadge');
    expect(routingSource).toContain('Not connected');
  });

  test('collects a deduped preview target list across the primary, vision override, default chain, and rule chains', () => {
    expect(
      collectPreviewTargets(
        {
          visionModel: 'anthropic/claude-sonnet-4.6',
          defaultFallback: { models: ['glm-5.2', 'auto'], fallbackOn: 'transient' },
          rules: [
            { model: 'codex/gpt-5.6-sol', fallbackModels: ['glm-5.2'], fallbackOn: 'transient' },
          ],
        },
        'anthropic/claude-opus-4.8',
      ),
    ).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-4.6',
      'glm-5.2',
      'codex/gpt-5.6-sol',
    ]);
  });

  test('preview targets skip null/auto entries and dedupe repeats', () => {
    expect(
      collectPreviewTargets({ visionModel: null, defaultFallback: null, rules: [] }, null),
    ).toEqual([]);
    expect(
      collectPreviewTargets(
        {
          visionModel: 'glm-5.2',
          defaultFallback: { models: ['glm-5.2'], fallbackOn: 'transient' },
          rules: [],
        },
        'glm-5.2',
      ),
    ).toEqual(['glm-5.2']);
  });

  test('the "Default model" section reads and writes the project default scope', () => {
    expect(manageConnectionModalSource).toContain('modelDefaults.projectDefault');
    expect(manageConnectionModalSource).toContain('.setProjectDefault(m)');
    expect(manageConnectionModalSource).toContain('useProjectModels(projectId)');
    expect(manageConnectionModalSource).not.toContain('useOpenCodeProviders');
    expect(manageConnectionModalSource).not.toContain('modelDefaults.setAccountDefault');
    expect(manageConnectionModalSource).toContain('modelDefaults.isUpdating');
    expect(manageConnectionModalSource).toContain(
      "errorToast('Could not update the project default')",
    );
    expect(gatewayViewSource).not.toContain('.setProjectDefault(m)');
  });

  test('default changes refresh routing and the shared compact picker cache', () => {
    expect(modelDefaultsSource).toContain("['gateway-routing-policy', projectId]");
    expect(modelDefaultsSource).toContain("['project-model-picker', projectId]");
  });

  test('an effective-default refetch does not overwrite an unsaved routing draft', () => {
    const policy = {
      defaultModel: 'codex/gpt-5.6-sol',
      visionModel: null,
      defaultFallback: { models: ['glm-5.2'], fallbackOn: 'transient' as const },
      rules: [],
    };
    expect(editablePolicySignature({ ...policy, defaultModel: 'anthropic/claude-opus-4.8' })).toBe(
      editablePolicySignature(policy),
    );
    expect(
      editablePolicySignature({
        ...policy,
        defaultFallback: { models: [], fallbackOn: 'transient' },
      }),
    ).not.toBe(editablePolicySignature(policy));
  });

  test('routing cannot race a pending project-default write', () => {
    // `gateway-view.tsx` no longer mounts its own `useModelDefaults` instance
    // (Task 17 fix-wave finding: `useMutation().isPending` is per-instance, so
    // a second hook instance here would never see the Models tab's mutation).
    // It instead reads the shared `modelDefaultsKey` mutation key via
    // `useIsMutating`, which observes any in-flight write regardless of which
    // component's hook instance issued it.
    expect(gatewayViewSource).not.toMatch(/import\s*\{[^}]*\buseModelDefaults\b/);
    expect(gatewayViewSource).toContain('modelDefaultsKey');
    expect(gatewayViewSource).toContain(
      'useIsMutating({ mutationKey: modelDefaultsKey(projectId) })',
    );
    expect(gatewayViewSource).toContain('projectDefaultPending={projectDefaultPending}');
    expect(routingSource).toContain('projectDefaultPending: boolean');
    expect(routingSource).toContain('projectDefaultPending ||');
    expect(manageConnectionModalSource).toContain('useIsMutating');
    expect(manageConnectionModalSource).toContain('gatewayRoutingPolicyKey(projectId)');
    // The set/clear mutations carry an explicit shared mutationKey so a
    // non-owning consumer (gateway-view) can observe them via useIsMutating.
    expect(modelDefaultsSource).toContain('modelDefaultsKey');
    expect(modelDefaultsSource).toContain('mutationKey: queryKey');
  });

  test('routing freezes edits in flight and refreshes the shared project default after save', () => {
    expect(routingSource).toContain('const controlsDisabled =');
    expect(routingSource).toContain('routing.set.isPending ||');
    expect(routingSource).toContain('routing.reset.isPending ||');
    expect(routingSource).toContain("queryKey: ['model-defaults', projectId]");
    expect(routingSource).toContain("queryKey: ['project-model-picker', projectId]");
  });

  test('renders a capability-gated generation-controls panel for the resolved primary model', () => {
    expect(routingSource).toContain("from './generation-controls'");
    expect(routingSource).toContain('<GenerationControlsPanel');
    expect(routingSource).toContain('draft.modelGenerationConfig?.[primaryModel]');
  });

  test('modelGenerationConfig is part of the dirty check and the hydration signature', () => {
    expect(routingSource).toContain('modelGenerationConfig: policy.modelGenerationConfig ?? {}');
    const policy = {
      defaultModel: 'codex/gpt-5.6-sol',
      visionModel: null,
      defaultFallback: null,
      rules: [],
      modelGenerationConfig: {},
    };
    expect(
      editablePolicySignature({
        ...policy,
        modelGenerationConfig: { 'codex/gpt-5.6-sol': { temperature: 0.5 } },
      }),
    ).not.toBe(editablePolicySignature(policy));
  });
});

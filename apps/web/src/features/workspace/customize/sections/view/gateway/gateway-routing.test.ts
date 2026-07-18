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
const modelDefaultsSource = readFileSync(
  join(import.meta.dir, '../../../../../../hooks/opencode/use-model-defaults.ts'),
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

  test('the header selector reads and writes the project default scope', () => {
    expect(gatewayViewSource).toContain('modelDefaults.projectDefault');
    expect(gatewayViewSource).toContain('.setProjectDefault(m)');
    expect(gatewayViewSource).toContain('useProjectModels(projectId)');
    expect(gatewayViewSource).not.toContain('useOpenCodeProviders');
    expect(gatewayViewSource).not.toContain('modelDefaults.setAccountDefault');
    expect(gatewayViewSource).toContain('modelDefaults.isUpdating');
    expect(gatewayViewSource).toContain("errorToast('Could not update the project default')");
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
    expect(gatewayViewSource).toContain('projectDefaultPending={modelDefaults.isUpdating}');
    expect(routingSource).toContain('projectDefaultPending: boolean');
    expect(routingSource).toContain('projectDefaultPending ||');
    expect(gatewayViewSource).toContain('useIsMutating');
    expect(gatewayViewSource).toContain('gatewayRoutingPolicyKey(projectId)');
  });

  test('routing freezes edits in flight and refreshes the shared project default after save', () => {
    expect(routingSource).toContain('const controlsDisabled =');
    expect(routingSource).toContain('routing.set.isPending ||');
    expect(routingSource).toContain('routing.reset.isPending ||');
    expect(routingSource).toContain("queryKey: ['model-defaults', projectId]");
    expect(routingSource).toContain("queryKey: ['project-model-picker', projectId]");
  });
});

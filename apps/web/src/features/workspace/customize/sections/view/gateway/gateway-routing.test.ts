import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectPreviewTargets,
  editablePolicySignature,
  fallbackModeForPolicy,
  hasAdvancedRoutingConfig,
  moveFallback,
  validateRoutingDraft,
} from './gateway-routing';

const routingSource = readFileSync(join(import.meta.dir, 'gateway-routing.tsx'), 'utf8');
const gatewayViewSource = readFileSync(join(import.meta.dir, '../../gateway-view.tsx'), 'utf8');
const modelDefaultsSource = readFileSync(
  join(
    import.meta.dir,
    '../../../../../../../../../packages/sdk/src/react/use-model-defaults.ts',
  ),
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
    expect(gatewayViewSource).not.toContain('useRuntimeProviders');
    expect(gatewayViewSource).not.toContain('modelDefaults.setAccountDefault');
    expect(gatewayViewSource).toContain('modelDefaults.isUpdating');
    expect(gatewayViewSource).toContain("errorToast('Could not update the project default')");
  });

  test('default changes refresh routing and the shared compact picker cache', () => {
    expect(modelDefaultsSource).toContain("['gateway-routing-policy', projectId]");
    // Was a standalone flat array literal, independently hand-typed from
    // `qk.project.modelPicker(id)` — the SAME entry `useProjectModels` reads
    // and `gateway-routing.tsx`'s own invalidation targets (see this file's
    // other assertion on `qk.project.modelPicker(projectId)` above). Fixed as
    // part of migrating `packages/sdk/src/react` onto `qk`.
    expect(modelDefaultsSource).toContain("qk.project.modelPicker(projectId ?? '')");
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
    expect(routingSource).toContain('queryKey: qk.project.modelPicker(projectId)');
  });

  test('renders a capability-gated generation-controls panel for the resolved primary model', () => {
    expect(routingSource).toContain(
      "from './generation-controls'",
    );
    expect(routingSource).toContain('<GenerationControlsPanel');
    expect(routingSource).toContain('draft.modelGenerationConfig?.[primaryModel]');
  });

  test('Per-model overrides is promoted ahead of Vision model and Generation defaults, both foreground-weighted', () => {
    const overridesIndex = routingSource.indexOf('Per-model overrides');
    const visionIndex = routingSource.indexOf('>Vision model<');
    const generationIndex = routingSource.indexOf('>Generation defaults<');
    expect(overridesIndex).toBeGreaterThan(-1);
    expect(visionIndex).toBeGreaterThan(-1);
    expect(generationIndex).toBeGreaterThan(-1);
    // Product feedback: overrides is "the core thing" and must not read as a
    // footnote below three other panels — it now renders before Vision model
    // and Generation defaults, not after them.
    expect(overridesIndex).toBeLessThan(visionIndex);
    expect(overridesIndex).toBeLessThan(generationIndex);
    // Fallback and Per-model overrides carry the full-strength heading; Vision
    // model and Generation defaults keep the muted default inside Advanced.
    expect(routingSource).toContain('<Label className="text-foreground">Fallback</Label>');
    expect(routingSource).toContain(
      '<Label className="text-foreground">Per-model overrides</Label>',
    );
  });

  test('Vision model and Generation defaults fold under a single Advanced disclosure', () => {
    const disclosureIndex = routingSource.indexOf('<Disclosure open={advancedOpen}');
    const visionIndex = routingSource.indexOf('>Vision model<');
    const generationIndex = routingSource.indexOf('>Generation defaults<');
    const disclosureCloseIndex = routingSource.indexOf('</Disclosure>');
    expect(disclosureIndex).toBeGreaterThan(-1);
    expect(disclosureIndex).toBeLessThan(visionIndex);
    expect(disclosureIndex).toBeLessThan(generationIndex);
    expect(disclosureCloseIndex).toBeGreaterThan(generationIndex);
  });

  test('the Advanced disclosure opens by default only when a vision override or a generation parameter is already set', () => {
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: {} })).toBe(false);
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: undefined })).toBe(
      false,
    );
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.2': {} },
      }),
    ).toBe(false);
    expect(
      hasAdvancedRoutingConfig({ visionModel: 'anthropic/claude-sonnet-4.6', modelGenerationConfig: {} }),
    ).toBe(true);
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.2': { temperature: 0.5 } },
      }),
    ).toBe(true);
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

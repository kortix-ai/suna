import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

import {
  collectPreviewTargets,
  editablePolicySignature,
  fallbackModeForPolicy,
  hasAdvancedRoutingConfig,
  moveFallback,
  validateRoutingDraft,
} from '@kortix/ui/customize/sections/view/gateway/gateway-routing';
import { uiSourcePath } from '@/test-utils/read-source';

const routingSource = readFileSync(uiSourcePath('customize/sections/view/gateway/gateway-routing.tsx'), 'utf8');
const gatewayViewSource = readFileSync(uiSourcePath('customize/sections/gateway-view.tsx'), 'utf8');
const modelDefaultsSource = readFileSync(
  join(import.meta.dir, '../../../../../../../../../packages/sdk/src/react/use-model-defaults.ts'),
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
            fallbackModels: ['anthropic/claude-sonnet', 'glm-5.3-flash'],
            fallbackOn: 'transient',
          },
        ],
      }),
    ).toBeNull();
  });

  test('keeps custom and disabled fallback modes distinct', () => {
    expect(fallbackModeForPolicy(null)).toBe('inherit');
    expect(fallbackModeForPolicy({ models: [], fallbackOn: 'transient' })).toBe('disabled');
    expect(fallbackModeForPolicy({ models: ['glm-5.3-flash'], fallbackOn: 'any-error' })).toBe(
      'custom',
    );
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

  test('collects a deduped preview target list across the primary, vision override, default chain, and rule chains', () => {
    expect(
      collectPreviewTargets(
        {
          visionModel: 'anthropic/claude-sonnet-4.6',
          defaultFallback: { models: ['glm-5.3-flash', 'auto'], fallbackOn: 'transient' },
          rules: [
            {
              model: 'codex/gpt-5.6-sol',
              fallbackModels: ['glm-5.3-flash'],
              fallbackOn: 'transient',
            },
          ],
        },
        'anthropic/claude-opus-4.8',
      ),
    ).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-4.6',
      'glm-5.3-flash',
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
          visionModel: 'glm-5.3-flash',
          defaultFallback: { models: ['glm-5.3-flash'], fallbackOn: 'transient' },
          rules: [],
        },
        'glm-5.3-flash',
      ),
    ).toEqual(['glm-5.3-flash']);
  });

  test('the header selector reads and writes the project default scope', () => {
    // The read goes through the SDK's one default chain (`resolveModelDefault`),
    // so the page cannot grow a second copy of the agent → project → account →
    // platform precedence.
    expect(gatewayViewSource).toContain('resolveModelDefault(modelDefaults.data');
    expect(gatewayViewSource).toContain('.setProjectDefault(m)');
    expect(gatewayViewSource).toContain('useProjectModels(projectId)');
    expect(gatewayViewSource).not.toContain('useRuntimeProviders');
    expect(gatewayViewSource).not.toContain('modelDefaults.setAccountDefault');
    expect(gatewayViewSource).toContain('modelDefaults.isUpdating');
    expect(gatewayViewSource).toContain("raw('text5ed9bd98de1b')");
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
      defaultFallback: { models: ['glm-5.3-flash'], fallbackOn: 'transient' as const },
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
    expect(routingSource).toContain("from './generation-controls'");
    expect(routingSource).toContain('<GenerationControlsPanel');
    expect(routingSource).toContain('draft.modelGenerationConfig?.[primaryModel]');
  });

  test('the Advanced disclosure opens by default only when a vision override or a generation parameter is already set', () => {
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: {} })).toBe(false);
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: undefined })).toBe(
      false,
    );
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.3-flash': {} },
      }),
    ).toBe(false);
    expect(
      hasAdvancedRoutingConfig({
        visionModel: 'anthropic/claude-sonnet-4.6',
        modelGenerationConfig: {},
      }),
    ).toBe(true);
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.3-flash': { temperature: 0.5 } },
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

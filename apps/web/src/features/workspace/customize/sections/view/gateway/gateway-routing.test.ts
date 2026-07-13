import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
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

  test('uses the shared model selector and removes vision and route-preview configuration', () => {
    expect(routingSource).toContain("from '@/features/session/model-selector'");
    expect(routingSource).toContain('<ModelSelector');
    expect(routingSource).not.toContain('Vision model');
    expect(routingSource).not.toContain('Route preview');
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
    expect(
      editablePolicySignature({ ...policy, defaultModel: 'anthropic/claude-opus-4.8' }),
    ).toBe(editablePolicySignature(policy));
    expect(
      editablePolicySignature({
        ...policy,
        defaultFallback: { models: [], fallbackOn: 'transient' },
      }),
    ).not.toBe(editablePolicySignature(policy));
  });

  test('routing cannot race a pending project-default write', () => {
    expect(modelDefaultsSource).toContain('isUpdating: boolean');
    expect(routingSource).toContain('modelDefaults.isUpdating');
    expect(gatewayViewSource).toContain('useIsMutating');
    expect(gatewayViewSource).toContain('gatewayRoutingPolicyKey(projectId)');
  });
});

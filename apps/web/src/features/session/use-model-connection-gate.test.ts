import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectProviderModalTab, resolveGateProjectId } from './use-model-connection-gate';

const gateSource = readFileSync(join(import.meta.dir, 'use-model-connection-gate.tsx'), 'utf8');
const selectorSource = readFileSync(join(import.meta.dir, 'model-selector.tsx'), 'utf8');
// `composer/composer.tsx`, not `session-chat-input.tsx`. The latter is a
// re-export barrel now — the implementation (and this hook call with it) moved
// into the composer during the ProseMirror rebuild. A source-assertion test
// that keeps reading the barrel does not fail loudly on that move by itself;
// it just stops being able to find what it is looking for, which is exactly
// what happened here.
const chatInputSource = readFileSync(
  join(import.meta.dir, 'composer', 'composer.tsx'),
  'utf8',
);
const chatGateSource = readFileSync(join(import.meta.dir, 'model-connection-gate.tsx'), 'utf8');

describe('model management entry-point routing', () => {
  test('maps each precise action to the matching project modal tab', () => {
    // JAY-510 merged 'catalog' + 'connected' into the single `providers` tab.
    expect(projectProviderModalTab('providers')).toBe('providers');
    expect(projectProviderModalTab('connected')).toBe('providers');
    expect(projectProviderModalTab('models')).toBe('models');
  });

  test('opens the project provider modal without opening Customize', () => {
    expect(gateSource).toContain('setProjectModalTab(projectProviderModalTab(tab))');
    expect(gateSource).toContain('setProjectModalOpen(true)');
    expect(gateSource).not.toContain('useCustomizeStore');
    expect(gateSource).not.toContain('openCustomize');
  });

  test('routes each model-selector management action through the modal gate', () => {
    expect(selectorSource.match(/handleOpenProviderModal\('providers'\)/g)).toHaveLength(2);
    expect(selectorSource.match(/handleOpenProviderModal\('models'\)/g)).toHaveLength(1);
    expect(selectorSource).toContain('aria-label="Add provider"');
    expect(selectorSource).toContain('aria-label="Manage models"');
    expect(selectorSource).toContain('Connect provider');
  });

  // A picked model only STAYS picked if `isSelectableModel` agrees the project
  // offers it — `resolveAvailableSelectedModel` nulls it otherwise, and the
  // picker then renders `unsetLabel` with no check mark, so every click looks
  // like a no-op. That answer must come from the server's `enabled` flag, never
  // from a second client-side entitlement derivation: the gate's old billing
  // `tier_key` free-tier rule contradicted the server's
  // `KORTIX_BILLING_INTERNAL_ENABLED ? … : false` and killed every selection.
  test('reads server-resolved enablement instead of re-deriving entitlement', () => {
    expect(gateSource).toContain('model.enabled !== false');
    expect(gateSource).toContain('return isModelOffered(model)');
    const imports = gateSource.slice(0, gateSource.indexOf('export function'));
    expect(imports).not.toContain('hasUsableModel');
    expect(imports).not.toContain('connectedGatewayProviderIdsFromSecretNames');
    expect(imports).not.toContain('accountStateSelectors');
  });

  test('keeps the model picker in a loading state until all model inputs resolve', () => {
    expect(selectorSource).toContain('modelsLoading || entitlementsPending');
    expect(selectorSource).toContain('aria-label="Loading models"');
    expect(selectorSource).toContain('<Loading');
  });
});

/**
 * THE `/new` dead-click fix. The gate used to derive its project purely from
 * `useParams<{ id?: string }>()`. Every original caller lives under
 * `/projects/[id]`, so that was invisible — until the onboarding wizard's plan
 * step started rendering on `/new` (`app/(app)/new`), a route with NO `[id]`
 * segment. There `params.id` is `undefined`, `projectId` resolved to `null`,
 * `modal` was therefore `null`, and picking "Bring your own API key" rendered
 * nothing AND never called `onContinue()` — the wizard could not advance past
 * a step whose primary button is its only control.
 */
describe('resolveGateProjectId: which project the gate acts on', () => {
  test('an explicitly passed id wins over the route', () => {
    expect(resolveGateProjectId('proj_explicit', 'proj_from_route')).toBe('proj_explicit');
  });

  test('falls back to the route id when the caller passes none', () => {
    expect(resolveGateProjectId(undefined, 'proj_from_route')).toBe('proj_from_route');
  });

  test('THE /new case: no explicit id and no [id] segment resolves to null', () => {
    expect(resolveGateProjectId(undefined, undefined)).toBeNull();
  });

  /**
   * `!== undefined`, never `??`. Under `??` a caller that deliberately says
   * "act on NO project" would silently inherit whatever route it happens to be
   * rendered under — the opposite of what it asked for, and undetectable from
   * the call site.
   */
  test('an explicit null is honoured — it does NOT fall through to the route', () => {
    expect(resolveGateProjectId(null, 'proj_from_route')).toBeNull();
  });

  test('a non-string route param (a catch-all segment) is not treated as an id', () => {
    expect(resolveGateProjectId(undefined, ['a', 'b'])).toBeNull();
    expect(resolveGateProjectId(undefined, null)).toBeNull();
  });
});

describe('useModelConnectionGate: the options argument is backward compatible', () => {
  test('the scan found the hook', () => {
    expect(gateSource.length).toBeGreaterThan(0);
    expect(gateSource).toContain('export function useModelConnectionGate');
  });

  test('models stays the FIRST parameter and options is optional', () => {
    expect(gateSource).toContain('models: FlatModel[] = []');
    expect(gateSource).toContain('options?: { projectId?: string | null }');
  });

  test('the hook resolves through resolveGateProjectId, not a raw params read', () => {
    expect(gateSource).toContain('resolveGateProjectId(options?.projectId, params?.id)');
    expect(gateSource).not.toContain('const projectId = typeof params?.id');
  });

  /**
   * The four callers that predate the options argument must keep behaving
   * EXACTLY as they did: none passes options, so the route stays their single
   * source of truth. If one of them ever starts passing an id, that is a
   * behaviour change on `/projects/[id]` that somebody has to decide on.
   */
  test('the composer calls the hook with models only', () => {
    expect(chatInputSource).toContain('useModelConnectionGate(models)');
    expect(chatInputSource).not.toContain('useModelConnectionGate(models,');
  });

  test('model-selector calls the hook with models only', () => {
    expect(selectorSource).toContain('useModelConnectionGate(models)');
    expect(selectorSource).not.toContain('useModelConnectionGate(models,');
  });

  test('both model-connection-gate call sites still pass nothing at all', () => {
    expect(chatGateSource.match(/useModelConnectionGate\(\)/g)?.length).toBe(2);
  });
});

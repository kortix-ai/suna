import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectProviderModalTab } from './use-model-connection-gate';

const gateSource = readFileSync(join(import.meta.dir, 'use-model-connection-gate.tsx'), 'utf8');
const selectorSource = readFileSync(join(import.meta.dir, 'model-selector.tsx'), 'utf8');

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

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectProviderModalTab } from './use-model-connection-gate';

const gateSource = readFileSync(join(import.meta.dir, 'use-model-connection-gate.tsx'), 'utf8');
const selectorSource = readFileSync(join(import.meta.dir, 'model-selector.tsx'), 'utf8');

describe('model management entry-point routing', () => {
  test('maps each precise action to the matching project modal tab', () => {
    expect(projectProviderModalTab('providers')).toBe('catalog');
    expect(projectProviderModalTab('connected')).toBe('connected');
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

  test('keeps the model picker in a loading state until all model inputs resolve', () => {
    expect(selectorSource).toContain('modelsLoading || entitlementsPending');
    expect(selectorSource).toContain('aria-label="Loading models"');
    expect(selectorSource).toContain('<Loading');
  });
});

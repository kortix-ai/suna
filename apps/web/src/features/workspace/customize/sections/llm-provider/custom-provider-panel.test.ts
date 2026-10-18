import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { customProviderIdsFromSecrets } from './custom-provider-panel';

const panelSource = readFileSync(join(import.meta.dir, 'custom-provider-panel.tsx'), 'utf8');
const formSource = readFileSync(join(import.meta.dir, 'custom-provider-form.tsx'), 'utf8');

/** The exact name `CustomProviderForm` writes — kept here so the two halves of
 *  the round trip are compared, not two copies of one assumption. */
function secretNameFor(providerId: string): string {
  return `CUSTOM_${providerId.trim().toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

describe('custom provider list', () => {
  test('recovers the provider id from the secret name the form writes', () => {
    expect(customProviderIdsFromSecrets([secretNameFor('my-llm')])).toEqual(['my-llm']);
    expect(customProviderIdsFromSecrets([secretNameFor('vllm')])).toEqual(['vllm']);
  });

  test('ignores every secret that is not a custom provider key', () => {
    expect(
      customProviderIdsFromSecrets([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'CUSTOM_THING',
        'GITHUB_TOKEN',
      ]),
    ).toEqual([]);
  });

  test('dedupes and sorts so the list order never depends on the secrets response order', () => {
    expect(
      customProviderIdsFromSecrets([
        'CUSTOM_ZED_API_KEY',
        'CUSTOM_ACME_API_KEY',
        'CUSTOM_ZED_API_KEY',
      ]),
    ).toEqual(['acme', 'zed']);
  });

  // The form stays on the tab; no separate configuration example.
  // The saved list (board CP02) sits above it only when there is something
  // to show, and never replaces it.
  test('the form is the tab; saved providers list above it only when they exist', () => {
    expect(panelSource).toContain('<CustomProviderForm');
    expect(panelSource).toContain('ids.length > 0 ? (');
    expect(panelSource.indexOf('<CustomProviderRow')).toBeLessThan(
      panelSource.indexOf('<CustomProviderForm'),
    );
    expect(panelSource).not.toContain('EmptyState');
  });

  test('a saved provider opens in the page sheet, with no Remove control', () => {
    expect(panelSource).toContain('useModelsPageSheet(');
    expect(panelSource).not.toMatch(/<SplitSheet[\s>]/);
    expect(panelSource).not.toContain('<SplitSheetContent');
    expect(panelSource).toContain('<CustomProviderDetail');
    expect(panelSource).not.toMatch(/deleteProjectSecret/);
  });

  test('the secret name shown in the form is the one the save writes', () => {
    expect(formSource).toContain('customProviderSecretName(trimmed.providerId)');
    expect(formSource).toContain('customProviderSecretName(form.providerId)');
  });

  // The field was `type="text"`, so a pasted key sat legible on screen and in
  // every screenshot — the exact defect `provider-connect.tsx` fixed for
  // catalog providers.
  test('the API key field is masked, with a reveal control', () => {
    expect(formSource).toContain("type={revealKey ? 'text' : 'password'}");
    expect(formSource).toContain('aria-pressed={revealKey}');
    expect(formSource).toContain('data-1p-ignore');
  });
});

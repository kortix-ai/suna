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

  // The list is the reason this tab is a list and not a lone form. If the row
  // stops rendering, the tab silently goes back to "a form floating in an empty
  // pane" with nothing on screen proving a custom provider was ever added.
  test('the panel renders added providers above the form, on the provider-list grid', () => {
    expect(panelSource).toContain('<AddedCustomProviders');
    expect(panelSource).toContain('<CustomProviderForm');
    expect(panelSource.indexOf('<AddedCustomProviders')).toBeLessThan(
      panelSource.indexOf('<CustomProviderForm'),
    );
    // Same two-column axis `provider-connect.tsx` uses for a provider row.
    expect(panelSource).toContain('sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]');
    expect(formSource).toContain('sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]');
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

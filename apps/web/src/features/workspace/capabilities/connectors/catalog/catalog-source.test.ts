import { expect, test } from 'bun:test';
import { catalogSource } from './catalog-source';

test('managed is the default even when direct discovery is enabled', () => {
  expect(catalogSource(null, true)).toBe('easy-connect');
  expect(catalogSource('unknown', true)).toBe('easy-connect');
});
test('direct discovery requires both explicit source selection and the feature flag', () => {
  expect(catalogSource('direct', true)).toBe('discover');
  expect(catalogSource('direct', false)).toBe('easy-connect');
  expect(catalogSource('managed', true)).toBe('easy-connect');
});

test('page wires source selection into the catalogue and exposes both routes', async () => {
  const page = await Bun.file(new URL('../connectors-page.tsx', import.meta.url)).text();
  expect(page).toContain("catalogSource(search?.get('source') ?? null, discoverEnabled)");
  expect(page).toContain('discoverEnabled: directSelected');
  expect(page).toContain("raw('connectorSourceManaged')");
  expect(page).toContain("raw('connectorSourceDirect')");
  expect(page).toContain("params.delete('scope')");
});

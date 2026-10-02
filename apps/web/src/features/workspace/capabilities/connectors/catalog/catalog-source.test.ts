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


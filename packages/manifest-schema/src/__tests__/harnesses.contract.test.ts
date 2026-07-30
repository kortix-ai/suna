import { expect, test } from 'bun:test';

import { HARNESS_IDS } from '../../../shared/src/harnesses';
import { V3_HARNESS_VALUES } from '../constants';
import { KORTIX_V3_JSON_SCHEMA } from '../json-schema';

test('v3 manifest harnesses match the shared runtime catalog', () => {
  expect(V3_HARNESS_VALUES).toEqual(HARNESS_IDS);
});

test('v3 schema declares itself experimental and unreleased', () => {
  const text = JSON.stringify(KORTIX_V3_JSON_SCHEMA);
  expect(text).toContain('EXPERIMENTAL AND UNRELEASED');
  expect(text).toContain('kortix_version: 2');
  expect(text).toContain('name of a declared runtime profile');
  expect(text).toContain('harness-native agent identifier');
  // No copy may present v3 as an available feature.
  expect(text).not.toContain('ACP & Multi-Harness');
  expect(text).not.toContain('New generic projects enable');
});

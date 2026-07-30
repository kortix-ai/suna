import { expect, test } from 'bun:test';

import { HARNESS_IDS } from '../../../shared/src/harnesses';
import { V3_HARNESS_VALUES } from '../constants';
import { KORTIX_V3_JSON_SCHEMA } from '../json-schema';

test('v3 manifest harnesses match the shared runtime catalog', () => {
  expect(V3_HARNESS_VALUES).toEqual(HARNESS_IDS);
});

test('v3 schema explains the multi-harness routing contract', () => {
  const text = JSON.stringify(KORTIX_V3_JSON_SCHEMA);
  expect(text).toContain('ACP & Multi-Harness');
  expect(text).toContain('OpenCode, Claude Code, Codex, and Pi');
  expect(text).toContain('New generic projects enable');
  expect(text).toContain('immutable when a session starts');
  expect(text).toContain('name of a declared runtime profile');
  expect(text).toContain('harness-native agent identifier');
});

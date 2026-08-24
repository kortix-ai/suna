import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'db-deps.ts'), 'utf8');

test('the managed toolkit endpoint never falls back from Composio to Pipedream', () => {
  const start = source.indexOf('listConnectToolkits: async');
  const end = source.indexOf('connectorConnect: async', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const implementation = source.slice(start, end);
  expect(implementation).toContain('composio.composioCatalogPage');
  expect(implementation).toContain('return null;');
  expect(implementation).not.toContain('pipedreamCatalogPage');
});

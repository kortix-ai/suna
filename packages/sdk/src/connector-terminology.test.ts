import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_FILES = [
  'core/rest/workspaces-client/connectors.ts',
  'core/rest/workspaces-client/sessions.ts',
  'core/rest/workspaces-client/channels.ts',
  'core/rest/workspaces-client/secrets.ts',
  'core/client/kortix.ts',
] as const;

test('the public SDK uses only connector and connection product terminology', () => {
  const source = SOURCE_FILES.map((path) => readFileSync(join(import.meta.dir, path), 'utf8')).join(
    '\n',
  );

  expect(source).not.toMatch(/ConnectionProfile/);
  expect(source).not.toMatch(/ConnectorAuthorization(?!Strategy)/);
  expect(source).not.toMatch(/profile_id|profileId|profileSlug/);
  expect(source).not.toMatch(/['"]executor['"]/);

  for (const snapshot of ['public-surface.snapshot.json', 'public-type-surface.snapshot.json']) {
    const names = readFileSync(join(import.meta.dir, snapshot), 'utf8');
    expect(names).not.toMatch(/ConnectionProfile/);
    expect(names).not.toMatch(/ConnectorAuthorization(?!Strategy)/);
    expect(names).not.toMatch(/ensureProjectConnectorProfile/);
  }
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-onboarding-wizard.tsx'), 'utf8');

describe('project onboarding connections', () => {
  test('collects an explicit connection before connecting', () => {
    expect(source).toContain('<ConnectorConnectionModal');
    expect(source).toContain('idPrefix="onboarding-tool-connection"');
    expect(source).toContain('connectorSlug: connection.slug');
    expect(source).toContain('authorizationStrategy: connection.authorizationStrategy');
  });

  test('allows multiple connections for one provider app', () => {
    expect(source).toContain('proposeConnectorConnectionSlug(selectedApp.slug, existingSlugs)');
    expect(source).toContain('aria-label={`Add ${app.name} connection`}');
    expect(source).not.toContain('disabled={connected || busy}');
  });

  test('does not infer onboarding status from the shared project secret', () => {
    expect(source).not.toContain('.filter((c) => c.secretSet)');
    expect(source).not.toContain('connectedSlugs');
  });
});

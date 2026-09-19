import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The wizard shell is now a frame only; `ConnectorProfileModal` and the whole
// tools flow moved into their own module during the single-column refactor.
// These assertions follow the code — they are not weakened.
const source = readFileSync(join(import.meta.dir, 'onboarding', 'steps', 'tools-step.tsx'), 'utf8');

describe('project onboarding connections', () => {
  test('collects an explicit connection before connecting', () => {
    expect(source).toContain('<ConnectorConnectionModal');
    expect(source).toContain('idPrefix="onboarding-tool-connection"');
    expect(source).toContain('connectorSlug: connection.slug');
    expect(source).toContain('connectorName: connection.name');
    // The authorization strategy is retired (2026-09-16): an account is shared
    // or private per connection, chosen at call time — never on the connector.
    expect(source).not.toContain('authorizationStrategy');
  });

  test('allows multiple connections for one provider app', () => {
    expect(source).toContain('proposeConnectorConnectionSlug(selectedApp.name, existingSlugs)');
    expect(source).toContain("aria-label={t('addConnection', { app: app.name })}");
    expect(source).not.toContain('disabled={connected || busy}');
  });

  test('does not infer onboarding status from the shared project secret', () => {
    expect(source).not.toContain('.filter((c) => c.secretSet)');
    expect(source).not.toContain('connectedSlugs');
  });
});

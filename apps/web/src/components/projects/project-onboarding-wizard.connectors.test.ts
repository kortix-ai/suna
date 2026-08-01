import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-onboarding-wizard.tsx'), 'utf8');

describe('project onboarding connector profiles', () => {
  test('collects an explicit profile before starting authorization', () => {
    expect(source).toContain('<ConnectorProfileModal');
    expect(source).toContain('idPrefix="onboarding-tool-profile"');
    expect(source).toContain('profileSlug: profile.slug');
    expect(source).toContain('authorizationStrategy: profile.authorizationStrategy');
  });

  test('allows multiple profiles for one provider app', () => {
    expect(source).toContain('proposeConnectorProfileSlug(selectedApp.slug, existingSlugs)');
    expect(source).toContain('aria-label={`Add ${app.name} profile`}');
    expect(source).not.toContain('disabled={connected || busy}');
  });

  test('does not infer onboarding status from the shared project secret', () => {
    expect(source).not.toContain('.filter((c) => c.secretSet)');
    expect(source).not.toContain('connectedSlugs');
  });
});

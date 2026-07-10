// The guided SSO wizard must keep encoding the battle-tested IdP gotchas
// (found setting up a real Entra tenant) and stay wired end-to-end: provider
// picker → per-provider steps → copyable SP values → INLINE metadata import.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_GUIDES, getProviderGuide } from './guides';

const dir = import.meta.dir;
const wizardSource = readFileSync(join(dir, 'setup-wizard.tsx'), 'utf8');
const cardSource = readFileSync(
  join(dir, '../../components/iam/sso-card.tsx'),
  'utf8',
);

describe('provider guides', () => {
  test('cover Entra, Okta, Google, and Custom SAML', () => {
    expect(PROVIDER_GUIDES.map((g) => g.id).sort()).toEqual([
      'custom',
      'entra',
      'google',
      'okta',
    ]);
  });

  test('every guide ends with the inline import step followed by a test step', () => {
    for (const g of PROVIDER_GUIDES) {
      const kinds = g.steps.map((s) => s.kind);
      expect(kinds[kinds.length - 2]).toBe('import');
      expect(kinds[kinds.length - 1]).toBe('test');
    }
  });

  test('every guide shows the copyable SP values at least once', () => {
    for (const g of PROVIDER_GUIDES) {
      expect(g.steps.some((s) => s.showSpValues)).toBe(true);
    }
  });

  test('the Entra guide encodes the live-tested gotchas', () => {
    const entra = getProviderGuide('entra')!;
    const text = JSON.stringify(entra.steps);
    // Empty user.mail on onmicrosoft.com accounts → email claim must be UPN.
    expect(text).toContain('user.userprincipalname');
    // Group claim name must match what Kortix is configured with.
    expect(entra.defaultGroupClaim).toBe('memberOf');
    // Display names / group assignment need a paid Entra tier.
    expect(text).toContain('P1/P2');
    // GUID fallback for Free-tier tenants.
    expect(text).toContain('Object IDs');
  });

  test('Okta and Google default to the groups claim', () => {
    expect(getProviderGuide('okta')!.defaultGroupClaim).toBe('groups');
    expect(getProviderGuide('google')!.defaultGroupClaim).toBe('groups');
  });

  test('unknown provider ids resolve to null (wizard falls back to the picker)', () => {
    expect(getProviderGuide('bogus')).toBeNull();
    expect(getProviderGuide(null)).toBeNull();
  });
});

describe('setup wizard wiring', () => {
  test('renders SP values from the shared saml-sp lib', () => {
    expect(wizardSource).toContain("from '@/lib/saml-sp'");
    expect(wizardSource).toContain('buildSamlSpUrls');
  });

  test('the import step registers the provider inline', () => {
    expect(wizardSource).toContain('importSsoProviderFromMetadata');
  });

  test('progress persists per account + provider', () => {
    expect(wizardSource).toContain('kortix:sso-setup:');
  });

  test('non-entitled accounts see the enterprise upsell, not the wizard', () => {
    expect(wizardSource).toContain('<EnterpriseUpsell feature="identity" />');
  });
});

describe('sso card entry point', () => {
  test('Configure routes new providers into the guided wizard', () => {
    expect(cardSource).toContain('/sso-setup');
  });
});

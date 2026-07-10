// The guided SSO wizard must keep encoding the battle-tested IdP gotchas
// (found setting up a real Entra tenant) and stay wired end-to-end: provider
// picker → per-provider steps → copyable SP values → INLINE metadata import.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDER_GUIDES,
  SCIM_PROVIDER_GUIDES,
  getProviderGuide,
  getScimGuide,
} from './guides';

const dir = import.meta.dir;
const wizardSource = readFileSync(join(dir, 'setup-wizard.tsx'), 'utf8');
const cardSource = readFileSync(
  join(dir, '../../components/iam/sso-card.tsx'),
  'utf8',
);
const scimCardSource = readFileSync(
  join(dir, '../../components/iam/scim-card.tsx'),
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
      const shows = g.steps.some(
        (s) => s.showSpValues || s.content?.some((b) => b.kind === 'sp-values'),
      );
      expect(shows).toBe(true);
    }
  });

  test('the Entra guide encodes the live-tested gotchas', () => {
    const entra = getProviderGuide('entra')!;
    const text = JSON.stringify(entra.steps);
    // Empty user.mail on onmicrosoft.com accounts → email claim must be UPN.
    expect(text).toContain('user.userprincipalname');
    // Group claim name must match what Kortix is configured with.
    expect(entra.config.groupClaimName).toBe('memberOf');
    // Display names / group assignment need a paid Entra tier.
    expect(text).toContain('P1/P2');
    // GUID fallback for Free-tier tenants.
    expect(text).toContain('Object IDs');
  });

  // The per-provider config matrix — these values genuinely DIFFER between
  // IdPs and a wrong one silently breaks group sync. Entra live-verified;
  // Okta/Google per official docs.
  test('per-provider config: group claim names', () => {
    expect(getProviderGuide('entra')!.config.groupClaimName).toBe('memberOf');
    expect(getProviderGuide('okta')!.config.groupClaimName).toBe('groups');
    expect(getProviderGuide('google')!.config.groupClaimName).toBe('groups');
    expect(getProviderGuide('custom')!.config.groupClaimName).toBe('groups');
  });

  test('per-provider config: group VALUE formats (GUIDs vs names)', () => {
    expect(getProviderGuide('entra')!.config.groupValueHint).toContain('GUIDs');
    expect(getProviderGuide('okta')!.config.groupValueHint).toContain('NAMES');
    expect(getProviderGuide('google')!.config.groupValueHint).toContain('NAMES');
    // Google only sends explicitly selected groups, capped at 75.
    expect(getProviderGuide('google')!.config.groupValueHint).toContain('75');
  });

  test('per-provider config: metadata form (Google is XML-download only)', () => {
    expect(getProviderGuide('entra')!.config.preferredMetadata).toBe('url');
    expect(getProviderGuide('okta')!.config.preferredMetadata).toBe('url');
    expect(getProviderGuide('google')!.config.preferredMetadata).toBe('xml');
    expect(getProviderGuide('google')!.config.metadataSource).toContain('does not host');
  });

  test('the Okta guide adds an explicit email attribute statement', () => {
    const text = JSON.stringify(getProviderGuide('okta')!.steps);
    expect(text).toContain('user.email');
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
    expect(wizardSource).toContain('kortix:sso-setup');
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

describe('directory sync (SCIM) guides', () => {
  test('cover Entra, Okta, and Custom SCIM', () => {
    expect(SCIM_PROVIDER_GUIDES.map((g) => g.id).sort()).toEqual(['custom', 'entra', 'okta']);
  });

  test('every guide mints the token inline before configuring the IdP, and ends with verify', () => {
    for (const g of SCIM_PROVIDER_GUIDES) {
      const kinds = g.steps.map((s) => s.kind);
      expect(kinds).toContain('scim-token');
      expect(kinds[kinds.length - 1]).toBe('test');
      // Token must come before every instructions step that references it.
      expect(kinds.indexOf('scim-token')).toBeLessThan(kinds.lastIndexOf(undefined as never));
    }
  });

  test('the Entra guide encodes the live-tested provisioning run', () => {
    const entra = getScimGuide('entra')!;
    const text = JSON.stringify(entra.steps);
    expect(text).toContain('Provision on demand');
    expect(text).toContain('Block sign in');
    expect(text).toContain('P1/P2');
    // The hand-built-URL trap (Tenant URL has no /v1).
    expect(text).toContain('no /v1 suffix');
  });

  test('deactivation semantics are spelled out (membership removed, tokens revoked)', () => {
    for (const g of SCIM_PROVIDER_GUIDES) {
      const text = JSON.stringify(g.steps);
      expect(text).toContain('revokes their tokens');
    }
  });

  test('unknown ids resolve to null (wizard falls back to the picker)', () => {
    expect(getScimGuide('bogus')).toBeNull();
    expect(getScimGuide(null)).toBeNull();
  });
});

describe('directory sync wizard wiring', () => {
  test('mints the SCIM token inline and shows the Tenant URL', () => {
    expect(wizardSource).toContain('createScimToken');
    expect(wizardSource).toContain('buildScimBaseUrl');
    expect(wizardSource).toContain('Tenant URL');
  });

  test('scim progress persists under its own key', () => {
    expect(wizardSource).toContain('kortix:scim-setup');
  });

  test('scim flow gates on the scim entitlement', () => {
    expect(wizardSource).toContain("entitlement: 'scim'");
  });

  test('both wizards are exported from one core', () => {
    expect(wizardSource).toContain('export function SsoSetupWizard');
    expect(wizardSource).toContain('export function ScimSetupWizard');
  });

  test('the SCIM card links into the guided setup', () => {
    expect(scimCardSource).toContain('/scim-setup');
  });
});

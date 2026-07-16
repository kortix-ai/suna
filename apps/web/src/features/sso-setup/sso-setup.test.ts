// The guided SSO wizard must keep encoding the battle-tested IdP gotchas
// (found setting up a real Entra tenant) and stay wired end-to-end: provider
// picker → per-provider steps → copyable SP values → INLINE metadata import.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_GUIDES, SCIM_PROVIDER_GUIDES, getProviderGuide, getScimGuide } from './guides';

const dir = import.meta.dir;
const wizardSource = readFileSync(join(dir, 'setup-wizard.tsx'), 'utf8');
const cardSource = readFileSync(join(dir, '../../components/iam/sso-card.tsx'), 'utf8');
const scimCardSource = readFileSync(join(dir, '../../components/iam/scim-card.tsx'), 'utf8');
const guidesSource = readFileSync(join(dir, 'guides.ts'), 'utf8');
// Prose the formatter is free to rewrap across lines — collapse whitespace
// so a multi-word assertion doesn't break on an incidental line break.
const flatWizardSource = wizardSource.replace(/\s+/g, ' ');
const flatGuidesSource = guidesSource.replace(/\s+/g, ' ');

describe('provider guides', () => {
  test('cover Entra, Okta, Google, and Custom SAML', () => {
    expect(PROVIDER_GUIDES.map((g) => g.id).sort()).toEqual(['custom', 'entra', 'google', 'okta']);
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

describe('auto-provision groups default', () => {
  test('the wizard connect form defaults auto-provision ON', () => {
    expect(wizardSource).toContain('setAutoProvision] = useState(true)');
  });

  test('the SSO card dialog defaults ON for new providers, stored value for existing', () => {
    expect(cardSource).toContain('useState(existing ? existing.auto_provision_groups : true)');
  });
});

describe('schematic figures (WorkOS-informed content, our own rendering)', () => {
  test('StepFigure falls back to a schematic panel before it falls back to a bare placeholder', () => {
    expect(wizardSource).toContain('function SchematicPanel');
    expect(wizardSource).toMatch(/missing\s*\?\s*\(\s*schematic\s*\?\s*\(\s*<SchematicPanel/);
  });

  test('schematics are declarative data on the guide step, not JSX baked into guides.ts', () => {
    expect(guidesSource).toContain('export interface StepSchematic');
    expect(guidesSource).not.toMatch(/<[A-Z]\w*[\s/>]/); // no JSX tags in the data file
  });

  test('every provider with a console (Entra, Okta, Google) has at least one schematic', () => {
    for (const id of ['entra', 'okta', 'google']) {
      const guide = getProviderGuide(id)!;
      const text = JSON.stringify(guide.steps);
      expect(text).toContain('"schematic"');
    }
    for (const id of ['entra', 'okta']) {
      const guide = getScimGuide(id)!;
      const text = JSON.stringify(guide.steps);
      expect(text).toContain('"schematic"');
    }
  });

  test('the flagship Entra schematic names the exact screen the user asked to see', () => {
    const entraScim = getScimGuide('entra')!;
    const text = JSON.stringify(entraScim.steps);
    expect(text).toContain('Entra → Provisioning → Admin Credentials');
    expect(text).toContain('Tenant URL');
    expect(text).toContain('Secret Token');
    expect(text).toContain('Test Connection');
  });
});

describe('WorkOS-informed guide content, adopted per provider (not copied assets)', () => {
  test('Entra SCIM: the default objectId → externalId mapping is called out (not just userName)', () => {
    const text = JSON.stringify(getScimGuide('entra')!.steps);
    expect(text).toContain('objectId');
    expect(text).toContain('externalId');
  });

  test('Okta SAML: the wizard-only "internal app" feedback step is documented', () => {
    const text = JSON.stringify(getProviderGuide('okta')!.steps);
    expect(text).toContain('This is an internal app that we have created');
  });

  test('Okta SCIM: Push Groups uses the exact click path (Find groups by name, Push Immediately)', () => {
    const text = JSON.stringify(getScimGuide('okta')!.steps);
    expect(text).toContain('Find groups by name');
    expect(text).toContain('Push Immediately');
  });

  test('Google Workspace: attribute mapping and the 24-hour propagation gotcha are documented', () => {
    const google = getProviderGuide('google')!;
    const stepIds = google.steps.map((s) => s.id);
    expect(stepIds).toContain('attribute-mapping');
    const text = JSON.stringify(google.steps);
    expect(text).toContain('24 hours');
  });

  test('Google Workspace has no SCIM guide — there is no first-party directory to sync', () => {
    expect(getScimGuide('google')).toBeNull();
  });
});

describe('SCIM scope trade-off copy (live confusion: "why only assigned?")', () => {
  test('the Entra configure step explains "sync only assigned" vs "sync all" in plain terms', () => {
    const text = JSON.stringify(getScimGuide('entra')!.steps);
    expect(text).toContain('your allowlist');
    expect(text).toContain('roll out team-by-team');
    expect(text).toContain('rarely what a company tenant wants on day one');
  });

  test('states the accurate location: Scope lives on the Provisioning page under Settings', () => {
    expect(guidesSource).toContain('"Provisioning" → "Settings"');
    expect(guidesSource).toContain('it only appears here after credentials are saved');
  });
});

describe('domain field explains its consequence in the guided wizard (live incident)', () => {
  test('states that every sign-in from the domain routes to the IdP instead of password login', () => {
    expect(flatWizardSource).toContain(
      'Every sign-in from this domain is routed to this identity provider instead of password login',
    );
  });

  test("warns when the entered domain matches the current admin's own email domain", () => {
    expect(wizardSource).toContain('adminEmailDomain');
    expect(flatWizardSource).toContain('this will route YOUR next sign-in to the IdP');
  });
});

// Every screenshot a guide references must exist in public/ — the GuideImage
// component self-hides on a missing file, which silently degrades a step to
// text-only (exactly the "no screenshots that guide you" regression). This
// walks every image src in guides.ts and fails on the first dead slot, so a
// guide edit can never reference an asset that was never shipped.
describe('guide screenshots ship with the guides', () => {
  test('every referenced /sso-setup image exists on disk', () => {
    const refs = [...guidesSource.matchAll(/['"](\/sso-setup\/[a-z-]+\/[a-z0-9-]+\.png)['"]/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((ref) => {
      try {
        readFileSync(join(dir, '../../../public', ref));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });
});

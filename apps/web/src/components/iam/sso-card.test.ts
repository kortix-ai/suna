// The SSO card is customer-facing (enterprise admins): the Supabase delegation
// is an internal implementation detail and must never surface in the UI — no
// provider-UUID field, no "register it in Supabase Studio" copy. The id still
// exists on the wire; the card threads it silently on edit.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'sso-card.tsx'), 'utf8');
// Prose the formatter is free to rewrap across lines — collapse whitespace
// so a multi-word assertion doesn't break on an incidental line break.
const flatSource = source.replace(/\s+/g, ' ');

describe('SSO card — no internal provider plumbing in the UI', () => {
  test('the provider summary does not render the internal provider id', () => {
    expect(source).not.toContain('SupabaseProviderId');
  });

  test('no UUID input or advanced registration mode is offered', () => {
    expect(source).not.toContain('SupabaseProviderUUID');
    expect(source).not.toContain('Advanced: Supabase UUID');
    expect(source).not.toContain('setSupabaseId');
  });

  test('no dialog copy points admins at Supabase Studio', () => {
    expect(source).not.toContain('SupabaseStudio');
    expect(source).not.toContain('Supabase Studio');
  });

  test('edits thread the stored provider id under the hood', () => {
    expect(source).toContain('existing!.supabase_sso_provider_id');
  });

  test('new providers register via metadata import only', () => {
    expect(source).toContain('const importing = !existing');
    expect(source).toContain('importSsoProviderFromMetadata');
  });
});

describe('SSO card — service provider details block', () => {
  test('renders a "Service provider details" block', () => {
    expect(source).toContain('Service provider details');
  });

  test('derives the SP values from the shared saml-sp lib (paths live there)', () => {
    expect(source).toContain("from '@/lib/saml-sp'");
    expect(source).toContain('buildSamlSpUrls(getEnv().SUPABASE_URL)');
  });

  test('uses neutral labels, never naming the delegated identity provider', () => {
    expect(source).toContain('Identifier (Entity ID)');
    expect(source).toContain('Reply URL (ACS)');
    expect(source).not.toContain('Supabase Studio');
    expect(source).not.toContain('SupabaseStudio');
  });

  test('offers a copy affordance for each SP value', () => {
    expect(source).toContain('Copy Identifier (Entity ID)');
    expect(source).toContain('Copy Reply URL (ACS)');
    expect(source).toContain('copyToClipboard');
  });

  test('renders the block before a provider is configured, and inside the configure/edit dialog', () => {
    expect(source).toMatch(/\{!provider && spUrls && \([\s\S]*?<SpDetails/);
    expect(source).toMatch(/\{spUrls && (?:\(\s*)?<SpDetails/);
  });

  test('hides the block rather than render a broken URL when the origin is unavailable', () => {
    // Null-origin handling is unit-tested in lib/saml-sp.test.ts; the card
    // just guards the render on the derived value.
    expect(source).toMatch(/\{!provider && spUrls && \([\s\S]*?<SpDetails/);
  });
});

describe('SSO card — enforce_sso toggle (connected state)', () => {
  test('renders the toggle with its own label and off-by-default state', () => {
    expect(source).toContain('Enforce SSO for this domain');
    expect(source).toContain('checked={!!provider.enforce_sso}');
  });

  test('the toggle is a full upsert that only flips enforce_sso — every other stored field is resent unchanged', () => {
    expect(source).toContain('enforceSsoMutation');
    expect(source).toContain('enforce_sso: enforce');
    expect(source).toContain('supabase_sso_provider_id: provider.supabase_sso_provider_id');
    expect(source).toContain('primary_domain: provider.primary_domain');
  });

  test('warns that pre-enforcement password sign-ins lose the password path', () => {
    expect(flatSource).toContain('the password option disappears');
    expect(flatSource).toContain('only your identity provider works after that');
  });

  test('the toggle is disabled for non-managers', () => {
    expect(source).toMatch(/canManage\s*&&\s*\(\s*<Switch/);
  });
});

describe('SSO card — domain field explains its consequence (live incident)', () => {
  test('states that every sign-in from the domain routes to the IdP instead of password login', () => {
    expect(flatSource).toContain(
      'Every sign-in from this domain is routed to this identity provider instead of password login',
    );
    expect(flatSource).toContain('Users on other domains are unaffected');
  });

  test("warns when the entered domain matches the current admin's own email domain", () => {
    expect(source).toContain('adminEmailDomain');
    expect(flatSource).toContain('this will route YOUR next sign-in to the IdP');
  });
});

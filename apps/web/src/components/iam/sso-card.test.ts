// The SSO card is customer-facing (enterprise admins): the Supabase delegation
// is an internal implementation detail and must never surface in the UI — no
// provider-UUID field, no "register it in Supabase Studio" copy. The id still
// exists on the wire; the card threads it silently on edit.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'sso-card.tsx'), 'utf8');

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

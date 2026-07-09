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

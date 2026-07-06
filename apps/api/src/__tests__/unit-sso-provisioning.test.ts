/**
 * Unit tests for the self-serve SAML registration helper. Mocks the Supabase
 * GoTrue admin call so we assert the request shape + the error-status mapping
 * without a live Supabase. Assumes SUPABASE_URL/SERVICE_ROLE_KEY are present in
 * the test env (config validates them) so the helper reaches the fetch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { registerSupabaseSamlProvider } from '../accounts/iam/sso-provisioning';

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function respond(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

describe('registerSupabaseSamlProvider', () => {
  test('rejects when neither metadata_xml nor metadata_url is given', async () => {
    const r = await registerSupabaseSamlProvider({ domains: ['acme.com'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test('rejects when both metadata forms are given', async () => {
    const r = await registerSupabaseSamlProvider({
      metadataXml: '<x/>',
      metadataUrl: 'https://x',
      domains: ['acme.com'],
    });
    expect(r.ok).toBe(false);
  });

  test('rejects empty domains', async () => {
    const r = await registerSupabaseSamlProvider({
      metadataXml: '<EntityDescriptor></EntityDescriptor>',
      domains: [],
    });
    expect(r.ok).toBe(false);
  });

  test('posts SAML metadata to the GoTrue admin endpoint and returns the id', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: 'prov-123' }), { status: 201 });
    }) as typeof fetch;

    const r = await registerSupabaseSamlProvider({
      metadataXml: '<EntityDescriptor>…</EntityDescriptor>',
      domains: ['acme.com'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerId).toBe('prov-123');
    expect(captured!.url).toContain('/auth/v1/admin/sso/providers');
    expect(captured!.body.type).toBe('saml');
    expect(captured!.body.metadata_xml).toContain('EntityDescriptor');
    expect(captured!.body.domains).toEqual(['acme.com']);
  });

  test('maps a 422 (domain already claimed) to a 409', async () => {
    respond(422, { error: 'domain already registered' });
    const r = await registerSupabaseSamlProvider({
      metadataUrl: 'https://idp/meta',
      domains: ['acme.com'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  test('maps a 404 (SAML not enabled) to a 501 with a hint', async () => {
    respond(404, 'not found');
    const r = await registerSupabaseSamlProvider({
      metadataUrl: 'https://idp/meta',
      domains: ['acme.com'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(501);
      expect(r.error).toContain('SAML');
    }
  });

  test('a network failure is a 502, never a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await registerSupabaseSamlProvider({
      metadataUrl: 'https://idp/meta',
      domains: ['acme.com'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
  });
});

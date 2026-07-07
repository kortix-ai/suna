// Self-serve SAML registration. The dashboard's "import your Entra metadata"
// flow: instead of a Kortix operator running `supabase sso add` out of band, we
// call Supabase's GoTrue admin SSO API server-side with the service-role key,
// register the customer's IdP, and hand back the provider UUID the rest of the
// SSO config keys off. See docs/ENTRA_SSO_SCIM_SETUP.md Part A.

import { config } from '../../config';

export interface SamlMetadataInput {
  /** Raw IdP federation metadata XML (Entra: "App Federation Metadata XML"). */
  metadataXml?: string;
  /** …or the metadata URL, which Supabase fetches. Exactly one of the two. */
  metadataUrl?: string;
  /** Email domains this IdP is authoritative for (routes sign-in). */
  domains: string[];
}

export type ProvisionResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; status: number };

/**
 * Register a SAML IdP with Supabase Auth and return its provider UUID. Never
 * throws — a Supabase/GoTrue failure comes back as a typed error the route maps
 * to a clean HTTP status. Requires the deployment's Supabase service-role key.
 */
export async function registerSupabaseSamlProvider(
  input: SamlMetadataInput,
): Promise<ProvisionResult> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      error: 'SSO provisioning is not configured on this deployment',
      status: 501,
    };
  }
  const xml = typeof input.metadataXml === 'string' ? input.metadataXml.trim() : '';
  const url = typeof input.metadataUrl === 'string' ? input.metadataUrl.trim() : '';
  if (Boolean(xml) === Boolean(url)) {
    return { ok: false, error: 'Provide exactly one of metadata_xml or metadata_url', status: 400 };
  }
  if (input.domains.length === 0) {
    return { ok: false, error: 'At least one email domain is required', status: 400 };
  }

  const body: Record<string, unknown> = { type: 'saml', domains: input.domains };
  if (xml) body.metadata_xml = xml;
  else body.metadata_url = url;

  const base = config.SUPABASE_URL.replace(/\/+$/, '');
  let resp: Response;
  try {
    resp = await fetch(`${base}/auth/v1/admin/sso/providers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach Supabase auth: ${(e as Error).message}`,
      status: 502,
    };
  }

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 400);
    // 422 = a domain is already claimed by another provider (or SAML disabled).
    // 400 = malformed/unfetchable metadata. Surface Supabase's message verbatim
    // so the admin can fix the IdP side; map the duplicate case to a 409.
    const status = resp.status === 422 ? 409 : resp.status === 404 ? 501 : 400;
    const hint =
      resp.status === 404
        ? 'SAML SSO is not enabled on this Supabase project'
        : `Supabase rejected the metadata (${resp.status})`;
    return { ok: false, error: detail ? `${hint}: ${detail}` : hint, status };
  }

  const data = (await resp.json().catch(() => null)) as { id?: string } | null;
  if (!data?.id) {
    return { ok: false, error: 'Supabase did not return a provider id', status: 502 };
  }
  return { ok: true, providerId: data.id };
}

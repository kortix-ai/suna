import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── SAML SSO ─────────────────────────────────────────────────────────────

export interface SsoProvider {
  sso_provider_id: string;
  supabase_sso_provider_id: string;
  name: string;
  primary_domain: string;
  group_claim_name: string;
  auto_create_members: boolean;
  auto_provision_groups: boolean;
  /** When true, the unified auth flow refuses the password/email-code paths
   *  for this provider's primary domain — the IdP becomes the only door. */
  enforce_sso: boolean;
  /** True once the account proved control of `primary_domain`. Until then an
   *  email this IdP asserts is trusted only inside this account, and
   *  `enforce_sso` has no effect. */
  domain_verified?: boolean;
  domain_verified_at?: string | null;
  /** The DNS TXT record that proves control of `primary_domain`. */
  domain_verification?: SsoDomainVerificationRecord | null;
  created_at: string;
  updated_at: string;
}

export interface SsoDomainVerificationRecord {
  record_type: 'TXT';
  /** DNS name, e.g. `_kortix-verification.example.com`. */
  record_name: string;
  /** TXT value, e.g. `kortix-verification=<token>`. */
  record_value: string;
}

export interface SsoGroupMapping {
  mapping_id: string;
  claim_value: string;
  group_id: string;
  group_name: string;
  created_at: string;
}

export async function getSsoProvider(accountId: string) {
  return unwrap(
    await iamGet<{ provider: SsoProvider | null }>(`/accounts/${accountId}/iam/sso/provider`),
  ).provider;
}

export async function upsertSsoProvider(
  accountId: string,
  input: {
    supabase_sso_provider_id: string;
    name: string;
    primary_domain: string;
    group_claim_name?: string;
    auto_create_members?: boolean;
    auto_provision_groups?: boolean;
    enforce_sso?: boolean;
  },
) {
  return unwrap(
    await backendApi.put<{ provider: SsoProvider }>(
      `/accounts/${accountId}/iam/sso/provider`,
      input,
      { showErrors: false },
    ),
  ).provider;
}

/**
 * Self-serve: register an IdP's SAML metadata (Entra "App Federation Metadata
 * XML", or its URL) with Supabase server-side and store the resulting provider.
 * The admin never touches Supabase. One IdP per account — the API 409s if one
 * already exists.
 */
export async function importSsoProviderFromMetadata(
  accountId: string,
  input: {
    name: string;
    primary_domain: string;
    metadata_xml?: string;
    metadata_url?: string;
    group_claim_name?: string;
    auto_create_members?: boolean;
    auto_provision_groups?: boolean;
    enforce_sso?: boolean;
    domains?: string[];
  },
) {
  return unwrap(
    await backendApi.post<{ provider: SsoProvider }>(
      `/accounts/${accountId}/iam/sso/provider/from-metadata`,
      input,
      { showErrors: false },
    ),
  ).provider;
}

/**
 * Check the DNS TXT record from `provider.domain_verification` and, when it is
 * published, mark the provider's primary domain verified. Rejects with the
 * API's 422 (`code: 'sso_domain_unverified'`) while the record is missing, and
 * 409 (`sso_domain_claimed`) when another account verified the domain first.
 */
export async function verifySsoDomain(accountId: string) {
  return unwrap(
    await backendApi.post<{ provider: SsoProvider }>(
      `/accounts/${accountId}/iam/sso/provider/verify-domain`,
      {},
      { showErrors: false },
    ),
  ).provider;
}

export async function deleteSsoProvider(accountId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/sso/provider`),
  );
}

export async function listSsoGroupMappings(accountId: string) {
  return unwrap(
    await iamGet<{ mappings: SsoGroupMapping[] }>(`/accounts/${accountId}/iam/sso/mappings`),
  ).mappings;
}

export async function createSsoGroupMapping(
  accountId: string,
  input: { claim_value: string; group_id: string },
) {
  return unwrap(
    await backendApi.post<SsoGroupMapping>(`/accounts/${accountId}/iam/sso/mappings`, input, {
      showErrors: false,
    }),
  );
}

export async function deleteSsoGroupMapping(accountId: string, mappingId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/sso/mappings/${mappingId}`,
    ),
  );
}

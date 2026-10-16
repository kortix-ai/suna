import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── Enterprise demo ──────────────────────────────────────────────────────
// The self-serve switch for the Enterprise features (SSO, SCIM, advanced
// roles, audit export, branding). Backed by GET/PUT
// /accounts/:id/iam/enterprise-demo. An owner or admin (`billing.write`) turns
// it on; the account is marked "Demo" and Kortix sales is told. A license
// contract is the paid state. Read the full state from
// `AccountState.enterprise.state` ('off' | 'demo' | 'licensed').

/** Whether the account's Enterprise demo is on. */
export async function getEnterpriseDemo(accountId: string): Promise<boolean> {
  return unwrap(await iamGet<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`)).enabled;
}

/** Turn the account's Enterprise demo on or off. Returns the new value. */
export async function setEnterpriseDemo(accountId: string, enabled: boolean): Promise<boolean> {
  return unwrap(
    await backendApi.put<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`, { enabled }),
  ).enabled;
}

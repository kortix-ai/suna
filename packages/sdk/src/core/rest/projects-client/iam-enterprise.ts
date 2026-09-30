import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── Enterprise demo toggle ───────────────────────────────────────────────
// Self-serve preview of the enterprise surface (SSO, SCIM, …). Backed by
// GET/PUT /accounts/:id/iam/enterprise-demo. Off by default; flipping it on
// unlocks the enterprise features for evaluation — NOT a real Enterprise plan.

export async function getEnterpriseDemo(accountId: string): Promise<boolean> {
  return unwrap(await iamGet<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`))
    .enabled;
}

export async function setEnterpriseDemo(accountId: string, enabled: boolean): Promise<boolean> {
  return unwrap(
    await backendApi.put<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`, {
      enabled,
    }),
  ).enabled;
}

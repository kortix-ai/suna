// ACP permission policy — the persistent, per-project ACP tool-approval
// policy (Task WS5-P1-a's route: `GET`/`PUT /projects/:projectId/acp/
// permission-policy`, metadata-backed, deny-by-default). See
// apps/api/src/projects/routes/acp-permission-policy.ts for the route and
// apps/api/src/projects/lib/acp-permission-policy.ts for the server-side
// read/write helpers (server-only — this SDK never imports them).
//
// The wire shape below MIRRORS `@kortix/api-contract`'s `AcpPermissionPolicySchema`
// / `ACP_PERMISSION_POLICY_MAX_TOOLS` / `ACP_PERMISSION_POLICY_MAX_KEY_LENGTH`
// (packages/api-contract/src/index.ts) by hand — this package does not
// depend on `@kortix/api-contract` at runtime (confirmed: absent from
// package.json `dependencies`/`peerDependencies`), same posture as every
// other hand-mirrored contract type in this client tier. `@kortix/api-contract`
// is the source of truth; keep this file in sync with any schema change there.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Mirrors `ACP_PERMISSION_POLICY_MAX_TOOLS` in `@kortix/api-contract`.
 *  SoT: `packages/api-contract/src/index.ts`. */
export const ACP_PERMISSION_POLICY_MAX_TOOLS = 128;
/** Mirrors `ACP_PERMISSION_POLICY_MAX_KEY_LENGTH` in `@kortix/api-contract`.
 *  SoT: `packages/api-contract/src/index.ts`. */
export const ACP_PERMISSION_POLICY_MAX_KEY_LENGTH = 256;

/** `'none'` = prompt for every tool call (conservative default). `'reads'` =
 *  auto-approve read-only tool calls. `'all'` = auto-approve every tool call. */
export type AcpPermissionAutoApprove = 'none' | 'reads' | 'all';

/** A single remembered per-tool decision, overriding `autoApprove` for that tool. */
export type AcpPermissionToolDecision = 'allow' | 'deny';

/** Mirrors `AcpPermissionPolicy` (`z.infer<typeof AcpPermissionPolicySchema>`)
 *  in `@kortix/api-contract`. Bounded to at most
 *  `ACP_PERMISSION_POLICY_MAX_TOOLS` `toolDecisions` entries, each keyed by a
 *  tool name of at most `ACP_PERMISSION_POLICY_MAX_KEY_LENGTH` characters. */
export interface AcpPermissionPolicy {
  autoApprove: AcpPermissionAutoApprove;
  toolDecisions: Record<string, AcpPermissionToolDecision>;
}

/** GET the project's ACP permission policy. Absent policy resolves server-side
 *  to `{ autoApprove: 'none', toolDecisions: {} }` (the conservative floor). */
export async function getAcpPermissionPolicy(projectId: string) {
  return unwrap(
    await backendApi.get<AcpPermissionPolicy>(`/projects/${projectId}/acp/permission-policy`),
  );
}

/** PUT the project's ACP permission policy. The server 422s unknown keys/
 *  values or an oversize `toolDecisions` map, and 403s without
 *  `project.customize.write` — see the route for the exact validation. */
export async function putAcpPermissionPolicy(projectId: string, policy: AcpPermissionPolicy) {
  return unwrap(
    await backendApi.put<AcpPermissionPolicy>(`/projects/${projectId}/acp/permission-policy`, policy),
  );
}

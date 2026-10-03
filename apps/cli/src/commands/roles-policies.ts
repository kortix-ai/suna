/**
 * `kortix roles assignments | assign | unassign` — the LEGACY policy store
 * verbs. Binding a role to a principal is `kortix access grant`, which writes
 * the ONE grant table; these verbs still write the policy store, which
 * dual-writes into the same table, so they keep working, but new work should
 * use `kortix access`. Split out of roles.ts beside the export/import port.
 */

import type { ApiClient } from '../api/client.ts';
import { emitJson, fail, missing } from '../command-helpers.ts';
import { type IamRole, findRole } from '../iam.ts';
import { C, pad, status } from '../style.ts';

type PrincipalType = 'member' | 'group' | 'token';

export interface IamPolicy {
  policy_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: string;
  scope_id: string | null;
  role_id: string;
  effect: 'allow' | 'deny';
  expires_at?: string | null;
  created_at: string;
}

/** What every roles handler receives: the resolved account context, the IAM
 *  base path, and the parsed flags/positionals of the invocation. */
export interface RolesCall {
  ctx: { client: ApiClient };
  base: string;
  json: boolean;
  positional: string[];
  f: Record<string, string | undefined>;
  clearDesc: boolean;
}

export function notFound(what: string): number {
  process.stderr.write(`${status.err(`No ${what} in this account. Try \`kortix roles ls\`.`)}\n`);
  return 1;
}
export async function rolesAssignments(call: RolesCall): Promise<number> {
  const { ctx, base, json, positional, f, clearDesc } = call;
  const qs = f.project ? `?scopeType=project&scopeId=${encodeURIComponent(f.project)}` : '';
  const { policies } = await ctx.client.get<{ policies: IamPolicy[] }>(`${base}/policies${qs}`);
  if (json) return emitJson(policies), 0;
  // Map role_id → key for a readable column.
  const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const roleKey = new Map(roles.map((r) => [r.role_id, r.key]));
  if (policies.length === 0) {
    process.stdout.write(
      `  ${C.dim}No assignments${f.project ? ' on this project' : ''}.${C.reset}\n`,
    );
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}ROLE             PRINCIPAL                 SCOPE      POLICY ID${C.reset}\n`,
  );
  for (const p of policies) {
    const principal = `${p.principal_type}:${p.principal_id}`;
    const scope = p.scope_id ? `${p.scope_type}:${p.scope_id.slice(0, 8)}` : p.scope_type;
    process.stdout.write(
      `  ${pad(roleKey.get(p.role_id) ?? p.role_id, 16)} ${pad(principal, 25)} ${pad(scope, 10)} ${C.faded}${p.policy_id}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${policies.length} assignment${policies.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

export async function rolesAssign(call: RolesCall): Promise<number> {
  const { ctx, base, json, positional, f, clearDesc } = call;
  const ref = positional[0];
  if (!ref) return missing('a role key or id');
  if (!f.to) return missing('--to <type>:<id> (member:<id> | group:<id> | token:<id>)');
  const [principalType, ...idParts] = f.to.split(':');
  const principalId = idParts.join(':');
  if (!['member', 'group', 'token'].includes(principalType) || !principalId) {
    return fail('--to must be member:<id>, group:<id>, or token:<id>');
  }
  const { roles } = await ctx.client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  // Resolve scope: --project pins a project scope; otherwise --scope (default account).
  const scope = f.project
    ? { scopeType: 'project', scopeId: f.project as string | null }
    : { scopeType: f.scope ?? 'account', scopeId: null as string | null };
  const policy = await ctx.client.post<IamPolicy>(`${base}/policies`, {
    principalType,
    principalId,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    roleId: role.role_id,
    ...(f.expires ? { expires_at: f.expires } : {}),
  });
  process.stdout.write(
    `${status.ok(`Assigned ${C.bold}${role.key}${C.reset} → ${principalType}:${principalId} (${scope.scopeType}${scope.scopeId ? ` ${scope.scopeId}` : ''})  ${C.faded}${policy.policy_id}${C.reset}`)}\n`,
  );
  return 0;
}

export async function rolesUnassign(call: RolesCall): Promise<number> {
  const { ctx, base, json, positional, f, clearDesc } = call;
  const policyId = positional[0];
  if (!policyId) return missing('a policy id (see `kortix roles assignments`)');
  await ctx.client.delete(`${base}/policies/${encodeURIComponent(policyId)}`);
  process.stdout.write(`${status.ok(`Removed assignment ${C.bold}${policyId}${C.reset}`)}\n`);
  return 0;
}

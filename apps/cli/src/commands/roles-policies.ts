import type { ApiClient } from '../api/client.ts';
import { emitJson, fail, missing } from '../command-helpers.ts';
import { type IamRole, findRole } from '../iam.ts';
import { C, pad, status } from '../style.ts';

// The assignment-policy half of `kortix roles` — the legacy policy store the
// `assignments` / `assign` / `unassign` verbs read and write. It dual-writes
// into the one grant table, so it keeps working, but new work should use
// `kortix access grant`. Split out of roles.ts (KRTX-1334); roles.ts imports
// `notFound` and the `IamPolicy` shape from here.

type PrincipalType = 'member' | 'group' | 'token';

/** One row of the legacy policy store (`GET /iam/policies`). */
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

/** `No <what> in this account` — the shared not-found exit for a role ref. */
export function notFound(what: string): number {
  process.stderr.write(`${status.err(`No ${what} in this account. Try \`kortix roles ls\`.`)}\n`);
  return 1;
}

// ── roles assignments ──────────────────────────────────────────────────────

export async function rolesAssignments(
  client: ApiClient,
  base: string,
  project: string | undefined,
  json: boolean,
): Promise<number> {
  const qs = project ? `?scopeType=project&scopeId=${encodeURIComponent(project)}` : '';
  const { policies } = await client.get<{ policies: IamPolicy[] }>(`${base}/policies${qs}`);
  if (json) return emitJson(policies), 0;
  // Map role_id → key for a readable column.
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const roleKey = new Map(roles.map((r) => [r.role_id, r.key]));
  if (policies.length === 0) {
    process.stdout.write(
      `  ${C.dim}No assignments${project ? ' on this project' : ''}.${C.reset}\n`,
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

// ── roles assign ───────────────────────────────────────────────────────────

export async function rolesAssign(
  client: ApiClient,
  base: string,
  ref: string | undefined,
  to: string | undefined,
  project: string | undefined,
  scopeArg: string | undefined,
  expires: string | undefined,
): Promise<number> {
  if (!ref) return missing('a role key or id');
  if (!to) return missing('--to <type>:<id> (member:<id> | group:<id> | token:<id>)');
  const [principalType, ...idParts] = to.split(':');
  const principalId = idParts.join(':');
  if (!['member', 'group', 'token'].includes(principalType) || !principalId) {
    return fail('--to must be member:<id>, group:<id>, or token:<id>');
  }
  const { roles } = await client.get<{ roles: IamRole[] }>(`${base}/roles`);
  const role = findRole(roles, ref);
  if (!role) return notFound(`role "${ref}"`);
  // Resolve scope: --project pins a project scope; otherwise --scope (default account).
  const scope = project
    ? { scopeType: 'project', scopeId: project as string | null }
    : { scopeType: scopeArg ?? 'account', scopeId: null as string | null };
  const policy = await client.post<IamPolicy>(`${base}/policies`, {
    principalType,
    principalId,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    roleId: role.role_id,
    ...(expires ? { expires_at: expires } : {}),
  });
  process.stdout.write(
    `${status.ok(`Assigned ${C.bold}${role.key}${C.reset} → ${principalType}:${principalId} (${scope.scopeType}${scope.scopeId ? ` ${scope.scopeId}` : ''})  ${C.faded}${policy.policy_id}${C.reset}`)}\n`,
  );
  return 0;
}

// ── roles unassign ─────────────────────────────────────────────────────────

export async function rolesUnassign(
  client: ApiClient,
  base: string,
  policyId: string | undefined,
): Promise<number> {
  if (!policyId) return missing('a policy id (see `kortix roles assignments`)');
  await client.delete(`${base}/policies/${encodeURIComponent(policyId)}`);
  process.stdout.write(`${status.ok(`Removed assignment ${C.bold}${policyId}${C.reset}`)}\n`);
  return 0;
}

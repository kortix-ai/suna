// The canonical RBAC vocabulary, once, for every CLI command that touches it.
//
// ONE grant table (`role_assignments`), ONE write path
// (`POST /accounts/:id/iam/assignments`), ONE catalog
// (`GET /accounts/:id/iam/permissions`). `kortix access`, `kortix roles` and
// `kortix permissions` all speak it through this module rather than each
// carrying its own principal/scope/role vocabulary — which is exactly the
// duplication the refactor deleted on the server.
//
// The rule the help text states everywhere: people, groups and service accounts
// get ROLES; agents get Kortix CLI SCOPES in kortix.yaml. A session can only do
// what both allow.
import type { ApiClient } from './api/client.ts';
import { status } from './style.ts';

/** `role_assignments.principal_type`. */
export const PRINCIPAL_TYPES = ['user', 'group', 'service_account', 'pending'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/** `role_assignments.scope_type` / `permissions.scope_type`. */
export const SCOPE_TYPES = ['account', 'project'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** `role_assignments.object_type` — an assignment narrowed to ONE object. */
export const OBJECT_TYPES = ['agent', 'skill', 'secret', 'app', 'trigger'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * The marker role an object assignment carries. It grants nothing on its own —
 * the object grant is what opens the object; the caller still needs the action
 * at the scope. Seeded system role, project scope.
 */
export const OBJECT_GRANT_ROLE = 'agent-user';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IamRole {
  role_id: string;
  key: string;
  name: string;
  description: string | null;
  /** account | project — the scope a role can be assigned at. */
  resource_type: string;
  is_system: boolean;
  account_id: string | null;
}

export interface IamAssignment {
  assignment_id: string;
  account_id: string;
  principal_type: string;
  principal_id: string;
  role_id: string;
  role_key: string;
  role_is_system: boolean;
  scope_type: string;
  scope_id: string | null;
  object_type: string | null;
  object_id: string | null;
  expires_at: string | null;
  granted_by: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface IamPermission {
  action: string;
  scope_type: string;
  resource_type: string;
  delegable: boolean;
  description: string;
  area: string;
  level: string;
  implies: string[];
}

export interface AccountMemberRow {
  user_id: string;
  email: string | null;
}

export interface GroupRow {
  group_id: string;
  name: string;
}

/** `/accounts/<id>/iam` — the base every canonical RBAC route hangs off. */
export function iamBase(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/iam`;
}

export async function fetchRoles(client: ApiClient, accountId: string): Promise<IamRole[]> {
  const { roles } = await client.get<{ roles: IamRole[] }>(`${iamBase(accountId)}/roles`);
  return roles;
}

export function findRole(roles: IamRole[], ref: string): IamRole | undefined {
  return roles.find((r) => r.key === ref || r.role_id === ref);
}

/**
 * The role half of a `POST /iam/assignments` body, from `--role <key|id>`.
 *
 * A SYSTEM role goes by KEY, never by id: `GET /iam/roles` still serves the
 * built-in presets under synthetic `builtin:<key>` ids, which the assignment
 * route cannot resolve. A CUSTOM role has a real id, so use it.
 *
 * A key the catalog route does not list is still sent as `role_key`. That
 * route's preset table has already drifted from the seeded system rows — it
 * omits `agent-user` and calls the project floor role `user` where the engine
 * calls it `member` — so refusing here would block valid grants and accept
 * invalid ones. The server owns which keys exist, and says so precisely
 * (`unknown system role "project:user"`).
 */
export function roleRefBody(roles: IamRole[], ref: string): { role_key: string } | { role_id: string } {
  const hit = findRole(roles, ref);
  if (hit) return hit.is_system ? { role_key: hit.key } : { role_id: hit.role_id };
  if (UUID_RE.test(ref)) return { role_id: ref };
  return { role_key: ref };
}

/**
 * Resolve a member reference to a user id. A uuid passes through; anything else
 * is matched against the account member directory by email. The directory is
 * visible to every member of the account, so this needs no extra permission.
 */
export async function resolveUserId(
  client: ApiClient,
  accountId: string,
  who: string,
): Promise<string | null> {
  if (UUID_RE.test(who)) return who;
  const members = await client.get<AccountMemberRow[]>(
    `/accounts/${encodeURIComponent(accountId)}/members`,
  );
  const needle = who.trim().toLowerCase();
  const hit = members.find((m) => (m.email ?? '').toLowerCase() === needle);
  if (!hit) {
    process.stderr.write(
      `${status.err(`No member with email "${who}" in this account.`)} ` +
        `Invite them first, or pass a user id.\n`,
    );
    return null;
  }
  return hit.user_id;
}

/** user-id → email and group-id → name, for readable listings. Best effort:
 *  a caller without `group.read` still gets the ids. */
export async function principalLabels(
  client: ApiClient,
  accountId: string,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const [members, groups] = await Promise.all([
    client
      .get<AccountMemberRow[]>(`/accounts/${encodeURIComponent(accountId)}/members`)
      .catch(() => [] as AccountMemberRow[]),
    client
      .get<{ groups: GroupRow[] }>(`${iamBase(accountId)}/groups`)
      .then((r) => r.groups)
      .catch(() => [] as GroupRow[]),
  ]);
  for (const m of members) if (m.email) labels.set(m.user_id, m.email);
  for (const g of groups) labels.set(g.group_id, g.name);
  return labels;
}

/** `user:alice@corp.com`, `group:Engineering`, or the raw id when unlabelled. */
export function principalLabel(a: IamAssignment, labels: Map<string, string>): string {
  const label = labels.get(a.principal_id) ?? a.principal_id;
  return `${a.principal_type}:${label}`;
}

/** `account`, `project:<id>` — what the assignment covers. */
export function scopeLabel(a: IamAssignment): string {
  return a.scope_id ? `${a.scope_type}:${a.scope_id.slice(0, 8)}` : a.scope_type;
}

/** `agent:research`, or `—` for a whole-scope assignment. */
export function objectLabel(a: IamAssignment): string {
  return a.object_type && a.object_id ? `${a.object_type}:${a.object_id}` : '—';
}

/** `2026-09-01`, or `never`. */
export function expiresLabel(a: IamAssignment): string {
  return a.expires_at ? a.expires_at.slice(0, 10) : 'never';
}

/** Parse `--principal <id>` or `--principal <type>:<id>` into a filter pair. */
export function parsePrincipalFilter(
  raw: string,
): { type: PrincipalType; id: string } | { error: string } {
  const idx = raw.indexOf(':');
  if (idx < 0) {
    // Bare id — a user, which is what every interactive caller means.
    return { type: 'user', id: raw };
  }
  const type = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!(PRINCIPAL_TYPES as readonly string[]).includes(type) || !id) {
    return { error: `--principal must be <id> or one of ${PRINCIPAL_TYPES.join('|')}:<id>` };
  }
  return { type: type as PrincipalType, id };
}

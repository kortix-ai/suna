/**
 * Who may USE one project secret value — its audience.
 *
 * Same store and same shape as a shared connector account's audience
 * (`connection-audience.ts`): `secret` object grants in `kortix.role_assignments`,
 * keyed by `project_secrets.secret_id`, written through `assignRole`. A value
 * with no grant is usable by everyone in the project, which is what every
 * secret meant before audiences existed.
 *
 * THE rule. A narrowed value reaches only a person in its audience, and only
 * while that person is the one acting:
 *
 *   - a session: the session's `on_behalf_of` human, and only when the session
 *     is `private`. A shared session, a trigger, cron, a webhook, an email or
 *     Telegram message, a foreign prompt (which clears `on_behalf_of`) — none of
 *     them has a person, so none of them gets a narrowed value;
 *   - no session: the acting user. A service account id is never named by a
 *     user or group grant, so it gets only values shared with everyone;
 *   - no actor at all (git proxy, channel installs, app deployments, the
 *     catalog sync): values shared with everyone only.
 *
 * Several values may share one env KEY. A value the person is IN the audience
 * of wins over one shared with everyone (`secretAudienceRank`, grant-policy.ts).
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { assignRole, revokeAssignment, SYSTEM_ACTOR } from '../../iam/assignments';
import { loadObjectGrants } from '../../iam/authorize';
import { objectGrantRows } from '../../iam/read-models';
import { db } from '../../shared/db';
import type { ConnectionAudienceReach } from './connection-access';
import { loadSecretAudience } from './connection-audience';
import { resolveSessionPersonalOwner } from './personal-resources';

/** The person whose audience membership may admit a narrowed value, or null. */
export async function secretAudiencePerson(input: {
  projectId: string;
  accountId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
}): Promise<string | null> {
  if (!input.sessionId) return input.actorUserId ?? null;
  return resolveSessionPersonalOwner({
    projectId: input.projectId,
    sessionId: input.sessionId,
    accountId: input.accountId ?? null,
    legacyUserId: null,
    strict: true,
  });
}

/**
 * Keep the values the person may use; each kept row carries its reach. A
 * project with no `secret` grant answers from one grant read and never looks
 * up the account or the person's groups.
 */
export async function filterSecretRowsByAudience<T extends { secretId: string }>(input: {
  projectId: string;
  accountId?: string | null;
  /** A function is called only when the project has a `secret` grant. */
  personId: string | null | (() => Promise<string | null>);
  rows: readonly T[];
}): Promise<Array<T & { audience: Exclude<ConnectionAudienceReach, 'out'> }>> {
  const open = () => input.rows.map((row) => ({ ...row, audience: 'open' as const }));
  if (input.rows.length === 0) return [];
  const grants = await loadObjectGrants(input.projectId, 'secret');
  if (grants.size === 0) return open();
  const accountId =
    input.accountId ??
    (
      await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, input.projectId))
        .limit(1)
    )[0]?.accountId;
  // No account = no way to resolve groups: keep only values nobody narrowed.
  const personId = typeof input.personId === 'function' ? await input.personId() : input.personId;
  const reachOf = accountId
    ? await loadSecretAudience({ projectId: input.projectId, accountId, userId: personId })
    : (secretId: string) => (grants.has(secretId) ? ('out' as const) : ('open' as const));
  const kept: Array<T & { audience: Exclude<ConnectionAudienceReach, 'out'> }> = [];
  for (const row of input.rows) {
    const audience = reachOf(row.secretId);
    if (audience !== 'out') kept.push({ ...row, audience });
  }
  return kept;
}

export interface SecretAudiencePrincipal {
  principal_type: 'user' | 'group';
  principal_id: string;
}

/**
 * Make one shared value's audience exactly `principals`; `[]` = everyone in
 * the project. Grants are written BEFORE revokes, so the value never widens to
 * everyone between two writes. The caller has already authorized the change
 * (`project.secret.write`, a person — never an agent session).
 *
 * `pending`: the row does not exist yet — `POST /secrets` writes the audience
 * first, then inserts the row under `secretId`.
 */
export async function setSecretAudience(input: {
  accountId: string;
  projectId: string;
  secretId: string;
  principals: readonly SecretAudiencePrincipal[];
  grantedBy: string;
  pending?: boolean;
}): Promise<void> {
  const wanted = new Map(input.principals.map((p) => [`${p.principal_type}:${p.principal_id}`, p]));
  const current = (await objectGrantRows({ accountId: input.accountId, projectId: input.projectId })).filter(
    (grant) => grant.resourceType === 'secret' && grant.resourceId === input.secretId,
  );
  const key = (grant: (typeof current)[number]) =>
    `${grant.principalType === 'member' ? 'user' : grant.principalType}:${grant.principalId}`;
  const held = new Set(current.map(key));
  for (const [k, principal] of wanted) {
    if (held.has(k)) continue;
    await assignRole(SYSTEM_ACTOR, input.accountId, {
      principal: { type: principal.principal_type, id: principal.principal_id },
      roleKey: 'agent-user',
      scope: { type: 'project', id: input.projectId },
      object: { type: 'secret', id: input.secretId },
      grantedBy: input.grantedBy,
      ...(input.pending ? { pendingSecretId: input.secretId } : {}),
    });
  }
  for (const grant of current) {
    if (!wanted.has(key(grant))) await revokeAssignment(SYSTEM_ACTOR, input.accountId, grant.grantId);
  }
}

/** Remove every audience grant of one value — on delete, so no dead grant remains. */
export async function clearSecretAudience(input: {
  accountId: string;
  projectId: string;
  secretId: string;
}): Promise<void> {
  if (!(await loadObjectGrants(input.projectId, 'secret')).has(input.secretId)) return;
  const current = (await objectGrantRows({ accountId: input.accountId, projectId: input.projectId })).filter(
    (grant) => grant.resourceType === 'secret' && grant.resourceId === input.secretId,
  );
  for (const grant of current) await revokeAssignment(SYSTEM_ACTOR, input.accountId, grant.grantId);
}

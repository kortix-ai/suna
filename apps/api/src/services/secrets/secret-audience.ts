/**
 * Who may USE one project secret value — its audience.
 *
 * Same store and same shape as a shared connector account's audience
 * (`connection-audience.ts`): `secret` object grants in `kortix.role_assignments`,
 * keyed by `project_secrets.secret_id`, written through `assignRole`. A value
 * with no grant is usable by everyone in the project, which is what every
 * secret meant before audiences existed.
 *
 * Principals: people, groups, AGENTS (an agent's service account), or the
 * project. A session acts as two subjects at once:
 *
 *   - its AGENT, always. A value shared with the agent reaches every session of
 *     that agent — triggers, schedules and shared sessions included. Whoever
 *     may run the agent can therefore use the value through it; running an
 *     agent is itself gated (`agent` object grants, closed by default).
 *   - its PERSON, the session's `on_behalf_of` human, and only while the
 *     session is `private`. A shared session, a trigger, cron, a webhook, an
 *     email or Telegram message, a foreign prompt (which clears
 *     `on_behalf_of`) — none of them has a person.
 *
 * No session: the acting principal is both subjects (a person's id never
 * matches an agent grant, and an agent's never matches a user grant). No actor
 * at all (git proxy, channel installs, app deployments, the catalog sync):
 * values shared with everyone only.
 *
 * Several values may share one env KEY. Reached through the person beats
 * reached through the agent beats shared with everyone (`secretAudienceRank`,
 * grant-policy.ts).
 */
// `services/secrets/secrets.ts` imports this module, and so does nearly every suite.
// Suites stub `iam/*`, `@kortix/db` and `personal-resources` with explicit
// export lists, so every IAM collaborator here loads lazily: a static edge to
// `services/iam/authorize` alone pulls `services/iam/actor` into graphs that stub it.
import { sql } from 'drizzle-orm';
import { db } from '../../lib/db';

/** How a kept value reaches the caller. */
export type SecretReach = 'person' | 'agent' | 'open';

/** Who a read acts as. Null fields mean "nobody of that kind". */
export interface SecretAudienceSubject {
  personId: string | null;
  /** The agent's service-account id. */
  agentId: string | null;
}

export const NO_SUBJECT: SecretAudienceSubject = { personId: null, agentId: null };

interface AudienceGrant {
  principalType: string;
  principalId: string;
}

/** One value's grants, resolved for one subject. Pure. */
export function secretReachOf(
  grants: readonly AudienceGrant[] | undefined,
  subject: { personId: string | null; groupIds: ReadonlySet<string>; agentId: string | null },
): SecretReach | 'out' {
  if (!grants || grants.length === 0) return 'open';
  if (grants.some((grant) => grant.principalType === 'project')) return 'open';
  if (
    subject.personId &&
    grants.some(
      (grant) =>
        (grant.principalType === 'user' && grant.principalId === subject.personId) ||
        (grant.principalType === 'group' && subject.groupIds.has(grant.principalId)),
    )
  ) {
    return 'person';
  }
  if (
    subject.agentId &&
    grants.some((grant) => grant.principalType === 'service_account' && grant.principalId === subject.agentId)
  ) {
    return 'agent';
  }
  return 'out';
}

/** Who a session — or, without one, the direct caller — acts as. */
export async function secretAudienceSubject(input: {
  projectId: string;
  accountId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
}): Promise<SecretAudienceSubject> {
  if (!input.sessionId) {
    const actor = input.actorUserId ?? null;
    return { personId: actor, agentId: actor };
  }
  const { resolveSessionPersonalOwner } = await import('../projects/lib/personal-resources');
  const [personId, agentId] = await Promise.all([
    resolveSessionPersonalOwner({
      projectId: input.projectId,
      sessionId: input.sessionId,
      accountId: input.accountId ?? null,
      legacyUserId: null,
      strict: true,
    }),
    sessionAgentId(input.sessionId),
  ]);
  return { personId, agentId };
}

/**
 * Keep the values the subject may use; each kept row carries its reach. A
 * project with no `secret` grant answers from one grant read and never looks
 * up the account, the session, or the person's groups.
 */
export async function filterSecretRowsByAudience<T extends { secretId: string }>(input: {
  projectId: string;
  accountId?: string | null;
  /** A function is called only when the project has a `secret` grant. */
  subject: SecretAudienceSubject | (() => Promise<SecretAudienceSubject>);
  rows: readonly T[];
}): Promise<Array<T & { audience: SecretReach }>> {
  if (input.rows.length === 0) return [];
  const { loadObjectGrants } = await import('../iam/authorize');
  const grants = await loadObjectGrants(input.projectId, 'secret');
  if (grants.size === 0) return input.rows.map((row) => ({ ...row, audience: 'open' as const }));
  const reachOf = await loadSecretReach({
    projectId: input.projectId,
    accountId: input.accountId ?? null,
    subject: typeof input.subject === 'function' ? await input.subject() : input.subject,
  });
  const kept: Array<T & { audience: SecretReach }> = [];
  for (const row of input.rows) {
    const audience = reachOf(row.secretId);
    if (audience !== 'out') kept.push({ ...row, audience });
  }
  return kept;
}

/** Every value's reach in one project, for one subject. */
export async function loadSecretReach(input: {
  projectId: string;
  accountId: string | null;
  subject: SecretAudienceSubject;
}): Promise<(secretId: string) => SecretReach | 'out'> {
  const iamAuthorize = await import('../iam/authorize');
  const grants = await iamAuthorize.loadObjectGrants(input.projectId, 'secret');
  if (grants.size === 0) return () => 'open';
  const accountId = input.accountId ?? (await projectAccountId(input.projectId));
  // No account = no way to resolve groups: a group grant then reaches nobody.
  const record =
    accountId && input.subject.personId
      ? await iamAuthorize.resolvePrincipal({ type: 'user', id: input.subject.personId }, accountId)
      : null;
  const subject = { ...input.subject, groupIds: new Set(record?.groupIds ?? []) };
  return (secretId) => secretReachOf(grants.get(secretId), subject);
}

/**
 * The narrowed values that entered this session's sandbox as PLAINTEXT through
 * its person — the ones another viewer could read if the session were shared.
 * Values reached through the agent stay reachable after a share by design, and
 * handle-delivered values (egress, broker) are re-checked per request, so
 * neither is listed. Sharing the session is refused while this is non-empty.
 */
export async function sessionPersonOnlyPlaintextSecrets(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
}): Promise<string[]> {
  const { loadObjectGrants } = await import('../iam/authorize');
  if ((await loadObjectGrants(input.projectId, 'secret')).size === 0) return [];
  const subject = await secretAudienceSubject(input);
  if (!subject.personId) return [];
  const { listSessionDeliveredSecretRows } = await import('./network-secret-boundary');
  const rows = await listSessionDeliveredSecretRows(input.projectId, input.sessionId, subject);
  return rows
    .filter((row) => row.audience === 'person' && (row.strategy ?? 'runtime') === 'runtime')
    .map((row) => row.identifier)
    .sort();
}

export interface SecretAudiencePrincipal {
  principal_type: 'user' | 'group' | 'agent';
  /** A user id, a group id, or an agent's service-account id. */
  principal_id: string;
}

const ROLE_PRINCIPAL = { user: 'user', group: 'group', agent: 'service_account' } as const;

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
  const assignments = await import('../iam/assignments');
  const wanted = new Map(
    input.principals.map((p) => [`${ROLE_PRINCIPAL[p.principal_type]}:${p.principal_id}`, p]),
  );
  const current = await currentSecretGrants(input);
  const key = (grant: (typeof current)[number]) =>
    `${grant.principalType === 'member' ? 'user' : grant.principalType}:${grant.principalId}`;
  const held = new Set(current.map(key));
  for (const [k, principal] of wanted) {
    if (held.has(k)) continue;
    await assignments.assignRole(assignments.SYSTEM_ACTOR, input.accountId, {
      principal: { type: ROLE_PRINCIPAL[principal.principal_type], id: principal.principal_id },
      roleKey: 'agent-user',
      scope: { type: 'project', id: input.projectId },
      object: { type: 'secret', id: input.secretId },
      grantedBy: input.grantedBy,
      ...(input.pending ? { pendingSecretId: input.secretId } : {}),
    });
  }
  for (const grant of current) {
    if (!wanted.has(key(grant))) {
      await assignments.revokeAssignment(assignments.SYSTEM_ACTOR, input.accountId, grant.grantId);
    }
  }
}

/** Remove every audience grant of one value — on delete, so no dead grant remains. */
export async function clearSecretAudience(input: {
  accountId: string;
  projectId: string;
  secretId: string;
}): Promise<void> {
  const { loadObjectGrants } = await import('../iam/authorize');
  if (!(await loadObjectGrants(input.projectId, 'secret')).has(input.secretId)) return;
  const assignments = await import('../iam/assignments');
  for (const grant of await currentSecretGrants(input)) {
    await assignments.revokeAssignment(assignments.SYSTEM_ACTOR, input.accountId, grant.grantId);
  }
}

async function currentSecretGrants(input: { accountId: string; projectId: string; secretId: string }) {
  const { objectGrantRows } = await import('../iam/read-models');
  return (
    await objectGrantRows({ accountId: input.accountId, projectId: input.projectId, includeServiceAccounts: true })
  ).filter((grant) => grant.resourceType === 'secret' && grant.resourceId === input.secretId);
}

/** The agent service account a session acts as, or null: the one its live
 *  token names, else the standing identity of the session's `agent_name`. The
 *  fallback covers the first boot, whose env is built before the token is
 *  minted. Raw SQL, for the same stubbed-`@kortix/db` reason as `projectAccountId`. */
export async function sessionAgentId(sessionId: string): Promise<string | null> {
  const result = await db.execute<{ service_account_id: string }>(sql`
    select service_account_id from (
      select service_account_id, 0 as pick, created_at from kortix.account_tokens
       where session_id = ${sessionId} and status = 'active' and revoked_at is null
         and service_account_id is not null
      union all
      select sa.service_account_id, 1 as pick, sa.created_at
        from kortix.project_sessions s
        join kortix.service_accounts sa
          on sa.account_id = s.account_id and sa.project_id = s.project_id
         and sa.agent_name = s.agent_name and sa.status = 'active'
       where s.session_id = ${sessionId}
    ) candidates
    order by pick, created_at desc limit 1`);
  const rows = (result as unknown as { rows?: Array<{ service_account_id: string }> }).rows ?? result;
  return (rows as Array<{ service_account_id: string }>)[0]?.service_account_id ?? null;
}

/** Raw SQL, not the `projects` table object: suites stub `@kortix/db` with an
 *  explicit export list, and a new named import there fails them at link time. */
async function projectAccountId(projectId: string): Promise<string | null> {
  const result = await db.execute<{ account_id: string }>(
    sql`select account_id from kortix.projects where project_id = ${projectId}::uuid limit 1`,
  );
  const rows = (result as unknown as { rows?: Array<{ account_id: string }> }).rows ?? result;
  return (rows as Array<{ account_id: string }>)[0]?.account_id ?? null;
}

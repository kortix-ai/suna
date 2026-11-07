// Service-account CRUD + bearer validation. SAs are first-class
// non-human IAM principals owned by the account itself; policies attach
// via principal_type='token' with principal_id = service_account_id so
// the existing IAM engine token-path handles authorisation unchanged.

import { and, asc, eq, gt, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { serviceAccounts, roleAssignments } from '@kortix/db';
import { notAnAudienceGrant } from '../iam/audience-grants';
import { db } from '../shared/db';
import { errorSqlstate } from '../shared/error-cause';
import { isUuid } from '../shared/validate';
import { createLastUsedTracker } from '../shared/throttled-last-used';
import { candidateSecretKeyHashesAsync, markTokenValidated } from '../shared/token-hash';
import {
  generateServiceAccountSecret,
  hashSecretKey,
  isApiKeySecretConfigured,
  isServiceAccountToken,
} from '../shared/crypto';

const updateLastUsedThrottled = createLastUsedTracker((saId) =>
  db.update(serviceAccounts).set({ lastUsedAt: new Date() }).where(eq(serviceAccounts.serviceAccountId, saId)),
);

export type ServiceAccount = {
  serviceAccountId: string;
  accountId: string;
  name: string;
  description: string | null;
  publicPrefix: string;
  status: 'active' | 'disabled';
  /** Set for an auto-provisioned agent identity (system-managed, not a
   *  human bearer SA). Null for a manually-created service account. */
  agentName: string | null;
  /** False for a bot whose own `kortix_sa_` bearer was never handed out: its
   *  credentials are workspace keys (`account_tokens.service_account_id`). */
  bearerIssued: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  disabledAt: Date | null;
  disabledBy: string | null;
};

export interface CreatedServiceAccount extends ServiceAccount {
  /** Plaintext bearer — shown ONCE at create. Never returned again. */
  secret: string;
}

function mapRow(r: typeof serviceAccounts.$inferSelect): ServiceAccount {
  return {
    serviceAccountId: r.serviceAccountId,
    accountId: r.accountId,
    name: r.name,
    description: r.description,
    publicPrefix: r.publicPrefix,
    status: r.status as 'active' | 'disabled',
    agentName: r.agentName,
    bearerIssued: r.bearerIssued,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    disabledAt: r.disabledAt,
    disabledBy: r.disabledBy,
  };
}

export async function listServiceAccounts(accountId: string): Promise<ServiceAccount[]> {
  const rows = await db
    .select()
    .from(serviceAccounts)
    // Only human-managed bearer SAs. Auto-provisioned AGENT identities
    // (agent_name set) are system-managed — they carry no usable bearer and are
    // governed via the Roles UI, so they must not appear in (or be deletable
    // from) the bearer-SA management card (deleting one CASCADE-kills live agent
    // sessions). isNull keeps them out.
    .where(and(eq(serviceAccounts.accountId, accountId), isNull(serviceAccounts.agentName)))
    .orderBy(asc(serviceAccounts.name));
  return rows.map(mapRow);
}

/**
 * A bot of the account (a service account that is not an agent identity), by
 * its id or its exact name. Null when none matches.
 */
export async function findBotServiceAccount(accountId: string, ref: string): Promise<ServiceAccount | null> {
  const [row] = await db
    .select()
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, accountId),
        isNull(serviceAccounts.agentName),
        isUuid(ref) ? or(eq(serviceAccounts.serviceAccountId, ref), eq(serviceAccounts.name, ref)) : eq(serviceAccounts.name, ref),
      ),
    )
    .limit(1);
  return row ? mapRow(row) : null;
}

/** The agent identity service account of (account, workspace, agent), or null when none exists yet. */
export async function findAgentServiceAccount(
  accountId: string,
  projectId: string,
  agentName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.projectId, projectId),
        eq(serviceAccounts.agentName, agentName),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export async function getServiceAccount(
  accountId: string,
  serviceAccountId: string,
): Promise<ServiceAccount | null> {
  const [row] = await db
    .select()
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.serviceAccountId, serviceAccountId),
      ),
    )
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function createServiceAccount(args: {
  accountId: string;
  name: string;
  description?: string | null;
  expiresAt?: Date | null;
  createdBy: string;
  /** False: a bot for workspace keys. Its own bearer is generated and the
   *  plaintext discarded (`secret` is empty), so only its keys authenticate. */
  issueBearer?: boolean;
}): Promise<CreatedServiceAccount> {
  if (!isApiKeySecretConfigured()) {
    throw new Error('API_KEY_SECRET not configured');
  }
  const { secret, publicPrefix } = generateServiceAccountSecret();
  const secretHash = hashSecretKey(secret);

  const [row] = await db
    .insert(serviceAccounts)
    .values({
      accountId: args.accountId,
      name: args.name,
      description: args.description ?? null,
      secretHash,
      publicPrefix,
      expiresAt: args.expiresAt ?? null,
      createdBy: args.createdBy,
      bearerIssued: args.issueBearer !== false,
    })
    .returning();
  if (!row) throw new Error('failed to create service account');
  return { ...mapRow(row), secret: args.issueBearer === false ? '' : secret };
}

/** A service account's status and expiry, or null when it is not in the account. Throws when the read fails. */
export async function readServiceAccountState(
  accountId: string,
  serviceAccountId: string,
): Promise<{ status: string; expiresAt: Date | null } | null> {
  const [row] = await db
    .select({ status: serviceAccounts.status, expiresAt: serviceAccounts.expiresAt })
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.accountId, accountId), eq(serviceAccounts.serviceAccountId, serviceAccountId)))
    .limit(1);
  return row ?? null;
}

/** True when `serviceAccountId` is a service account of `accountId` that is active and not expired. */
export async function isServiceAccountActive(accountId: string, serviceAccountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.serviceAccountId, serviceAccountId),
        eq(serviceAccounts.status, 'active'),
        or(isNull(serviceAccounts.expiresAt), gt(serviceAccounts.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Auto-provisioned AGENT identities (agent_name set), for the policy
 *  principal picker — an admin binds a role to one to promote that agent to a
 *  standing teammate. Distinct from listServiceAccounts (human bearer SAs). */
export async function listAgentServiceAccounts(
  accountId: string,
): Promise<Array<{ serviceAccountId: string; name: string; projectId: string | null; agentName: string | null }>> {
  return db
    .select({
      serviceAccountId: serviceAccounts.serviceAccountId,
      name: serviceAccounts.name,
      projectId: serviceAccounts.projectId,
      agentName: serviceAccounts.agentName,
    })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, accountId),
        isNotNull(serviceAccounts.agentName),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .orderBy(asc(serviceAccounts.name));
}

/**
 * Get-or-create the auto-provisioned STANDING IDENTITY for a kortix.yaml
 * `agents:` agent. Idempotent per (account, project, agent) via the partial
 * unique index. The returned SA id is stamped onto the session's account_token
 * (service_account_id) so the agent authorizes AS this identity.
 *
 * Identity-ONLY: a bearer secret is generated and the plaintext DISCARDED, so
 * the kortix_sa_ credential is unusable — the agent never presents it; it acts
 * via its session token. An admin assigns this SA a role in the Roles UI.
 */
export async function ensureAgentServiceAccount(args: {
  accountId: string;
  projectId: string;
  agentName: string;
  displayName?: string;
}): Promise<string> {
  const match = and(
    eq(serviceAccounts.accountId, args.accountId),
    eq(serviceAccounts.projectId, args.projectId),
    eq(serviceAccounts.agentName, args.agentName),
  );
  const existing = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(match)
    .limit(1);
  if (existing[0]) return existing[0].id;

  if (!isApiKeySecretConfigured()) {
    throw new Error('API_KEY_SECRET not configured');
  }
  const { secret, publicPrefix } = generateServiceAccountSecret();
  const secretHash = hashSecretKey(secret); // plaintext `secret` intentionally discarded — identity-only
  const name = (args.displayName ?? args.agentName).slice(0, 128);
  try {
    const [row] = await db
      .insert(serviceAccounts)
      .values({
        accountId: args.accountId,
        projectId: args.projectId,
        agentName: args.agentName,
        name,
        secretHash,
        publicPrefix,
        createdBy: null,
      })
      .returning({ id: serviceAccounts.serviceAccountId });
    if (row) return row.id;
  } catch (err) {
    // Lost a concurrent create race (unique violation) — fall through to re-read.
    // drizzle wraps the PostgresError, so read the SQLSTATE through the cause.
    if (errorSqlstate(err) !== '23505') throw err;
  }
  const [winner] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(match)
    .limit(1);
  if (!winner) throw new Error('failed to ensure agent service account');
  return winner.id;
}

export async function disableServiceAccount(args: {
  accountId: string;
  serviceAccountId: string;
  disabledBy: string;
}): Promise<boolean> {
  const rows = await db
    .update(serviceAccounts)
    .set({
      status: 'disabled',
      disabledAt: new Date(),
      disabledBy: args.disabledBy,
    })
    .where(
      and(
        eq(serviceAccounts.accountId, args.accountId),
        eq(serviceAccounts.serviceAccountId, args.serviceAccountId),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .returning({ serviceAccountId: serviceAccounts.serviceAccountId });
  return rows.length > 0;
}

export async function deleteServiceAccount(
  accountId: string,
  serviceAccountId: string,
): Promise<boolean> {
  // Atomically remove the SA and its standing-role bindings.
  // `role_assignments.principal_id` is polymorphic across user/group/
  // service_account/pending, so it carries no FK to service_accounts; without
  // this delete, a removed SA leaves dangling assignments behind that a re-used
  // id would inherit. Its audience grants stay and reach nobody: deleting a
  // value's last one would share it with the whole project.
  return db.transaction(async (tx) => {
    await tx
      .delete(roleAssignments)
      .where(
        and(
          eq(roleAssignments.accountId, accountId),
          eq(roleAssignments.principalType, 'service_account'),
          eq(roleAssignments.principalId, serviceAccountId),
          notAnAudienceGrant(),
        ),
      );
    const rows = await tx
      .delete(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.accountId, accountId),
          eq(serviceAccounts.serviceAccountId, serviceAccountId),
        ),
      )
      .returning({ serviceAccountId: serviceAccounts.serviceAccountId });
    return rows.length > 0;
  });
}

export interface ServiceAccountValidation {
  isValid: boolean;
  serviceAccountId?: string;
  accountId?: string;
  error?: string;
}

/**
 * Look up a service-account bearer. Returns the owning (account, SA id)
 * tuple on success. Throttled last_used_at updates for hot SAs.
 */
export async function validateServiceAccountToken(
  secret: string,
): Promise<ServiceAccountValidation> {
  if (!isApiKeySecretConfigured()) {
    return { isValid: false, error: 'API_KEY_SECRET not configured' };
  }
  if (!isServiceAccountToken(secret)) {
    return { isValid: false, error: 'Invalid SA format — expected kortix_sa_ prefix' };
  }
  try {
    const secretHashes = await candidateSecretKeyHashesAsync(secret);
    const [row] = await db
      .select({
        serviceAccountId: serviceAccounts.serviceAccountId,
        accountId: serviceAccounts.accountId,
        status: serviceAccounts.status,
        expiresAt: serviceAccounts.expiresAt,
        bearerIssued: serviceAccounts.bearerIssued,
      })
      .from(serviceAccounts)
      .where(inArray(serviceAccounts.secretHash, secretHashes))
      .limit(1);

    if (!row) return { isValid: false, error: 'Service account not found' };
    if (row.status !== 'active') return { isValid: false, error: 'Service account disabled' };
    // A bot for workspace keys never handed its own bearer out.
    if (row.bearerIssued === false) return { isValid: false, error: 'Service account not found' };
    if (row.expiresAt && row.expiresAt < new Date()) {
      return { isValid: false, error: 'Service account expired' };
    }

    markTokenValidated(secret);
    updateLastUsedThrottled(row.serviceAccountId).catch(() => {});

    return {
      isValid: true,
      serviceAccountId: row.serviceAccountId,
      accountId: row.accountId,
    };
  } catch (err) {
    console.error('SA validation error:', err);
    return { isValid: false, error: 'Validation error' };
  }
}

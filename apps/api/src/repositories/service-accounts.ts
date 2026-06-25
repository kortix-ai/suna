// Service-account CRUD + bearer validation. SAs are first-class
// non-human IAM principals owned by the account itself; policies attach
// via principal_type='token' with principal_id = service_account_id so
// the existing IAM engine token-path handles authorisation unchanged.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { serviceAccounts, iamPolicies } from '@kortix/db';
import { db } from '../shared/db';
import {
  generateServiceAccountSecret,
  hashSecretKey,
  candidateSecretKeyHashes,
  isApiKeySecretConfigured,
  isServiceAccountToken,
} from '../shared/crypto';

const THROTTLE_MS = 15 * 60 * 1000;
const lastUsedCache = new Map<string, number>();

export type ServiceAccount = {
  serviceAccountId: string;
  accountId: string;
  name: string;
  description: string | null;
  publicPrefix: string;
  status: 'active' | 'disabled';
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
    .where(eq(serviceAccounts.accountId, accountId))
    .orderBy(asc(serviceAccounts.name));
  return rows.map(mapRow);
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
    })
    .returning();
  if (!row) throw new Error('failed to create service account');
  return { ...mapRow(row), secret };
}

/**
 * Get-or-create the auto-provisioned STANDING IDENTITY for a kortix.toml
 * [[agents]] agent. Idempotent per (account, project, agent) via the partial
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
    if ((err as { code?: string })?.code !== '23505') throw err;
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
  // Atomically remove the SA and its standing-role bindings. iam_policies has no
  // FK to service_accounts (principal_id is polymorphic across member/group/token),
  // so without this a deleted SA leaves dangling token policies behind.
  return db.transaction(async (tx) => {
    await tx
      .delete(iamPolicies)
      .where(
        and(
          eq(iamPolicies.accountId, accountId),
          eq(iamPolicies.principalType, 'token'),
          eq(iamPolicies.principalId, serviceAccountId),
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
    const secretHashes = candidateSecretKeyHashes(secret);
    const [row] = await db
      .select({
        serviceAccountId: serviceAccounts.serviceAccountId,
        accountId: serviceAccounts.accountId,
        status: serviceAccounts.status,
        expiresAt: serviceAccounts.expiresAt,
      })
      .from(serviceAccounts)
      .where(inArray(serviceAccounts.secretHash, secretHashes))
      .limit(1);

    if (!row) return { isValid: false, error: 'Service account not found' };
    if (row.status !== 'active') return { isValid: false, error: 'Service account disabled' };
    if (row.expiresAt && row.expiresAt < new Date()) {
      return { isValid: false, error: 'Service account expired' };
    }

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

async function updateLastUsedThrottled(saId: string): Promise<void> {
  const now = Date.now();
  const last = lastUsedCache.get(saId) || 0;
  if (now - last < THROTTLE_MS) return;
  lastUsedCache.set(saId, now);
  if (lastUsedCache.size > 1000) {
    const cutoff = now - THROTTLE_MS * 2;
    for (const [k, v] of lastUsedCache.entries()) {
      if (v < cutoff) lastUsedCache.delete(k);
    }
  }
  try {
    await db
      .update(serviceAccounts)
      .set({ lastUsedAt: new Date() })
      .where(eq(serviceAccounts.serviceAccountId, saId));
  } catch (err) {
    console.warn('Failed to update service_accounts.last_used_at:', err);
  }
}

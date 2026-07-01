// Service-account CRUD + bearer validation. SAs are first-class
// non-human IAM principals owned by the account itself; policies attach
// via principal_type='token' with principal_id = service_account_id so
// the existing IAM engine token-path handles authorisation unchanged.

import { and, asc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { serviceAccounts, iamPolicies } from '@kortix/db';
import { Effect } from 'effect';
import { DatabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';
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
  /** Set for an auto-provisioned agent identity (system-managed, not a
   *  human bearer SA). Null for a manually-created service account. */
  agentName: string | null;
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
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    disabledAt: r.disabledAt,
    disabledBy: r.disabledBy,
  };
}

export async function listServiceAccounts(accountId: string): Promise<ServiceAccount[]> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const rows = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(serviceAccounts)
        // Only human-managed bearer SAs. Auto-provisioned AGENT identities
        // (agent_name set) are system-managed — they carry no usable bearer and are
        // governed via the Roles UI, so they must not appear in (or be deletable
        // from) the bearer-SA management card (deleting one CASCADE-kills live agent
        // sessions). isNull keeps them out.
        .where(and(eq(serviceAccounts.accountId, accountId), isNull(serviceAccounts.agentName)))
        .orderBy(asc(serviceAccounts.name)),
    );
    return rows.map(mapRow);
  }));
}

export async function getServiceAccount(
  accountId: string,
  serviceAccountId: string,
): Promise<ServiceAccount | null> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.accountId, accountId),
            eq(serviceAccounts.serviceAccountId, serviceAccountId),
          ),
        )
        .limit(1),
    );
    return row ? mapRow(row) : null;
  }));
}

export async function createServiceAccount(args: {
  accountId: string;
  name: string;
  description?: string | null;
  expiresAt?: Date | null;
  createdBy: string;
}): Promise<CreatedServiceAccount> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    if (!isApiKeySecretConfigured()) {
      throw new Error('API_KEY_SECRET not configured');
    }
    const { secret, publicPrefix } = generateServiceAccountSecret();
    const secretHash = hashSecretKey(secret);

    const [row] = yield* Effect.tryPromise(() =>
      database
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
        .returning(),
    );
    if (!row) throw new Error('failed to create service account');
    return { ...mapRow(row), secret };
  }));
}

/** Auto-provisioned AGENT identities (agent_name set), for the policy
 *  principal picker — an admin binds a role to one to promote that agent to a
 *  standing teammate. Distinct from listServiceAccounts (human bearer SAs). */
export async function listAgentServiceAccounts(
  accountId: string,
): Promise<Array<{ serviceAccountId: string; name: string; projectId: string | null; agentName: string | null }>> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    return yield* Effect.tryPromise(() =>
      database
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
        .orderBy(asc(serviceAccounts.name)),
    );
  }));
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
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const match = and(
      eq(serviceAccounts.accountId, args.accountId),
      eq(serviceAccounts.projectId, args.projectId),
      eq(serviceAccounts.agentName, args.agentName),
    );
    const existing = yield* Effect.tryPromise(() =>
      database
        .select({ id: serviceAccounts.serviceAccountId })
        .from(serviceAccounts)
        .where(match)
        .limit(1),
    );
    if (existing[0]) return existing[0].id;

    if (!isApiKeySecretConfigured()) {
      throw new Error('API_KEY_SECRET not configured');
    }
    const { secret, publicPrefix } = generateServiceAccountSecret();
    const secretHash = hashSecretKey(secret); // plaintext `secret` intentionally discarded — identity-only
    const name = (args.displayName ?? args.agentName).slice(0, 128);
    const inserted = yield* Effect.tryPromise(() =>
      database
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
        .returning({ id: serviceAccounts.serviceAccountId }),
    ).pipe(
      Effect.catchAll((err) => {
        // Lost a concurrent create race (unique violation) — fall through to re-read.
        if ((err as { code?: string })?.code === '23505') return Effect.succeed([]);
        return Effect.fail(err);
      }),
    );
    if (inserted[0]) return inserted[0].id;

    const [winner] = yield* Effect.tryPromise(() =>
      database
        .select({ id: serviceAccounts.serviceAccountId })
        .from(serviceAccounts)
        .where(match)
        .limit(1),
    );
    if (!winner) throw new Error('failed to ensure agent service account');
    return winner.id;
  }));
}

export async function disableServiceAccount(args: {
  accountId: string;
  serviceAccountId: string;
  disabledBy: string;
}): Promise<boolean> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const rows = yield* Effect.tryPromise(() =>
      database
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
        .returning({ serviceAccountId: serviceAccounts.serviceAccountId }),
    );
    return rows.length > 0;
  }));
}

export async function deleteServiceAccount(
  accountId: string,
  serviceAccountId: string,
): Promise<boolean> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    // Atomically remove the SA and its standing-role bindings. iam_policies has no
    // FK to service_accounts (principal_id is polymorphic across member/group/token),
    // so without this a deleted SA leaves dangling token policies behind.
    return yield* Effect.tryPromise(() =>
      database.transaction(async (tx) => {
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
      }),
    );
  }));
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
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    if (!isApiKeySecretConfigured()) {
      return { isValid: false, error: 'API_KEY_SECRET not configured' };
    }
    if (!isServiceAccountToken(secret)) {
      return { isValid: false, error: 'Invalid SA format — expected kortix_sa_ prefix' };
    }
    const secretHashes = candidateSecretKeyHashes(secret);
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({
          serviceAccountId: serviceAccounts.serviceAccountId,
          accountId: serviceAccounts.accountId,
          status: serviceAccounts.status,
          expiresAt: serviceAccounts.expiresAt,
        })
        .from(serviceAccounts)
        .where(inArray(serviceAccounts.secretHash, secretHashes))
        .limit(1),
    );

    if (!row) return { isValid: false, error: 'Service account not found' };
    if (row.status !== 'active') return { isValid: false, error: 'Service account disabled' };
    if (row.expiresAt && row.expiresAt < new Date()) {
      return { isValid: false, error: 'Service account expired' };
    }

    yield* Effect.forkDaemon(updateLastUsedThrottledEffect(row.serviceAccountId));

    return {
      isValid: true,
      serviceAccountId: row.serviceAccountId,
      accountId: row.accountId,
    };
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error('SA validation error:', err);
        return { isValid: false, error: 'Validation error' };
      }),
    ),
  ));
}

const updateLastUsedThrottledEffect = (saId: string) =>
  Effect.gen(function* () {
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
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(serviceAccounts)
        .set({ lastUsedAt: new Date() })
        .where(eq(serviceAccounts.serviceAccountId, saId)),
    ).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.warn('Failed to update service_accounts.last_used_at:', err);
        }),
      ),
    );
  });

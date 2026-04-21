import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { createApiKey } from '../../repositories/api-keys';
import {
  getProvider,
  getDefaultProviderName,
  type ProviderName,
} from '../providers';
import { config } from '../../config';
import { checkCredits } from '../../router/services/billing';
import * as pool from '../../pool';
import {
  buildSandboxInitAttemptMetadata,
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  retrySandboxProvisionCreate,
  SANDBOX_INIT_MAX_ATTEMPTS,
} from './sandbox-init-state';
import { registerCreator as ensureSandboxCreatorMember } from '../../teams';

export interface EnsureSandboxResult {
  row: typeof sandboxes.$inferSelect;
  created: boolean;
}

/**
 * Generate a unique sandbox name: sandbox-{accountPrefix}-{N}
 * Counts all existing sandboxes for the account to pick the next number.
 */
export async function generateSandboxName(accountId: string, customName?: string): Promise<string> {
  if (customName) return customName;
  const prefix = `sandbox-${accountId.slice(0, 8)}`;
  const count = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.accountId, accountId))
    .then((rows) => rows.length);
  return count > 0 ? `${prefix}-${count + 1}` : prefix;
}

export async function ensureSandbox(opts: {
  accountId: string;
  userId: string;
  provider?: ProviderName;
  serverType?: string;
  location?: string;
  isIncluded?: boolean;
}): Promise<EnsureSandboxResult> {
  const { accountId, userId } = opts;
  const providerName = opts.provider || getDefaultProviderName();

  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${accountId}))`);

  const existing = await findExistingSandbox(accountId);
  if (existing) return existing;

  const reactivated = await tryReactivateStaleSandbox(accountId);
  if (reactivated) return reactivated;

  await checkProviderCredits(providerName, accountId, opts.isIncluded);

  if (config.isPoolEnabled()) {
    const claimed = await tryClaimFromPool(accountId, userId, opts);
    if (claimed) return claimed;
  }

  return provisionNewSandbox(accountId, userId, providerName, opts);
}

async function findExistingSandbox(accountId: string): Promise<EnsureSandboxResult | null> {
  const [active] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.accountId, accountId), eq(sandboxes.status, 'active')))
    .limit(1);

  if (active) return { row: active, created: false };

  const [provisioning] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.accountId, accountId), eq(sandboxes.status, 'provisioning')))
    .limit(1);

  if (provisioning) return { row: provisioning, created: false };

  return null;
}

async function tryReactivateStaleSandbox(accountId: string): Promise<EnsureSandboxResult | null> {
  const [stale] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.accountId, accountId), inArray(sandboxes.status, ['stopped', 'archived'])))
    .orderBy(desc(sandboxes.updatedAt))
    .limit(1);

  if (!stale?.externalId) return null;

  try {
    const provider = getProvider(stale.provider);
    await provider.start(stale.externalId);

    const [reactivated] = await db
      .update(sandboxes)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(sandboxes.sandboxId, stale.sandboxId))
      .returning();

    return { row: reactivated, created: false };
  } catch (err) {
    console.warn(`[ensureSandbox] Failed to reactivate ${stale.sandboxId}:`, err);
    return null;
  }
}

async function checkProviderCredits(providerName: ProviderName, accountId: string, isIncluded?: boolean): Promise<void> {
  if (providerName === 'justavps' && config.KORTIX_BILLING_INTERNAL_ENABLED && !isIncluded) {
    const creditCheck = await checkCredits(accountId, 0.10);
    if (!creditCheck.hasCredits) {
      throw new Error(`Insufficient credits to provision managed VPS: ${creditCheck.message}`);
    }
  }
}

async function tryClaimFromPool(
  accountId: string,
  userId: string,
  opts: { serverType?: string; location?: string; isIncluded?: boolean },
): Promise<EnsureSandboxResult | null> {
  let claimed: Awaited<ReturnType<typeof pool.grab>> = null;
  try {
    claimed = await pool.grab({ serverType: opts.serverType, location: opts.location });
    if (!claimed) return null;

    const name = await generateSandboxName(accountId);
    const [row] = await db
      .insert(sandboxes)
      .values({
        accountId,
        name,
        provider: claimed.poolSandbox.provider,
        externalId: claimed.externalId,
        status: 'active',
        baseUrl: claimed.baseUrl,
        config: {},
        metadata: claimed.metadata,
        isIncluded: opts.isIncluded ?? false,
      })
      .returning();

    const sandboxKey = await createApiKey({
      sandboxId: row.sandboxId,
      accountId,
      title: 'Sandbox Token',
      type: 'sandbox',
    });

    await ensureSandboxCreatorMember(db, row.sandboxId, userId);

    await db
      .update(sandboxes)
      .set({ config: { serviceKey: sandboxKey.secretKey }, updatedAt: new Date() })
      .where(eq(sandboxes.sandboxId, row.sandboxId));

    await pool.injectEnv(claimed, sandboxKey.secretKey);

    console.log(`[ensureSandbox] Claimed from pool: ${row.sandboxId} (ext: ${claimed.externalId})`);
    return { row, created: true };
  } catch (err) {
    console.warn('[ensureSandbox] Pool claim failed, falling back to provisioning:', err);
    // If we grabbed a sandbox but failed after, try to destroy the orphaned VPS
    if (claimed?.externalId) {
      try {
        const provider = getProvider(claimed.poolSandbox.provider as ProviderName);
        await provider.remove(claimed.externalId);
        console.log(`[ensureSandbox] Cleaned up orphaned pool sandbox: ${claimed.externalId}`);
      } catch (cleanupErr) {
        console.error(`[ensureSandbox] Failed to clean up orphaned pool sandbox ${claimed.externalId}:`, cleanupErr);
      }
    }
    return null;
  }
}

export async function createSandbox(opts: {
  accountId: string;
  userId: string;
  provider?: ProviderName;
  serverType?: string;
  location?: string;
  isIncluded?: boolean;
}): Promise<EnsureSandboxResult> {
  const providerName = opts.provider || getDefaultProviderName();
  const poolEnabled = config.isPoolEnabled();
  console.log(`[createSandbox] poolEnabled=${poolEnabled}, provider=${providerName}`);

  if (poolEnabled) {
    const claimed = await tryClaimFromPool(opts.accountId, opts.userId, opts);
    console.log(`[createSandbox] pool grab result: ${claimed ? 'CLAIMED' : 'null'}`);
    if (claimed) return claimed;
  }

  return provisionNewSandbox(opts.accountId, opts.userId, providerName, opts);
}

async function provisionNewSandbox(
  accountId: string,
  userId: string,
  providerName: ProviderName,
  opts: { serverType?: string; location?: string; isIncluded?: boolean },
): Promise<EnsureSandboxResult> {
  const provider = getProvider(providerName);

  const sandbox = await insertProvisioningRow(accountId, providerName, opts.isIncluded);
  await ensureSandboxCreatorMember(db, sandbox.sandboxId, userId);
  const sandboxKey = await createSandboxApiKey(sandbox.sandboxId, accountId);

  const createOpts = {
    accountId,
    userId,
    name: sandbox.name,
    serverType: opts.serverType,
    location: opts.location,
    envVars: { KORTIX_TOKEN: sandboxKey.secretKey },
  };

  if (provider.provisioning.async) {
    return provisionAsync(provider, sandbox, sandboxKey.secretKey, createOpts);
  }

  return provisionSync(provider, sandbox, sandboxKey.secretKey, createOpts);
}

async function insertProvisioningRow(accountId: string, providerName: ProviderName, isIncluded?: boolean) {
  const name = await generateSandboxName(accountId);
  const [sandbox] = await db
    .insert(sandboxes)
    .values({
      accountId,
      name,
      provider: providerName,
      externalId: '',
      status: 'provisioning',
      baseUrl: '',
      config: {},
      metadata: {
        initStatus: 'pending',
        initAttempts: 0,
        initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
        healthStatus: 'unknown',
      },
      isIncluded: isIncluded ?? false,
    })
    .returning();
  return sandbox;
}

async function createSandboxApiKey(sandboxId: string, accountId: string) {
  return createApiKey({
    sandboxId,
    accountId,
    title: 'Sandbox Token',
    type: 'sandbox',
  });
}

async function provisionAsync(
  provider: ReturnType<typeof getProvider>,
  sandbox: typeof sandboxes.$inferSelect,
  serviceKey: string,
  createOpts: Parameters<ReturnType<typeof getProvider>['create']>[0],
): Promise<EnsureSandboxResult> {
  const firstStage = provider.provisioning.stages[0];

  await db
    .update(sandboxes)
    .set({
      config: { serviceKey },
      metadata: buildSandboxInitAttemptMetadata(
        sandbox.metadata as Record<string, unknown> | null,
        1,
        'provisioning',
        firstStage?.id,
        firstStage?.message,
      ),
      updatedAt: new Date(),
    })
    .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

  try {
    const { result, attempts } = await retrySandboxProvisionCreate(provider, createOpts, {
      onAttemptStart: async (attempt) => {
        if (attempt === 1) return;
        await db
          .update(sandboxes)
          .set({
            metadata: buildSandboxInitAttemptMetadata(
              sandbox.metadata as Record<string, unknown> | null,
              attempt,
              'retrying',
              firstStage?.id,
              `Retrying initialization (${attempt}/${SANDBOX_INIT_MAX_ATTEMPTS})…`,
            ),
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
      },
      onAttemptFailure: async (attempt, error, willRetry) => {
        await db
          .update(sandboxes)
          .set({
            ...(willRetry ? { status: 'provisioning' as const } : { status: 'error' as const }),
            metadata: buildSandboxInitFailureMetadata(
              sandbox.metadata as Record<string, unknown> | null,
              error,
              attempt,
              willRetry,
            ),
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
      },
    });
    const [updated] = await db
      .update(sandboxes)
      .set({
        externalId: result.externalId,
        baseUrl: result.baseUrl || '',
        metadata: buildSandboxInitSuccessMetadata(
          sandbox.metadata as Record<string, unknown> | null,
          { ...result.metadata, provisioningStage: firstStage?.id },
          attempts,
        ),
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
      .returning();

    return { row: updated, created: true };
  } catch (err) {
    throw err;
  }
}

async function provisionSync(
  provider: ReturnType<typeof getProvider>,
  sandbox: typeof sandboxes.$inferSelect,
  serviceKey: string,
  createOpts: Parameters<ReturnType<typeof getProvider>['create']>[0],
): Promise<EnsureSandboxResult> {
  try {
    const { result, attempts } = await retrySandboxProvisionCreate(provider, createOpts, {
      onAttemptStart: async (attempt) => {
        await db
          .update(sandboxes)
          .set({
            metadata: buildSandboxInitAttemptMetadata(
              sandbox.metadata as Record<string, unknown> | null,
              attempt,
              attempt === 1 ? 'provisioning' : 'retrying',
            ),
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
      },
      onAttemptFailure: async (attempt, error, willRetry) => {
        await db
          .update(sandboxes)
          .set({
            ...(willRetry ? { status: 'provisioning' as const } : { status: 'error' as const }),
            metadata: buildSandboxInitFailureMetadata(
              sandbox.metadata as Record<string, unknown> | null,
              error,
              attempt,
              willRetry,
            ),
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
      },
    });
    const [updated] = await db
      .update(sandboxes)
      .set({
        externalId: result.externalId,
        status: 'active',
        baseUrl: result.baseUrl,
        metadata: buildSandboxInitSuccessMetadata(
          sandbox.metadata as Record<string, unknown> | null,
          result.metadata,
          attempts,
        ),
        config: { serviceKey },
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
      .returning();

    return { row: updated, created: true };
  } catch (err) {
    throw err;
  }
}

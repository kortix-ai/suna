import { eq } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import { createApiKey } from '../../repositories/api-keys';
import type { SandboxProvider, SandboxStatus } from '../providers';
import {
  buildSandboxInitAttemptMetadata,
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  getSandboxMetadata,
  retrySandboxProvisionCreate,
} from './sandbox-init-state';

export function shouldReprovisionFailedJustAvpsSandbox(
  status: string,
  externalId: string | null | undefined,
  providerStatus: SandboxStatus | null,
): boolean {
  if (status !== 'error') return false;
  if (!externalId) return true;
  return providerStatus === 'removed';
}

export async function reprovisionFailedJustAvpsSandbox(opts: {
  db: Database;
  sandbox: typeof sandboxes.$inferSelect;
  provider: SandboxProvider;
  userId: string;
}): Promise<typeof sandboxes.$inferSelect | null> {
  const { db, sandbox, provider, userId } = opts;
  const existingMeta = getSandboxMetadata(sandbox.metadata);
  const existingConfig = getSandboxMetadata(sandbox.config);

  let serviceKey = typeof existingConfig.serviceKey === 'string' ? existingConfig.serviceKey : '';
  if (!serviceKey) {
    const sandboxKey = await createApiKey({
      sandboxId: sandbox.sandboxId,
      accountId: sandbox.accountId,
      title: 'Sandbox Token (recovery)',
      type: 'sandbox',
    });
    serviceKey = sandboxKey.secretKey;
  }

  const { result, attempts } = await retrySandboxProvisionCreate(provider, {
    accountId: sandbox.accountId,
    userId,
    name: sandbox.name,
    serverType: typeof existingMeta.serverType === 'string' ? existingMeta.serverType : undefined,
    location: typeof existingMeta.location === 'string' ? existingMeta.location : undefined,
    envVars: {
      KORTIX_TOKEN: serviceKey,
    },
  }, {
    onAttemptStart: async (attempt) => {
      await db
        .update(sandboxes)
        .set({
          externalId: attempt === 1 ? '' : sandbox.externalId,
          baseUrl: attempt === 1 ? '' : sandbox.baseUrl,
          status: 'provisioning',
          metadata: buildSandboxInitAttemptMetadata(
            existingMeta,
            attempt,
            attempt === 1 ? 'provisioning' : 'retrying',
            'server_creating',
            attempt === 1 ? 'Reinitializing workspace…' : `Retrying initialization (${attempt}/3)…`,
          ),
          config: { ...existingConfig, serviceKey },
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
    },
    onAttemptFailure: async (attempt, error, willRetry) => {
      await db
        .update(sandboxes)
        .set({
          ...(willRetry ? { status: 'provisioning' as const } : { status: 'error' as const }),
          metadata: buildSandboxInitFailureMetadata(existingMeta, error, attempt, willRetry),
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
    },
  });

  await db
    .update(sandboxes)
    .set({
      externalId: result.externalId,
      status: 'active',
      baseUrl: result.baseUrl,
      metadata: buildSandboxInitSuccessMetadata(existingMeta, result.metadata, attempts),
      config: { ...existingConfig, serviceKey },
      updatedAt: new Date(),
    })
    .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

  const [refreshed] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
    .limit(1);

  return refreshed ?? null;
}

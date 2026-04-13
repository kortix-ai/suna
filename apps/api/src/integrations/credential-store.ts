/**
 * Per-account integration credential store.
 * Resolution: request headers → account DB → API env defaults.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../shared/db';
import { integrationCredentials } from '@kortix/db';

export interface PipedreamCreds {
  client_id: string;
  client_secret: string;
  project_id: string;
  environment?: string;
}

export async function getAccountCreds(accountId: string, provider = 'pipedream'): Promise<PipedreamCreds | null> {
  try {
    const [row] = await db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.accountId, accountId),
          eq(integrationCredentials.provider, provider),
          eq(integrationCredentials.isActive, true),
        ),
      )
      .limit(1);

    if (!row) return null;
    const creds = row.credentials as Record<string, string>;
    if (!creds.client_id || !creds.client_secret || !creds.project_id) return null;
    return {
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      project_id: creds.project_id,
      environment: creds.environment || 'production',
    };
  } catch (error) {
    console.warn(
      `[PIPEDREAM] Failed to load account credentials for ${accountId}; falling back to env defaults if available: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function upsertAccountCreds(accountId: string, creds: PipedreamCreds, provider = 'pipedream'): Promise<void> {
  const payload = {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    project_id: creds.project_id,
    environment: creds.environment || 'production',
  };

  const [existing] = await db
    .select({ id: integrationCredentials.id })
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.accountId, accountId), eq(integrationCredentials.provider, provider)))
    .limit(1);

  if (existing) {
    await db
      .update(integrationCredentials)
      .set({ credentials: payload, isActive: true, updatedAt: new Date() })
      .where(eq(integrationCredentials.id, existing.id));
  } else {
    await db.insert(integrationCredentials).values({ accountId, provider, credentials: payload });
  }
}

export async function deleteAccountCreds(accountId: string, provider = 'pipedream'): Promise<void> {
  await db
    .delete(integrationCredentials)
    .where(and(eq(integrationCredentials.accountId, accountId), eq(integrationCredentials.provider, provider)));
}

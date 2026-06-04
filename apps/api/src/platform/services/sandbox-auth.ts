import { and, eq, ne } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';

export function getAuthCandidates(primary?: string): string[] {
  return Array.from(new Set([
    primary,
    config.INTERNAL_SERVICE_KEY,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

export async function getSandboxServiceKeyByExternalId(externalId: string): Promise<string> {
  const [row] = await db
    .select({ config: sandboxes.config })
    .from(sandboxes)
    .where(and(eq(sandboxes.externalId, externalId), ne(sandboxes.status, 'pooled')))
    .limit(1);

  const configJson = (row?.config || {}) as Record<string, unknown>;
  return typeof configJson.serviceKey === 'string' ? configJson.serviceKey : '';
}

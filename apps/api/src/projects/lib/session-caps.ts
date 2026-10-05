import { projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../shared/db';

import { PROVISIONING_SESSION_STATUSES } from './serializers';

export async function countProvisioningProjectSessions(projectId: string): Promise<number> {
  const [row] = await db
    .select({ provisioningCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        inArray(projectSessions.status, [...PROVISIONING_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.provisioningCount ?? 0);
}

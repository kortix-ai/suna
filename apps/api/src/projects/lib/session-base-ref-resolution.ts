import { accountGroupMembers, accountGroups, projectGroupGrants } from '@kortix/db';
import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';

import { db } from '../../shared/db';
import { selectEffectiveSessionBaseRef, type EffectiveSessionBaseRef } from './session-base-ref';

export async function resolveEffectiveSessionBaseRef(input: {
  userId: string;
  accountId: string;
  projectId: string;
  projectDefaultRef: string;
  explicitRef?: string | null;
}): Promise<EffectiveSessionBaseRef> {
  if (input.explicitRef?.trim()) {
    return selectEffectiveSessionBaseRef({
      explicitRef: input.explicitRef,
      projectDefaultRef: input.projectDefaultRef,
      groupDefaults: [],
    });
  }

  const now = new Date();
  const groupDefaults = await db
    .select({
      groupId: projectGroupGrants.groupId,
      groupName: accountGroups.name,
      baseRef: projectGroupGrants.defaultBaseRef,
    })
    .from(accountGroupMembers)
    .innerJoin(
      projectGroupGrants,
      and(
        eq(projectGroupGrants.groupId, accountGroupMembers.groupId),
        eq(projectGroupGrants.projectId, input.projectId),
        eq(projectGroupGrants.accountId, input.accountId),
        isNotNull(projectGroupGrants.defaultBaseRef),
        or(isNull(projectGroupGrants.expiresAt), gt(projectGroupGrants.expiresAt, now)),
      ),
    )
    .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
    .where(eq(accountGroupMembers.userId, input.userId));

  return selectEffectiveSessionBaseRef({
    projectDefaultRef: input.projectDefaultRef,
    groupDefaults: groupDefaults.flatMap((entry) =>
      entry.baseRef
        ? [
            {
              groupId: entry.groupId,
              groupName: entry.groupName,
              baseRef: entry.baseRef,
            },
          ]
        : [],
    ),
  });
}

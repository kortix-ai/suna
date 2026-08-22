import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import {
  accountRoleMap,
  isAccountManagerRole,
  projectRoleGrants,
} from '../../iam/read-models';
import { sendProjectAccessRequestEmail } from '../../accounts/email';
import { config } from '../../config';
import { db } from '../../shared/db';
import { lookupEmailsByUserIds } from './access';

function projectMembersUrl(projectId: string): string {
  const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  return `${base}/projects/${projectId}/customize/members`;
}
export async function notifyProjectAccessRequestManagers(input: {
  accountId: string;
  projectId: string;
  requesterUserId: string;
  requesterEmail?: string | null;
  message?: string | null;
}): Promise<void> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);

  // Who can approve this: account owners/admins (implicit Manager everywhere)
  // plus anyone holding the project `manager` role here. Both from
  // `role_assignments`, so the notification reaches exactly the people the
  // approve route will actually let through.
  const [accountRoles, projectGrants] = await Promise.all([
    accountRoleMap(input.accountId),
    projectRoleGrants({ accountId: input.accountId, projectId: input.projectId }),
  ]);
  const reviewerIds = Array.from(
    new Set([
      ...[...accountRoles.entries()]
        .filter(([, role]) => isAccountManagerRole(role))
        .map(([userId]) => userId),
      ...projectGrants.filter((g) => g.projectRole === 'manager').map((g) => g.userId),
    ]),
  ).filter((userId) => userId !== input.requesterUserId);
  if (reviewerIds.length === 0) return;

  const emails = await lookupEmailsByUserIds(
    input.requesterEmail ? reviewerIds : [input.requesterUserId, ...reviewerIds],
  ).catch(() => null);
  const requesterEmail =
    input.requesterEmail?.trim() ||
    emails?.get(input.requesterUserId) ||
    input.requesterUserId;
  const reviewUrl = projectMembersUrl(input.projectId);

  await Promise.all(
    reviewerIds.map(async (reviewerId) => {
      const email = emails?.get(reviewerId);
      if (!email) return;
      const delivery = await sendProjectAccessRequestEmail({
        email,
        projectName: project?.name ?? null,
        requesterEmail,
        reviewUrl,
        message: input.message ?? null,
      });
      if (!delivery.ok) {
        console.warn('[project-access-request] manager email not delivered', {
          reviewerId,
          reason: delivery.skipped ? delivery.reason : delivery.error,
        });
      }
    }),
  );
}

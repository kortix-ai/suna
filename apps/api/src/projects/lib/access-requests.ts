import { and, eq, inArray } from 'drizzle-orm';
import { accountMembers, projectMembers, projects } from '@kortix/db';
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

  const [accountManagers, explicitProjectManagers] = await Promise.all([
    db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, input.accountId),
          inArray(accountMembers.accountRole, ['owner', 'admin']),
        ),
      ),
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.projectRole, 'manager'),
        ),
      ),
  ]);

  const reviewerIds = Array.from(
    new Set([...accountManagers, ...explicitProjectManagers].map((row) => row.userId)),
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

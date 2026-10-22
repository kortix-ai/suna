import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { projectManagerUserIds } from '../../iam/project-managers';
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

  // Who can approve this: the project's managers, exactly the people the
  // approve route will actually let through.
  const reviewerIds = (await projectManagerUserIds(input.accountId, input.projectId))
    .filter((userId) => userId !== input.requesterUserId);
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

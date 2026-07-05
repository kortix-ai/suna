import { and, eq, inArray } from 'drizzle-orm';
import { accountMembers, projects } from '@kortix/db';
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

  // Reviewers = account owners/admins only. The former "explicit project
  // manager" cohort (project_members.project_role === 'manager') was retired
  // with the project-role collapse — approving an access request is
  // project.members.manage, which is ACCOUNT owner/admin authority ONLY now
  // (see role-perms.ts's ACCOUNT_ONLY_PROJECT_ACTIONS), so no project role
  // (not even editor) grants it.
  const accountManagers = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, input.accountId),
        inArray(accountMembers.accountRole, ['owner', 'admin']),
      ),
    );

  const reviewerIds = Array.from(new Set(accountManagers.map((row) => row.userId))).filter(
    (userId) => userId !== input.requesterUserId,
  );
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

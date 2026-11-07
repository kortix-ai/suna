import { and, eq } from 'drizzle-orm';
import { projectAccessRequests } from '@kortix/db';
import { projectManagerUserIds } from '../../iam/project-managers';
import { sendProjectAccessRequestEmail } from '../../accounts/email';
import { config } from '../../config';
import { db } from '../../shared/db';
import { type TransitionResult, transitionStatus } from '../../shared/status-transition';
import { lookupEmailsByUserIds } from './access';
import { projectsView } from '../../workspaces/rows';

function projectMembersUrl(projectId: string): string {
  const base = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
  return `${base}/workspaces/${projectId}/customize/members`;
}
export async function notifyProjectAccessRequestManagers(input: {
  accountId: string;
  projectId: string;
  requesterUserId: string;
  requesterEmail?: string | null;
  message?: string | null;
}): Promise<void> {
  const [project] = await db
    .select({ name: projectsView.name })
    .from(projectsView)
    .where(eq(projectsView.projectId, input.projectId))
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

type AccessRequestRow = typeof projectAccessRequests.$inferSelect;

/**
 * The review of a project access request: `pending` to `approved` or
 * `rejected`, once. Each is a compare-and-set on `pending`, so a concurrent
 * approve and reject cannot both apply, and the approve route claims the
 * request BEFORE it grants the role: a reject that lost the claim grants
 * nothing, and an approve that lost it grants nothing either.
 */
export const ACCESS_REQUEST_TRANSITIONS = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  /** The approve's grant failed after the claim: the request is pending again. */
  releaseApproval: { from: ['approved'], to: 'pending' },
} as const;

export function reviewProjectAccessRequest(input: {
  requestId: string;
  projectId: string;
  verdict: 'approve' | 'reject';
  reviewedBy: string;
}): Promise<TransitionResult<AccessRequestRow>> {
  const now = new Date();
  return transitionStatus(projectAccessRequests, projectAccessRequests.status, ACCESS_REQUEST_TRANSITIONS[input.verdict], {
    where: and(
      eq(projectAccessRequests.requestId, input.requestId),
      eq(projectAccessRequests.projectId, input.projectId),
    ),
    set: { reviewedBy: input.reviewedBy, reviewedAt: now, updatedAt: now },
  });
}

/** Undo an approve claim whose grant threw, so the request can be reviewed again. */
export async function releaseProjectAccessApproval(requestId: string, reviewedBy: string): Promise<void> {
  await transitionStatus(projectAccessRequests, projectAccessRequests.status, ACCESS_REQUEST_TRANSITIONS.releaseApproval, {
    where: and(eq(projectAccessRequests.requestId, requestId), eq(projectAccessRequests.reviewedBy, reviewedBy)),
    set: { reviewedBy: null, reviewedAt: null, updatedAt: new Date() },
  });
}

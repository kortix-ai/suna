/**
 * A decision on a gated connector call pressed in a chat thread (Slack, Teams).
 *
 * Same bar as the web route: a linked human with read access to the project
 * who is a project manager or the session's launcher. The chat surface then
 * resumes the session its own way.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { humanMayResolveApproval } from '../../projects/lib/approval-authority';
import {
  type ApprovalDecision,
  type PendingApprovalRow,
  approvalTargetSession,
  decideConnectorApproval,
  isPendingApproval,
  loadApprovalRow,
} from '../../projects/lib/connector-approval-decision';
import { markApprovalCardDecided } from '../approval-card-relay';
import { db } from '../../lib/db';
import { type ChatUser, resolveChatActor } from './identity';

export async function decideChatApproval(input: {
  user: ChatUser;
  projectId: string;
  /** The session behind the thread the card was pressed in. */
  sessionId: string | null;
  executionId: string;
  decision: ApprovalDecision;
  note: string;
}): Promise<{ row: PendingApprovalRow } | { refusal: string }> {
  const row = await loadApprovalRow(input.projectId, input.executionId);
  // The card must belong to the session behind this thread: an execution id
  // pasted into another thread's button payload decides nothing.
  if (!row || !input.sessionId || row.sessionId !== input.sessionId) {
    return { refusal: 'That approval is no longer available.' };
  }
  if (!isPendingApproval(row)) return { refusal: 'That call was already decided.' };
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project) return { refusal: 'That approval is no longer available.' };

  // Read access, then the manager-or-launcher rule below: a read-and-run
  // member who started the session decides here exactly as in Kortix.
  const actor = await resolveChatActor(
    input.user,
    { projectId: input.projectId, accountId: project.accountId },
    PROJECT_ACTIONS.PROJECT_READ,
  );
  if ('reason' in actor) {
    return {
      refusal:
        actor.reason === 'unlinked'
          ? 'Connect your Kortix account first (`/kortix login` in Slack, `/login` in Teams) to decide on approvals.'
          : "You don't have access to decide on this project's approvals.",
    };
  }
  // Through the chat resolver, so the check carries the second factor the
  // link was made with: in an MFA account a bare role check denied every
  // manager, leaving only the launcher able to decide.
  const manager = await resolveChatActor(
    input.user,
    { projectId: input.projectId, accountId: project.accountId },
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  );
  const target = await approvalTargetSession(input.projectId, row);
  const verdict = humanMayResolveApproval({
    isManager: 'userId' in manager,
    targetSessionOrigin: target.origin,
    targetSessionCreatedBy: target.createdBy,
    callerUserId: actor.userId,
  });
  if (!verdict.allowed) {
    return { refusal: 'Only a project manager or the person who started this session can decide.' };
  }

  const outcome = await decideConnectorApproval({
    projectId: input.projectId,
    accountId: project.accountId,
    row,
    decision: input.decision,
    note: input.note,
    actorUserId: actor.userId,
    auditSource: 'human',
    resume: 'caller',
    updateStaleCard: () =>
      markApprovalCardDecided({
        projectId: input.projectId,
        row,
        decision: input.decision,
        note: input.note,
        actorUserId: actor.userId,
      }),
  });
  if (outcome === 'preview_unavailable') {
    return { refusal: 'This call recorded no parameters to review, so it can only be denied.' };
  }
  if (outcome === 'already_resolved') return { refusal: 'That call was already decided.' };
  return { row };
}

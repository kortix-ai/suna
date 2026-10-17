import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../../shared/db';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { type ChatUser, resolveProjectChatActor } from './identity';

/** What a refused Stop tells the presser, in Slack and in Teams. */
export const CHAT_TURN_STOP_REFUSED =
  'Only the person who started this run, the session owner or a project manager can stop it.';

/** `userId`: the presser's linked Kortix user, for the stop's attribution; null when unlinked. */
export type ChatTurnStopVerdict = { allowed: true; userId: string | null } | { allowed: false };

/**
 * Who may press Stop on a live Slack or Teams turn: the API rule
 * (`projects/session-lifecycle/turn-stop-authority.ts`) for a chat presser.
 *
 * The button sits on a message everyone in the thread can see, so the check
 * runs on the press. Three people may stop a run:
 *
 *  1. the sender of the message the turn is answering (`sentIt`): the turn's
 *     prompter in chat identity;
 *  2. a linked Kortix user who owns the session or manages the project;
 *  3. a linked Kortix user who prompted the running turn from another surface,
 *     such as the web, into a channel-bound session.
 *
 * Each one also needs `project.session.stop` on the project through a live
 * link. When the workspace does not require linked identities
 * (`requireIdentity` false), the thread runs as the installer, so the sender
 * needs no link there. Everyone else is refused, an approved thread
 * participant too: joining a thread lets a person prompt, not end another
 * person's run.
 *
 * A failed lookup throws. The caller refuses on a throw: the worst case is a
 * bystander who waits for a run to end, not a bystander who ends someone
 * else's work.
 */
export async function chatTurnStopVerdict(input: {
  user: ChatUser;
  projectId: string;
  sessionId: string;
  sentIt: boolean;
  requireIdentity: boolean;
}): Promise<ChatTurnStopVerdict> {
  if (!input.user.platformUserId) return { allowed: false };
  const actor = await resolveProjectChatActor(input.user, input.projectId, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
  const userId = 'userId' in actor ? actor.userId : null;
  if (input.sentIt) return userId || !input.requireIdentity ? { allowed: true, userId } : { allowed: false };
  if (!userId) return { allowed: false };
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project) return { allowed: false };
  // Lazily imported so the channel modules keep no static edge into the
  // session-lifecycle engine (the rule stop.ts follows for the abort).
  const { readRunningTurn, sessionLifecycleStandingFor, turnPrompterOf } = await import('../../projects/surface');
  const standing = await sessionLifecycleStandingFor({
    userId,
    accountId: project.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  if (standing) return { allowed: true, userId };
  const running = await readRunningTurn(input.sessionId);
  const prompter = running ? await turnPrompterOf(input.sessionId, running.messageId) : null;
  return prompter === userId ? { allowed: true, userId } : { allowed: false };
}

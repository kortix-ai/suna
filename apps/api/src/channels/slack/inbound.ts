import { and, eq } from 'drizzle-orm';
import { chatInstalls, chatThreads } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * What the signature check on an inbound Slack request proved.
 *
 * Slack signs the body with the app's signing secret, so a valid signature
 * proves only that the holder of that secret sent it:
 *
 *  - `canonical`: the Kortix Slack app. Kortix holds the secret, so the body is
 *    Slack's own and its `team_id` is the workspace the event came from.
 *  - `project`: a per-project (bring-your-own) app. The project admin chose the
 *    secret, so the body proves nothing beyond "this admin sent it". What the
 *    request may reach comes from the install record instead: the project in
 *    the webhook path, and the workspace the bot token proved at connect time
 *    (`chat_installs`, written only from Slack's `auth.test` / OAuth answer).
 *
 * Every handler behind a per-project route receives the `project` value and
 * stays inside that project and workspace.
 */
export type SlackInbound =
  | { kind: 'canonical' }
  | { kind: 'project'; projectId: string; teamId: string };

export const CANONICAL_SLACK_INBOUND: SlackInbound = { kind: 'canonical' };

/** The project a per-project request is confined to; undefined for the canonical app. */
export function inboundProjectId(inbound: SlackInbound): string | undefined {
  return inbound.kind === 'project' ? inbound.projectId : undefined;
}

/** May a request from `inbound` act on `projectId`? */
export function inboundAllowsProject(inbound: SlackInbound, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return inbound.kind === 'canonical' || inbound.projectId === projectId;
}

/** May a request from `inbound` act in workspace `teamId`? */
export function inboundAllowsTeam(inbound: SlackInbound, teamId: string | null | undefined): boolean {
  if (!teamId) return false;
  return inbound.kind === 'canonical' || inbound.teamId === teamId;
}

/**
 * The Slack workspaces a project's install was proven for. Read from
 * `chat_installs`, which only the install paths write (after `auth.test` or
 * the OAuth token exchange named the team) — never from `project_secrets`,
 * which a project admin can overwrite through the generic secrets API.
 */
export async function provenSlackWorkspaces(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)));
  return rows.map((r) => r.workspaceId).filter(Boolean);
}

/**
 * Confine a per-project request to its proven workspace. Returns the inbound
 * scope when `bodyTeamId` is one of the workspaces the install proved, else
 * null (the caller refuses the request).
 */
export async function scopeProjectSlackRequest(
  projectId: string,
  bodyTeamId: string | null | undefined,
): Promise<SlackInbound | null> {
  if (!bodyTeamId) return null;
  const teams = await provenSlackWorkspaces(projectId);
  if (!teams.includes(bodyTeamId)) return null;
  return { kind: 'project', projectId, teamId: bodyTeamId };
}

export interface SlackThreadRow {
  sessionId: string;
  projectId: string;
}

/**
 * The `chat_threads` row for a Slack thread, confined to what `inbound` may
 * reach. The table is unique on (platform, workspace, thread) across every
 * project, so an unscoped read answers with whichever project created the
 * thread; a per-project request must only ever see its own project's threads.
 */
export async function findSlackThread(
  inbound: SlackInbound,
  teamId: string,
  threadTs: string,
): Promise<SlackThreadRow | null> {
  if (!teamId || !threadTs || !inboundAllowsTeam(inbound, teamId)) return null;
  const [row] = await db
    .select({ sessionId: chatThreads.sessionId, projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'slack'),
        eq(chatThreads.workspaceId, teamId),
        eq(chatThreads.threadId, threadTs),
        inbound.kind === 'project' ? eq(chatThreads.projectId, inbound.projectId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

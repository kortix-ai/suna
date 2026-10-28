import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  deleteProjectSecrets,
  listProjectsForWorkspace,
  readSecret,
  upsertSecret,
} from '../install-store';

export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_TEAM_ID = 'SLACK_TEAM_ID';
export const SLACK_BOT_USER_ID = 'SLACK_BOT_USER_ID';
export const SLACK_TEAM_NAME = 'SLACK_TEAM_NAME';
/** The install's bot id (`auth.test`), resolved on first use: keys the self-loop guard for agent-named posts. */
export const SLACK_BOT_ID = 'SLACK_BOT_ID';

const SLACK_KEYS = [
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_NAME,
  SLACK_BOT_ID,
] as const;

export interface SlackInstallSummary {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export interface SlackInstallInput {
  projectId: string;
  botToken: string;
  signingSecret: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
}

interface SlackOauthInstallInput {
  projectId: string;
  workspaceId: string;
  botToken: string;
  botUserId: string;
  teamName: string | null;
}

export async function saveSlackInstall(input: SlackInstallInput): Promise<SlackInstallSummary> {
  const { projectId } = input;
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      workspaceId: input.teamId,
      projectId,
    })
    .onConflictDoNothing();
  await upsertSecret(projectId, SLACK_BOT_TOKEN, input.botToken);
  await upsertSecret(projectId, SLACK_SIGNING_SECRET, input.signingSecret);
  await upsertSecret(projectId, SLACK_TEAM_ID, input.teamId);
  await upsertSecret(projectId, SLACK_BOT_USER_ID, input.botUserId);
  await upsertSecret(projectId, SLACK_TEAM_NAME, input.teamName ?? '');
  return {
    workspaceId: input.teamId,
    workspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

export async function deleteSlackInstall(projectId: string): Promise<void> {
  await deleteProjectSecrets(projectId, SLACK_KEYS);
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)));
}

// Universal Kortix Slack App install. Records this project's membership of the
// workspace, then fans the bot token + workspace metadata out to every project
// on the workspace — Slack issues one token per (app, workspace) and a re-auth
// rotates it, so all sharing projects must be kept current. The signing secret
// is the master Kortix one and stays server-side; it is never persisted here.
export async function saveSlackOauthInstall(
  input: SlackOauthInstallInput,
): Promise<SlackInstallSummary> {
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    })
    .onConflictDoNothing();

  const projectIds = await listProjectsForWorkspace('slack', input.workspaceId);
  if (!projectIds.includes(input.projectId)) projectIds.push(input.projectId);
  for (const projectId of projectIds) {
    await upsertSecret(projectId, SLACK_BOT_TOKEN, input.botToken);
    await upsertSecret(projectId, SLACK_TEAM_ID, input.workspaceId);
    await upsertSecret(projectId, SLACK_BOT_USER_ID, input.botUserId);
    await upsertSecret(projectId, SLACK_TEAM_NAME, input.teamName ?? '');
  }

  return {
    workspaceId: input.workspaceId,
    workspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

export async function loadSlackInstall(projectId: string): Promise<SlackInstallSummary | null> {
  // Read scope-agnostically: Slack credentials are stored with scope='connector'
  // (kept out of the sandbox env), which listProjectSecrets deliberately drops —
  // so status must go through readSecret, matching the Teams install read path.
  const teamId = await readSecret(projectId, SLACK_TEAM_ID);
  if (!teamId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, SLACK_TEAM_ID)))
    .limit(1);
  return {
    workspaceId: teamId,
    workspaceName: (await readSecret(projectId, SLACK_TEAM_NAME)) || null,
    botUserId: (await readSecret(projectId, SLACK_BOT_USER_ID)) || null,
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadSlackTokenForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_TOKEN);
}

export async function loadSlackSigningSecretForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_SIGNING_SECRET);
}

export async function loadSlackBotUserIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_USER_ID);
}

export async function loadSlackBotIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_ID);
}

/**
 * The install's bot id, asking Slack (`auth.test`) once and storing it. A post
 * under an agent's name arrives back with no `event.user`, so the self-loop
 * guard keys it on this id; without it no post carries a persona.
 */
export async function ensureSlackBotId(projectId: string, token: string): Promise<string | null> {
  const known = await readSecret(projectId, SLACK_BOT_ID);
  if (known) return known;
  // Lazy: this module sits under every Slack import, and slack-api does not need to.
  const { authTestBotId } = await import('../slack-api');
  const botId = await authTestBotId(token);
  if (botId) await upsertSecret(projectId, SLACK_BOT_ID, botId);
  return botId;
}

export async function loadSlackTeamIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_ID);
}

export async function loadSlackTeamNameForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_NAME);
}

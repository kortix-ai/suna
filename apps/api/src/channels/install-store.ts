import { and, eq } from 'drizzle-orm';
import { chatInstalls, projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  listProjectSecrets,
} from '../projects/secrets';

export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_TEAM_ID = 'SLACK_TEAM_ID';
export const SLACK_BOT_USER_ID = 'SLACK_BOT_USER_ID';
export const SLACK_TEAM_NAME = 'SLACK_TEAM_NAME';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';

export async function loadTelegramWebhookSecretForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, TELEGRAM_WEBHOOK_SECRET);
}

const SLACK_KEYS = [
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_NAME,
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

export async function saveSlackInstall(input: SlackInstallInput): Promise<SlackInstallSummary> {
  const { projectId } = input;
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
  for (const name of SLACK_KEYS) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)));
}

export interface SlackOauthInstallInput {
  projectId: string;
  workspaceId: string;
  botToken: string;
  botUserId: string;
  teamName: string | null;
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
    .values({ platform: 'slack', workspaceId: input.workspaceId, projectId: input.projectId })
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

export async function listProjectsForWorkspace(
  platform: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.workspaceId, workspaceId)));
  return rows.map((r) => r.projectId);
}

export async function loadSlackInstall(
  projectId: string,
): Promise<SlackInstallSummary | null> {
  const secrets = await listProjectSecrets(projectId);
  const teamId = secrets[SLACK_TEAM_ID];
  if (!teamId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, SLACK_TEAM_ID)))
    .limit(1);
  return {
    workspaceId: teamId,
    workspaceName: secrets[SLACK_TEAM_NAME] || null,
    botUserId: secrets[SLACK_BOT_USER_ID] || null,
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

export async function loadSlackTeamNameForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_NAME);
}

async function upsertSecret(projectId: string, name: string, value: string): Promise<void> {
  const valueEnc = encryptProjectSecret(projectId, value);
  await db
    .insert(projectSecrets)
    .values({ projectId, name, valueEnc })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.name],
      set: { valueEnc, updatedAt: new Date() },
    });
}

async function readSecret(projectId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)))
    .limit(1);
  if (!row?.valueEnc) return null;
  try {
    return decryptProjectSecret(projectId, row.valueEnc);
  } catch {
    return null;
  }
}

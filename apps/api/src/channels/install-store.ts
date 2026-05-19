import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, projectSecrets } from '@kortix/db';
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

export async function findProjectForWorkspace(workspaceId: string): Promise<string | null> {
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return binding?.projectId ?? null;
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

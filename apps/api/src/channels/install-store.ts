import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, isNull, like } from 'drizzle-orm';
import { config } from '../config';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  listProjectSecrets,
} from '../projects/secrets';
import { db } from '../shared/db';

export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_TEAM_ID = 'SLACK_TEAM_ID';
export const SLACK_BOT_USER_ID = 'SLACK_BOT_USER_ID';
export const SLACK_TEAM_NAME = 'SLACK_TEAM_NAME';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';

export async function loadTelegramWebhookSecretForProject(
  projectId: string,
): Promise<string | null> {
  return readSecret(projectId, TELEGRAM_WEBHOOK_SECRET);
}

export const AGENTMAIL_API_KEY = 'AGENTMAIL_API_KEY';
export const AGENTMAIL_INBOX_ID = 'AGENTMAIL_INBOX_ID';
export const AGENTMAIL_INBOX_EMAIL = 'AGENTMAIL_INBOX_EMAIL';
export const AGENTMAIL_INBOX_DISPLAY_NAME = 'AGENTMAIL_INBOX_DISPLAY_NAME';
export const AGENTMAIL_WEBHOOK_ID = 'AGENTMAIL_WEBHOOK_ID';
export const AGENTMAIL_WEBHOOK_SECRET = 'AGENTMAIL_WEBHOOK_SECRET';
export const AGENTMAIL_SENDER_POLICY = 'AGENTMAIL_SENDER_POLICY';

export const RECALL_API_KEY = 'RECALL_API_KEY';

export interface MeetInstallSummary {
  /** Where the resolved Recall key came from — operator env or a project override. */
  source: 'project' | 'env';
}

/**
 * The Recall.ai API key for a project: a per-project override secret if set, else
 * the operator-wide config.RECALL_API_KEY. Server-side only — this key signs the
 * meet channel connector's `Authorization: Token` header and is never injected
 * into a sandbox.
 */
export async function loadMeetTokenForProject(projectId: string): Promise<string | null> {
  const override = await readSecret(projectId, RECALL_API_KEY);
  return override ?? (config.RECALL_API_KEY || null);
}

/** Cheap "is meet usable?" — a Recall key resolves (per-project override or env). */
export async function loadMeetInstall(projectId: string): Promise<MeetInstallSummary | null> {
  const override = await readSecret(projectId, RECALL_API_KEY).catch(() => null);
  if (override) return { source: 'project' };
  if (config.RECALL_API_KEY) return { source: 'env' };
  return null;
}

const SLACK_KEYS = [
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_NAME,
] as const;

const AGENTMAIL_KEYS = [
  AGENTMAIL_API_KEY,
  AGENTMAIL_INBOX_ID,
  AGENTMAIL_INBOX_EMAIL,
  AGENTMAIL_INBOX_DISPLAY_NAME,
  AGENTMAIL_WEBHOOK_ID,
  AGENTMAIL_WEBHOOK_SECRET,
  AGENTMAIL_SENDER_POLICY,
] as const;

export interface AgentMailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

export const DEFAULT_AGENTMAIL_SENDER_POLICY: AgentMailSenderPolicy = {
  mode: 'allow_all',
  allowedEmails: [],
  allowedDomains: [],
  allowedRegex: null,
};

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

export interface AgentMailInstallSummary {
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: AgentMailSenderPolicy;
  installedAt: string;
}

export interface AgentMailInstallInput {
  projectId: string;
  profileSlug?: string | null;
  apiKey?: string | null;
  inboxId: string;
  email: string;
  displayName?: string | null;
  webhookId?: string | null;
  webhookSecret?: string | null;
  senderPolicy?: AgentMailSenderPolicy | null;
}

function agentMailProfileSuffix(profileSlug?: string | null): string {
  const slug = (profileSlug || 'kortix_email').trim();
  if (!slug || slug === 'kortix_email') return '';
  return `_${slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function agentMailKeys(profileSlug?: string | null) {
  const suffix = agentMailProfileSuffix(profileSlug);
  return {
    apiKey: `${AGENTMAIL_API_KEY}${suffix}`,
    inboxId: `${AGENTMAIL_INBOX_ID}${suffix}`,
    email: `${AGENTMAIL_INBOX_EMAIL}${suffix}`,
    displayName: `${AGENTMAIL_INBOX_DISPLAY_NAME}${suffix}`,
    webhookId: `${AGENTMAIL_WEBHOOK_ID}${suffix}`,
    webhookSecret: `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`,
    senderPolicy: `${AGENTMAIL_SENDER_POLICY}${suffix}`,
  };
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean),
    ),
  );
}

export function normalizeSenderPolicy(
  input?: Partial<AgentMailSenderPolicy> | null,
): AgentMailSenderPolicy {
  const allowedEmails = uniqueStrings(input?.allowedEmails);
  const allowedDomains = uniqueStrings(input?.allowedDomains).map((domain) =>
    domain.replace(/^@+/, ''),
  );
  const rawRegex = typeof input?.allowedRegex === 'string' ? input.allowedRegex.trim() : '';
  const restricted =
    input?.mode === 'restricted' ||
    allowedEmails.length > 0 ||
    allowedDomains.length > 0 ||
    rawRegex.length > 0;
  return {
    mode: restricted ? 'restricted' : 'allow_all',
    allowedEmails,
    allowedDomains,
    allowedRegex: rawRegex || null,
  };
}

function parseSenderPolicy(raw: string | null): AgentMailSenderPolicy {
  if (!raw) return DEFAULT_AGENTMAIL_SENDER_POLICY;
  try {
    return normalizeSenderPolicy(JSON.parse(raw) as Partial<AgentMailSenderPolicy>);
  } catch {
    return DEFAULT_AGENTMAIL_SENDER_POLICY;
  }
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
  for (const name of SLACK_KEYS) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)));
}

export async function saveAgentMailInstall(
  input: AgentMailInstallInput,
): Promise<AgentMailInstallSummary> {
  const { projectId } = input;
  const profileSlug = input.profileSlug || 'kortix_email';
  const keys = agentMailKeys(profileSlug);
  const previous = await loadAgentMailInstall(projectId, profileSlug);
  if (input.apiKey) await upsertSecret(projectId, keys.apiKey, input.apiKey);
  await upsertSecret(projectId, keys.inboxId, input.inboxId);
  await upsertSecret(projectId, keys.email, input.email);
  await upsertSecret(projectId, keys.displayName, input.displayName ?? '');
  await upsertSecret(projectId, keys.webhookId, input.webhookId ?? '');
  await upsertSecret(
    projectId,
    keys.senderPolicy,
    JSON.stringify(normalizeSenderPolicy(input.senderPolicy)),
  );
  if (input.webhookSecret) {
    await upsertSecret(projectId, keys.webhookSecret, input.webhookSecret);
  }
  if (previous?.inboxId) {
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.projectId, projectId),
          eq(chatInstalls.workspaceId, previous.inboxId),
        ),
      );
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.workspaceId, input.inboxId)));
  await db
    .insert(chatInstalls)
    .values({ platform: 'email', workspaceId: input.inboxId, projectId })
    .onConflictDoNothing({
      target: [chatInstalls.platform, chatInstalls.workspaceId, chatInstalls.projectId],
    });
  return {
    profileSlug,
    inboxId: input.inboxId,
    email: input.email,
    displayName: input.displayName ?? null,
    webhookId: input.webhookId ?? null,
    senderPolicy: normalizeSenderPolicy(input.senderPolicy),
    installedAt: new Date().toISOString(),
  };
}

export async function deleteAgentMailInstall(
  projectId: string,
  profileSlug?: string | null,
): Promise<void> {
  const keys = agentMailKeys(profileSlug);
  const install = await loadAgentMailInstall(projectId, profileSlug);
  for (const name of Object.values(keys)) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  if (install?.inboxId) {
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.projectId, projectId),
          eq(chatInstalls.workspaceId, install.inboxId),
        ),
      );
  } else if (!profileSlug || profileSlug === 'kortix_email') {
    await db
      .delete(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.projectId, projectId)));
  }
}

function agentMailProfileSlugFromInboxSecret(name: string): string | null {
  if (!name.startsWith(AGENTMAIL_INBOX_ID)) return null;
  const suffix = name.slice(AGENTMAIL_INBOX_ID.length);
  if (!suffix) return 'kortix_email';
  return suffix.replace(/^_+/, '').toLowerCase() || null;
}

export async function listAgentMailInstalls(projectId: string): Promise<AgentMailInstallSummary[]> {
  const rows = await db
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  const installs: AgentMailInstallSummary[] = [];
  for (const row of rows) {
    const profileSlug = agentMailProfileSlugFromInboxSecret(row.name);
    if (!profileSlug) continue;
    try {
      // Skip malformed or stale secret envelopes without poisoning the whole list.
      decryptProjectSecret(projectId, row.valueEnc);
      const install = await loadAgentMailInstall(projectId, profileSlug);
      if (install) installs.push(install);
    } catch {}
  }
  return installs.sort((a, b) => a.profileSlug.localeCompare(b.profileSlug));
}

export async function updateAgentMailSenderPolicy(
  projectId: string,
  profileSlug: string | null | undefined,
  senderPolicy: AgentMailSenderPolicy,
): Promise<AgentMailInstallSummary | null> {
  const install = await loadAgentMailInstall(projectId, profileSlug);
  if (!install) return null;
  await upsertSecret(
    projectId,
    agentMailKeys(profileSlug).senderPolicy,
    JSON.stringify(normalizeSenderPolicy(senderPolicy)),
  );
  return loadAgentMailInstall(projectId, profileSlug);
}

export async function loadAgentMailInstall(
  projectId: string,
  profileSlug?: string | null,
): Promise<AgentMailInstallSummary | null> {
  const keys = agentMailKeys(profileSlug);
  const [inboxId, email, displayName, webhookId, senderPolicyRaw] = await Promise.all([
      readSecret(projectId, keys.inboxId),
      readSecret(projectId, keys.email),
      readSecret(projectId, keys.displayName),
      readSecret(projectId, keys.webhookId),
      readSecret(projectId, keys.senderPolicy),
    ]);
  if (!inboxId || !email) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, keys.inboxId),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .limit(1);
  return {
    profileSlug: profileSlug || 'kortix_email',
    inboxId,
    email,
    displayName: displayName || null,
    webhookId: webhookId || null,
    senderPolicy: parseSenderPolicy(senderPolicyRaw),
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadAgentMailApiKeyForProject(
  projectId: string,
  profileSlug?: string | null,
): Promise<string | null> {
  return readSecret(projectId, agentMailKeys(profileSlug).apiKey);
}

export async function loadAgentMailApiKeyForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptProjectSecret(projectId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(projectId, `${AGENTMAIL_API_KEY}${suffix}`);
  }
  return null;
}

export async function loadAgentMailWebhookSecretForProject(
  projectId: string,
): Promise<string | null> {
  return readSecret(projectId, AGENTMAIL_WEBHOOK_SECRET);
}

export async function loadAgentMailWebhookSecretForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptProjectSecret(projectId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(projectId, `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`);
  }
  return null;
}

export async function loadAgentMailSenderPolicyForInbox(
  projectId: string,
  inboxId: string,
): Promise<AgentMailSenderPolicy> {
  const rows = await db
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptProjectSecret(projectId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return parseSenderPolicy(await readSecret(projectId, `${AGENTMAIL_SENDER_POLICY}${suffix}`));
  }
  return DEFAULT_AGENTMAIL_SENDER_POLICY;
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

export async function loadSlackInstall(projectId: string): Promise<SlackInstallSummary | null> {
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

// ─── Microsoft Teams ──────────────────────────────────────────────────────

export const MS_TEAMS_TENANT_ID = 'MS_TEAMS_TENANT_ID';
export const MS_TEAMS_SERVICE_URL = 'MS_TEAMS_SERVICE_URL';
export const MS_TEAMS_TEAM_ID = 'MS_TEAMS_TEAM_ID';
export const MS_TEAMS_TEAM_NAME = 'MS_TEAMS_TEAM_NAME';
export const MS_TEAMS_BOT_ID = 'MS_TEAMS_BOT_ID';

const TEAMS_KEYS = [
  MS_TEAMS_TENANT_ID,
  MS_TEAMS_SERVICE_URL,
  MS_TEAMS_TEAM_ID,
  MS_TEAMS_TEAM_NAME,
  MS_TEAMS_BOT_ID,
] as const;

export interface TeamsInstallSummary {
  tenantId: string;
  teamId: string | null;
  teamName: string | null;
  botId: string | null;
  serviceUrl: string | null;
  installedAt: string;
}

export interface TeamsInstallInput {
  projectId: string;
  tenantId: string;
  teamId?: string | null;
  teamName?: string | null;
  botId?: string | null;
  serviceUrl?: string | null;
}

export async function saveTeamsInstall(input: TeamsInstallInput): Promise<TeamsInstallSummary> {
  const { projectId, tenantId } = input;
  await db
    .insert(chatInstalls)
    .values({ platform: 'teams', workspaceId: tenantId, projectId })
    .onConflictDoNothing();

  await upsertSecret(projectId, MS_TEAMS_TENANT_ID, tenantId);
  if (input.teamId != null) await upsertSecret(projectId, MS_TEAMS_TEAM_ID, input.teamId);
  if (input.teamName != null) await upsertSecret(projectId, MS_TEAMS_TEAM_NAME, input.teamName);
  if (input.botId != null) await upsertSecret(projectId, MS_TEAMS_BOT_ID, input.botId);
  if (input.serviceUrl != null) await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, input.serviceUrl);

  return {
    tenantId,
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    botId: input.botId ?? null,
    serviceUrl: input.serviceUrl ?? null,
    installedAt: new Date().toISOString(),
  };
}

/** Update just the conversation serviceUrl — refreshed from each inbound activity. */
export async function saveTeamsServiceUrl(projectId: string, serviceUrl: string): Promise<void> {
  if (!serviceUrl) return;
  await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, serviceUrl);
}

export async function loadTeamsInstall(projectId: string): Promise<TeamsInstallSummary | null> {
  const secrets = await listProjectSecrets(projectId);
  const tenantId = secrets[MS_TEAMS_TENANT_ID];
  if (!tenantId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, MS_TEAMS_TENANT_ID)))
    .limit(1);
  return {
    tenantId,
    teamId: secrets[MS_TEAMS_TEAM_ID] || null,
    teamName: secrets[MS_TEAMS_TEAM_NAME] || null,
    botId: secrets[MS_TEAMS_BOT_ID] || null,
    serviceUrl: secrets[MS_TEAMS_SERVICE_URL] || null,
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadTeamsTenantForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_TENANT_ID);
}

export async function loadTeamsServiceUrlForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_SERVICE_URL);
}

export async function deleteTeamsInstall(projectId: string): Promise<void> {
  for (const name of TEAMS_KEYS) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)));
}

async function upsertSecret(projectId: string, name: string, value: string): Promise<void> {
  const valueEnc = encryptProjectSecret(projectId, value);
  const updated = await updateSharedSecret(projectId, name, valueEnc);
  if (updated) return;

  try {
    await db.insert(projectSecrets).values({
      projectId,
      identifier: name,
      name,
      valueEnc,
      scope: 'connector',
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const retryUpdated = await updateSharedSecret(projectId, name, valueEnc);
    if (!retryUpdated) throw err;
  }
}

async function updateSharedSecret(
  projectId: string,
  name: string,
  valueEnc: string,
): Promise<boolean> {
  const rows = await db
    .update(projectSecrets)
    .set({ valueEnc, scope: 'connector', updatedAt: new Date() })
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .returning({ secretId: projectSecrets.secretId });
  return rows.length > 0;
}

function isUniqueConflict(err: unknown): boolean {
  const error = err as {
    code?: unknown;
    cause?: { code?: unknown; cause?: { code?: unknown } };
  };
  return (
    error?.code === '23505' ||
    error?.cause?.code === '23505' ||
    error?.cause?.cause?.code === '23505'
  );
}

async function readSecret(projectId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .limit(1);
  if (!row?.valueEnc) return null;
  try {
    return decryptProjectSecret(projectId, row.valueEnc);
  } catch {
    return null;
  }
}

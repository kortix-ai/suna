import { chatChannelBindings, chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, isNull, like } from 'drizzle-orm';
import { db } from '../../shared/db';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

export const AGENTMAIL_API_KEY = 'AGENTMAIL_API_KEY';
export const AGENTMAIL_INBOX_ID = 'AGENTMAIL_INBOX_ID';
export const AGENTMAIL_INBOX_EMAIL = 'AGENTMAIL_INBOX_EMAIL';
export const AGENTMAIL_INBOX_DISPLAY_NAME = 'AGENTMAIL_INBOX_DISPLAY_NAME';
export const AGENTMAIL_WEBHOOK_ID = 'AGENTMAIL_WEBHOOK_ID';
export const AGENTMAIL_WEBHOOK_SECRET = 'AGENTMAIL_WEBHOOK_SECRET';
export const AGENTMAIL_SENDER_POLICY = 'AGENTMAIL_SENDER_POLICY';

export interface AgentMailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

const DEFAULT_AGENTMAIL_SENDER_POLICY: AgentMailSenderPolicy = {
  mode: 'allow_all',
  allowedEmails: [],
  allowedDomains: [],
  allowedRegex: null,
};

export interface AgentMailInstallSummary {
  connectionSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: AgentMailSenderPolicy;
  installedAt: string;
}

export interface AgentMailInstallInput {
  projectId: string;
  connectionSlug?: string | null;
  apiKey?: string | null;
  inboxId: string;
  email: string;
  displayName?: string | null;
  webhookId?: string | null;
  webhookSecret?: string | null;
  senderPolicy?: AgentMailSenderPolicy | null;
  /** Concrete agent for inbound messages. Null inherits the project default. */
  agentName?: string | null;
}

function agentMailConnectionSuffix(connectionSlug?: string | null): string {
  const slug = (connectionSlug || 'kortix_email').trim();
  if (!slug || slug === 'kortix_email') return '';
  return `_${slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function agentMailKeys(connectionSlug?: string | null) {
  const suffix = agentMailConnectionSuffix(connectionSlug);
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

function agentMailConnectionSlugFromInboxSecret(name: string): string | null {
  if (!name.startsWith(AGENTMAIL_INBOX_ID)) return null;
  const suffix = name.slice(AGENTMAIL_INBOX_ID.length);
  if (!suffix) return 'kortix_email';
  return suffix.replace(/^_+/, '').toLowerCase() || null;
}

export async function saveAgentMailInstall(
  input: AgentMailInstallInput,
): Promise<AgentMailInstallSummary> {
  const { projectId } = input;
  const connectionSlug = input.connectionSlug || 'kortix_email';
  const keys = agentMailKeys(connectionSlug);
  const previous = await loadAgentMailInstall(projectId, connectionSlug);
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
    await purgeInboxInstallRows(projectId, previous.inboxId, connectionSlug);
  }
  // Scope the inbox takeover delete to THIS project. An unscoped delete
  // (platform + workspaceId only) would wipe another project's install row for
  // the same inbox — a cross-tenant data-integrity bug that enabled the
  // AgentMail inbox hijack (pentest 2026-07-27). The first delete above already
  // filters by projectId; this one must too.
  await db
    .delete(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'email'),
        eq(chatInstalls.projectId, projectId),
        eq(chatInstalls.workspaceId, input.inboxId),
      ),
    );
  await db
    .insert(chatInstalls)
    .values({ platform: 'email', workspaceId: input.inboxId, projectId })
    .onConflictDoNothing({
      target: [chatInstalls.platform, chatInstalls.workspaceId, chatInstalls.projectId],
    });
  await db
    .insert(chatChannelBindings)
    .values({
      platform: 'email',
      workspaceId: input.inboxId,
      channelId: connectionSlug,
      projectId,
      channelName: input.email,
      channelType: 'inbox',
      agentName: input.agentName ?? null,
    })
    .onConflictDoNothing({
      target: [
        chatChannelBindings.platform,
        chatChannelBindings.workspaceId,
        chatChannelBindings.channelId,
      ],
    });
  return {
    connectionSlug,
    inboxId: input.inboxId,
    email: input.email,
    displayName: input.displayName ?? null,
    webhookId: input.webhookId ?? null,
    senderPolicy: normalizeSenderPolicy(input.senderPolicy),
    installedAt: new Date().toISOString(),
  };
}

/** The inbox's binding + install rows, so a re-install or delete leaves no stale rows. */
async function purgeInboxInstallRows(
  projectId: string,
  inboxId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'email'),
        eq(chatChannelBindings.projectId, projectId),
        eq(chatChannelBindings.workspaceId, inboxId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    );
  await db
    .delete(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'email'),
        eq(chatInstalls.projectId, projectId),
        eq(chatInstalls.workspaceId, inboxId),
      ),
    );
}

export async function deleteAgentMailInstall(
  projectId: string,
  connectionSlug?: string | null,
): Promise<void> {
  const keys = agentMailKeys(connectionSlug);
  const install = await loadAgentMailInstall(projectId, connectionSlug);
  await deleteProjectSecrets(projectId, Object.values(keys));
  if (install?.inboxId) {
    await purgeInboxInstallRows(
      projectId,
      install.inboxId,
      (connectionSlug || 'kortix_email').trim() || 'kortix_email',
    );
  } else if (!connectionSlug || connectionSlug === 'kortix_email') {
    await db
      .delete(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, projectId),
        ),
      );
    await db
      .delete(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.projectId, projectId)));
  }
}

export async function listAgentMailInstalls(projectId: string): Promise<AgentMailInstallSummary[]> {
  const rows = await db
    .select({ name: projectSecrets.name })
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
    const connectionSlug = agentMailConnectionSlugFromInboxSecret(row.name);
    if (!connectionSlug) continue;
    try {
      // Skip malformed or stale secret envelopes without poisoning the whole list.
      if (!(await readSecret(projectId, row.name))) continue;
      const install = await loadAgentMailInstall(projectId, connectionSlug);
      if (install) installs.push(install);
    } catch {}
  }
  return installs.sort((a, b) => a.connectionSlug.localeCompare(b.connectionSlug));
}

export async function updateAgentMailSenderPolicy(
  projectId: string,
  connectionSlug: string | null | undefined,
  senderPolicy: AgentMailSenderPolicy,
): Promise<AgentMailInstallSummary | null> {
  const install = await loadAgentMailInstall(projectId, connectionSlug);
  if (!install) return null;
  await upsertSecret(
    projectId,
    agentMailKeys(connectionSlug).senderPolicy,
    JSON.stringify(normalizeSenderPolicy(senderPolicy)),
  );
  return loadAgentMailInstall(projectId, connectionSlug);
}

export async function loadAgentMailInstall(
  projectId: string,
  connectionSlug?: string | null,
): Promise<AgentMailInstallSummary | null> {
  const keys = agentMailKeys(connectionSlug);
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
    connectionSlug: connectionSlug || 'kortix_email',
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
  connectionSlug?: string | null,
): Promise<string | null> {
  return readSecret(projectId, agentMailKeys(connectionSlug).apiKey);
}

/** The connection-suffix (possibly '') of the install whose inbox id matches, else null. */
async function agentMailConnectionForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  for (const row of rows) {
    if ((await readSecret(projectId, row.name)) !== inboxId) continue;
    return row.name.slice(AGENTMAIL_INBOX_ID.length);
  }
  return null;
}

export async function loadAgentMailApiKeyForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const suffix = await agentMailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return null;
  return readSecret(projectId, `${AGENTMAIL_API_KEY}${suffix}`);
}

export async function loadAgentMailWebhookSecretForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const suffix = await agentMailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return null;
  return readSecret(projectId, `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`);
}

export async function loadAgentMailSenderPolicyForInbox(
  projectId: string,
  inboxId: string,
): Promise<AgentMailSenderPolicy> {
  const suffix = await agentMailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return DEFAULT_AGENTMAIL_SENDER_POLICY;
  return parseSenderPolicy(await readSecret(projectId, `${AGENTMAIL_SENDER_POLICY}${suffix}`));
}

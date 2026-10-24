import { chatChannelBindings, chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, isNull, like } from 'drizzle-orm';
import { db } from '../../shared/db';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

// The email channel's install lives in connector-scoped project secrets. The
// `EMAIL_CHANNEL_` prefix keeps them apart from a project's own secrets: a
// plain `EMAIL_API_KEY` would overwrite one a person stored under that name.
export const EMAIL_CHANNEL_API_KEY = 'EMAIL_CHANNEL_API_KEY';
export const EMAIL_CHANNEL_INBOX_ID = 'EMAIL_CHANNEL_INBOX_ID';
export const EMAIL_CHANNEL_INBOX_EMAIL = 'EMAIL_CHANNEL_INBOX_EMAIL';
export const EMAIL_CHANNEL_INBOX_DISPLAY_NAME = 'EMAIL_CHANNEL_INBOX_DISPLAY_NAME';
export const EMAIL_CHANNEL_WEBHOOK_ID = 'EMAIL_CHANNEL_WEBHOOK_ID';
export const EMAIL_CHANNEL_WEBHOOK_SECRET = 'EMAIL_CHANNEL_WEBHOOK_SECRET';
export const EMAIL_CHANNEL_SENDER_POLICY = 'EMAIL_CHANNEL_SENDER_POLICY';
/** `1` when Kortix created the inbox at connect (deleted on disconnect); else attached. */
export const EMAIL_CHANNEL_CREATED_BY_KORTIX = 'EMAIL_CHANNEL_CREATED_BY_KORTIX';

/**
 * The prefix of the retired AgentMail install secrets (2026-10-24: the email
 * channel moved to Resend). They are dead: `purgeLegacyAgentMailInstall`
 * removes them with their rows, and nothing reads them.
 */
export const LEGACY_AGENTMAIL_SECRET_PREFIX = 'AGENTMAIL_';

export interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

const DEFAULT_EMAIL_CHANNEL_SENDER_POLICY: EmailSenderPolicy = {
  mode: 'allow_all',
  allowedEmails: [],
  allowedDomains: [],
  allowedRegex: null,
};

export interface EmailInstallSummary {
  connectionSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  /** Kortix created the inbox at connect: disconnect deletes it. Attached: only unlinked. */
  createdByKortix: boolean;
  installedAt: string;
}

export interface EmailInstallInput {
  projectId: string;
  connectionSlug?: string | null;
  apiKey?: string | null;
  inboxId: string;
  email: string;
  displayName?: string | null;
  webhookId?: string | null;
  webhookSecret?: string | null;
  senderPolicy?: EmailSenderPolicy | null;
  /** Kortix created the inbox (vs. attached an existing one by id). */
  createdByKortix?: boolean;
  /** Concrete agent for inbound messages. Null inherits the project default. */
  agentName?: string | null;
}

function emailConnectionSuffix(connectionSlug?: string | null): string {
  const slug = (connectionSlug || 'kortix_email').trim();
  if (!slug || slug === 'kortix_email') return '';
  return `_${slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function emailKeys(connectionSlug?: string | null) {
  const suffix = emailConnectionSuffix(connectionSlug);
  return {
    apiKey: `${EMAIL_CHANNEL_API_KEY}${suffix}`,
    inboxId: `${EMAIL_CHANNEL_INBOX_ID}${suffix}`,
    email: `${EMAIL_CHANNEL_INBOX_EMAIL}${suffix}`,
    displayName: `${EMAIL_CHANNEL_INBOX_DISPLAY_NAME}${suffix}`,
    webhookId: `${EMAIL_CHANNEL_WEBHOOK_ID}${suffix}`,
    webhookSecret: `${EMAIL_CHANNEL_WEBHOOK_SECRET}${suffix}`,
    senderPolicy: `${EMAIL_CHANNEL_SENDER_POLICY}${suffix}`,
    createdByKortix: `${EMAIL_CHANNEL_CREATED_BY_KORTIX}${suffix}`,
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
  input?: Partial<EmailSenderPolicy> | null,
): EmailSenderPolicy {
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

function parseSenderPolicy(raw: string | null): EmailSenderPolicy {
  if (!raw) return DEFAULT_EMAIL_CHANNEL_SENDER_POLICY;
  try {
    return normalizeSenderPolicy(JSON.parse(raw) as Partial<EmailSenderPolicy>);
  } catch {
    return DEFAULT_EMAIL_CHANNEL_SENDER_POLICY;
  }
}

function emailConnectionSlugFromInboxSecret(name: string): string | null {
  if (!name.startsWith(EMAIL_CHANNEL_INBOX_ID)) return null;
  const suffix = name.slice(EMAIL_CHANNEL_INBOX_ID.length);
  if (!suffix) return 'kortix_email';
  return suffix.replace(/^_+/, '').toLowerCase() || null;
}

export async function saveEmailInstall(
  input: EmailInstallInput,
): Promise<EmailInstallSummary> {
  const { projectId } = input;
  const connectionSlug = input.connectionSlug || 'kortix_email';
  const keys = emailKeys(connectionSlug);
  const previous = await loadEmailInstall(projectId, connectionSlug);
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
  await upsertSecret(projectId, keys.createdByKortix, input.createdByKortix ? '1' : '0');
  if (input.webhookSecret) {
    await upsertSecret(projectId, keys.webhookSecret, input.webhookSecret);
  }
  if (previous?.inboxId) {
    await purgeInboxInstallRows(projectId, previous.inboxId, connectionSlug);
  }
  // Scope the inbox takeover delete to THIS project. An unscoped delete
  // (platform + workspaceId only) would wipe another project's install row for
  // the same inbox — a cross-tenant data-integrity bug that enabled the
  // inbox hijack (pentest 2026-07-27). The first delete above already
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
    createdByKortix: Boolean(input.createdByKortix),
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

export async function deleteEmailInstall(
  projectId: string,
  connectionSlug?: string | null,
): Promise<void> {
  const keys = emailKeys(connectionSlug);
  const install = await loadEmailInstall(projectId, connectionSlug);
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

export async function listEmailInstalls(projectId: string): Promise<EmailInstallSummary[]> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${EMAIL_CHANNEL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  const installs: EmailInstallSummary[] = [];
  for (const row of rows) {
    const connectionSlug = emailConnectionSlugFromInboxSecret(row.name);
    if (!connectionSlug) continue;
    try {
      // Skip malformed or stale secret envelopes without poisoning the whole list.
      if (!(await readSecret(projectId, row.name))) continue;
      const install = await loadEmailInstall(projectId, connectionSlug);
      if (install) installs.push(install);
    } catch {}
  }
  return installs.sort((a, b) => a.connectionSlug.localeCompare(b.connectionSlug));
}

export async function updateEmailSenderPolicy(
  projectId: string,
  connectionSlug: string | null | undefined,
  senderPolicy: EmailSenderPolicy,
): Promise<EmailInstallSummary | null> {
  const install = await loadEmailInstall(projectId, connectionSlug);
  if (!install) return null;
  await upsertSecret(
    projectId,
    emailKeys(connectionSlug).senderPolicy,
    JSON.stringify(normalizeSenderPolicy(senderPolicy)),
  );
  return loadEmailInstall(projectId, connectionSlug);
}

export async function loadEmailInstall(
  projectId: string,
  connectionSlug?: string | null,
): Promise<EmailInstallSummary | null> {
  const keys = emailKeys(connectionSlug);
  const [inboxId, email, displayName, webhookId, senderPolicyRaw, createdByKortix] = await Promise.all([
      readSecret(projectId, keys.inboxId),
      readSecret(projectId, keys.email),
      readSecret(projectId, keys.displayName),
      readSecret(projectId, keys.webhookId),
      readSecret(projectId, keys.senderPolicy),
      readSecret(projectId, keys.createdByKortix),
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
    // An install from before the marker reads as attached: never deleted.
    createdByKortix: createdByKortix === '1',
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadEmailApiKeyForProject(
  projectId: string,
  connectionSlug?: string | null,
): Promise<string | null> {
  return readSecret(projectId, emailKeys(connectionSlug).apiKey);
}

/** The connection-suffix (possibly '') of the install whose inbox id matches, else null. */
async function emailConnectionForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${EMAIL_CHANNEL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  for (const row of rows) {
    if ((await readSecret(projectId, row.name)) !== inboxId) continue;
    return row.name.slice(EMAIL_CHANNEL_INBOX_ID.length);
  }
  return null;
}

export async function loadEmailApiKeyForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const suffix = await emailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return null;
  return readSecret(projectId, `${EMAIL_CHANNEL_API_KEY}${suffix}`);
}

export async function loadEmailWebhookSecretForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const suffix = await emailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return null;
  return readSecret(projectId, `${EMAIL_CHANNEL_WEBHOOK_SECRET}${suffix}`);
}

export async function loadEmailSenderPolicyForInbox(
  projectId: string,
  inboxId: string,
): Promise<EmailSenderPolicy> {
  const suffix = await emailConnectionForInbox(projectId, inboxId);
  if (suffix === null) return DEFAULT_EMAIL_CHANNEL_SENDER_POLICY;
  return parseSenderPolicy(await readSecret(projectId, `${EMAIL_CHANNEL_SENDER_POLICY}${suffix}`));
}

/**
 * Remove a project's retired AgentMail install: its `AGENTMAIL_*` secrets and
 * the email rows that point at an inbox with no `EMAIL_CHANNEL_INBOX_ID`
 * secret. Idempotent; a project with nothing left does nothing.
 */
export async function purgeLegacyAgentMailInstall(projectId: string): Promise<number> {
  const legacy = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${LEGACY_AGENTMAIL_SECRET_PREFIX}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  if (legacy.length === 0) return 0;
  await deleteProjectSecrets(projectId, legacy.map((row) => row.name));
  const live = new Set((await listEmailInstalls(projectId)).map((install) => install.inboxId));
  const rows = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.projectId, projectId)));
  for (const row of rows) {
    if (live.has(row.workspaceId)) continue;
    await db
      .delete(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, projectId),
          eq(chatChannelBindings.workspaceId, row.workspaceId),
        ),
      );
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.projectId, projectId),
          eq(chatInstalls.workspaceId, row.workspaceId),
        ),
      );
  }
  return legacy.length;
}

import {
  chatChannelBindings,
  chatInstalls,
  connectionCredentials,
  connectorConnections,
  connectors,
  projectSecrets,
} from '@kortix/db';
import { and, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { decryptChannelSecret, deleteProjectSecrets, encryptChannelSecret } from '../install-store';

/**
 * Email inboxes are ACCOUNTS of the project's one `kortix_email` connector
 * (2026-10-24): one `connector_connections` row per Resend inbox, owned by a
 * member ("only me") or by the project (audience grants), the first of each
 * owner its default. The row's metadata holds the inbox; its credential holds
 * the own-key Resend API key and the webhook signing secret. `chat_installs`
 * (platform `email`, workspace = inbox id) is the cross-project ownership gate
 * and the inbound lookup. Nothing lives in project secrets any more.
 */
export const EMAIL_CONNECTOR_SLUG = 'kortix_email';

/** How long an inbox claim may exist without its account (an add in flight). */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** Retired per-slug install secrets (Resend, before accounts): purged on reconcile. */
export const EMAIL_CHANNEL_SECRET_PREFIX = 'EMAIL_CHANNEL_';
/** Retired AgentMail install secrets (before 2026-10-24): purged on reconcile. */
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

/** One inbox account of `kortix_email`. */
export interface EmailInboxAccount {
  connectionId: string;
  connectorId: string;
  projectId: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  label: string;
  ownerType: 'member' | 'project';
  ownerId: string | null;
  isDefault: boolean;
  /** On Kortix's Resend team (no own key). */
  managed: boolean;
  /** Kortix created the inbox: removing the account deletes it. Attached: only unlinked. */
  createdByKortix: boolean;
  senderPolicy: EmailSenderPolicy;
  /** Concrete agent for inbound mail. Null inherits the project default. */
  agentName: string | null;
  webhookId: string | null;
  createdAt: string;
}

interface EmailAccountCredential {
  api_key: string | null;
  webhook_secret: string | null;
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

type ConnectionRow = typeof connectorConnections.$inferSelect;

function toAccount(row: ConnectionRow): EmailInboxAccount | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const inboxId = typeof meta.inbox_id === 'string' ? meta.inbox_id : '';
  const email = typeof meta.email === 'string' ? meta.email : '';
  if (!inboxId || !email) return null;
  if (row.ownerType !== 'member' && row.ownerType !== 'project') return null;
  return {
    connectionId: row.connectionId,
    connectorId: row.connectorId,
    projectId: row.projectId,
    inboxId,
    email,
    displayName: typeof meta.display_name === 'string' && meta.display_name ? meta.display_name : null,
    label: row.label,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    isDefault: row.isDefault,
    managed: meta.managed === true,
    createdByKortix: meta.created_by_kortix === true,
    senderPolicy: normalizeSenderPolicy(
      (meta.sender_policy ?? null) as Partial<EmailSenderPolicy> | null,
    ),
    agentName: typeof meta.agent_name === 'string' && meta.agent_name ? meta.agent_name : null,
    webhookId: typeof meta.webhook_id === 'string' && meta.webhook_id ? meta.webhook_id : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The project's `kortix_email` connector row id, or null before it is materialized. */
export async function emailConnectorId(projectId: string): Promise<string | null> {
  return (await emailConnectorState(projectId))?.connectorId ?? null;
}

/**
 * The `kortix_email` connector row and whether it is live. Sync disables
 * (rather than deletes) it when its last inbox goes while sessions still bind
 * it, so the next inbox has to bring it back.
 */
export async function emailConnectorState(
  projectId: string,
): Promise<{ connectorId: string; live: boolean } | null> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId, enabled: connectors.enabled, status: connectors.status })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, EMAIL_CONNECTOR_SLUG)))
    .limit(1);
  return row ? { connectorId: row.connectorId, live: row.enabled && row.status === 'active' } : null;
}

/** Every active inbox account of the project, default first, then oldest. */
export async function listEmailInboxAccounts(projectId: string): Promise<EmailInboxAccount[]> {
  const connectorId = await emailConnectorId(projectId);
  if (!connectorId) return [];
  const rows = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.connectorId, connectorId),
        eq(connectorConnections.status, 'active'),
        sql`${connectorConnections.metadata} ? 'inbox_id'`,
      ),
    );
  return rows
    .map(toAccount)
    .filter((account): account is EmailInboxAccount => account !== null)
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        Number(b.ownerType === 'project') - Number(a.ownerType === 'project') ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

export async function loadEmailInboxAccount(
  projectId: string,
  connectionId: string,
): Promise<EmailInboxAccount | null> {
  return (await listEmailInboxAccounts(projectId)).find((a) => a.connectionId === connectionId) ?? null;
}

export async function loadEmailInboxAccountForInbox(
  projectId: string,
  inboxId: string,
): Promise<EmailInboxAccount | null> {
  return (await listEmailInboxAccounts(projectId)).find((a) => a.inboxId === inboxId) ?? null;
}

/**
 * The account a project-level call means when it names no inbox: the project's
 * default shared inbox, else the oldest shared one, else the oldest at all.
 */
export async function loadDefaultEmailInboxAccount(
  projectId: string,
): Promise<EmailInboxAccount | null> {
  return (await listEmailInboxAccounts(projectId))[0] ?? null;
}

/** Whether the project holds any inbox (the `kortix_email` connector is materialized from this). */
export async function hasEmailInboxes(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Claim the inbox for this project before its account exists: the ownership
 * gate (one project per inbox) and the inbound lookup, plus the binding that
 * carries the inbox's agent.
 */
export async function reserveEmailInbox(input: {
  projectId: string;
  inboxId: string;
  email: string;
  agentName: string | null;
}): Promise<void> {
  await db
    .insert(chatInstalls)
    .values({ platform: 'email', workspaceId: input.inboxId, projectId: input.projectId })
    .onConflictDoNothing({
      target: [chatInstalls.platform, chatInstalls.workspaceId, chatInstalls.projectId],
    });
  await db
    .insert(chatChannelBindings)
    .values({
      platform: 'email',
      workspaceId: input.inboxId,
      channelId: input.inboxId,
      projectId: input.projectId,
      channelName: input.email,
      channelType: 'inbox',
      agentName: input.agentName,
    })
    .onConflictDoUpdate({
      target: [
        chatChannelBindings.platform,
        chatChannelBindings.workspaceId,
        chatChannelBindings.channelId,
      ],
      set: { agentName: input.agentName, channelName: input.email },
    });
}

/** Undo `reserveEmailInbox` for this project. */
export async function releaseEmailInbox(projectId: string, inboxId: string): Promise<void> {
  await db
    .delete(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'email'),
        eq(chatChannelBindings.projectId, projectId),
        eq(chatChannelBindings.workspaceId, inboxId),
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

/** A label no other account of this owner holds: the address, then "address (2)", … */
function uniqueLabel(wanted: string, taken: Set<string>): string {
  const base = wanted.trim().slice(0, 120) || 'Email';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const next = `${base} (${n})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${base} (${Date.now()})`;
}

/**
 * Insert the inbox as an account of `kortix_email`. The first account of its
 * owner (the project, or that member) becomes that owner's default, the same
 * rule a paired computer follows. The credential holds the own key (null on
 * the managed team) and the webhook signing secret.
 */
export async function insertEmailInboxAccount(input: {
  accountId: string;
  projectId: string;
  connectorId: string;
  ownerType: 'member' | 'project';
  ownerId: string | null;
  label?: string | null;
  inboxId: string;
  email: string;
  displayName: string | null;
  senderPolicy: EmailSenderPolicy;
  agentName: string | null;
  managed: boolean;
  createdByKortix: boolean;
  webhookId: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
  createdBy: string | null;
}): Promise<EmailInboxAccount> {
  const row = await db.transaction(async (tx) => {
    await tx
      .select({ connectorId: connectors.connectorId })
      .from(connectors)
      .where(eq(connectors.connectorId, input.connectorId))
      .for('update');
    const owner = and(
      eq(connectorConnections.connectorId, input.connectorId),
      eq(connectorConnections.ownerType, input.ownerType),
      input.ownerId === null
        ? isNull(connectorConnections.ownerId)
        : eq(connectorConnections.ownerId, input.ownerId),
    );
    // A revoked row keeps no default: its flag would collide with the new
    // account's in the one-default-per-owner index.
    await tx
      .update(connectorConnections)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(owner, eq(connectorConnections.isDefault, true), ne(connectorConnections.status, 'active')));
    const rows = await tx.select().from(connectorConnections).where(owner);
    const hasDefault = rows.some((r) => r.isDefault && r.status === 'active');
    const [created] = await tx
      .insert(connectorConnections)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        connectorId: input.connectorId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        label: uniqueLabel(input.label || input.email, new Set(rows.map((r) => r.label.toLowerCase()))),
        status: 'active',
        isDefault: !hasDefault,
        createdBy: input.createdBy,
        metadata: {
          inbox_id: input.inboxId,
          email: input.email,
          display_name: input.displayName,
          sender_policy: input.senderPolicy,
          agent_name: input.agentName,
          managed: input.managed,
          created_by_kortix: input.createdByKortix,
          webhook_id: input.webhookId,
        },
      })
      .returning();
    const credential: EmailAccountCredential = {
      api_key: input.apiKey,
      webhook_secret: input.webhookSecret,
    };
    await tx.insert(connectionCredentials).values({
      connectorId: input.connectorId,
      connectionId: created!.connectionId,
      userId: null,
      kind: 'secret',
      valueEnc: encryptChannelSecret(input.projectId, JSON.stringify(credential)),
      createdBy: input.createdBy,
    });
    return created!;
  });
  return toAccount(row)!;
}

/** Change what the account says about its inbox: sender policy, agent, display name, label. */
export async function updateEmailInboxAccount(
  account: EmailInboxAccount,
  patch: {
    senderPolicy?: EmailSenderPolicy;
    agentName?: string | null;
    displayName?: string | null;
    label?: string;
  },
): Promise<EmailInboxAccount | null> {
  const metadata: Record<string, unknown> = {};
  if (patch.senderPolicy) metadata.sender_policy = patch.senderPolicy;
  if (patch.agentName !== undefined) metadata.agent_name = patch.agentName;
  if (patch.displayName !== undefined) metadata.display_name = patch.displayName;
  await db
    .update(connectorConnections)
    .set({
      metadata: sql`${connectorConnections.metadata} || ${JSON.stringify(metadata)}::jsonb`,
      ...(patch.label ? { label: patch.label.trim().slice(0, 120) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(connectorConnections.connectionId, account.connectionId));
  if (patch.agentName !== undefined) {
    await db
      .update(chatChannelBindings)
      .set({ agentName: patch.agentName })
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, account.projectId),
          eq(chatChannelBindings.workspaceId, account.inboxId),
        ),
      );
  }
  return loadEmailInboxAccount(account.projectId, account.connectionId);
}

/**
 * Remove the account. The row is revoked, not deleted (a session that used it
 * keeps its binding), and its label is freed so the address can come back.
 * Its credential goes, and the inbox's project claim is released. If it was
 * the owner's default, the next oldest active account of that owner takes over.
 */
export async function revokeEmailInboxAccount(account: EmailInboxAccount): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(connectorConnections)
      .set({
        status: 'revoked',
        isDefault: false,
        label: `${account.label} (removed ${account.connectionId.slice(0, 8)})`.slice(0, 200),
        metadata: sql`${connectorConnections.metadata} || '{"revokedReason":"inbox removed"}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(connectorConnections.connectionId, account.connectionId));
    await tx
      .delete(connectionCredentials)
      .where(eq(connectionCredentials.connectionId, account.connectionId));
    if (account.isDefault) {
      const [next] = await tx
        .select({ connectionId: connectorConnections.connectionId })
        .from(connectorConnections)
        .where(
          and(
            eq(connectorConnections.connectorId, account.connectorId),
            eq(connectorConnections.ownerType, account.ownerType),
            account.ownerId === null
              ? isNull(connectorConnections.ownerId)
              : eq(connectorConnections.ownerId, account.ownerId),
            eq(connectorConnections.status, 'active'),
            ne(connectorConnections.connectionId, account.connectionId),
          ),
        )
        .orderBy(connectorConnections.createdAt)
        .limit(1);
      if (next) {
        await tx
          .update(connectorConnections)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(connectorConnections.connectionId, next.connectionId));
      }
    }
  });
  await releaseEmailInbox(account.projectId, account.inboxId);
}

async function readAccountCredential(account: {
  connectionId: string;
  projectId: string;
}): Promise<EmailAccountCredential> {
  const [row] = await db
    .select({ valueEnc: connectionCredentials.valueEnc })
    .from(connectionCredentials)
    .where(eq(connectionCredentials.connectionId, account.connectionId))
    .limit(1);
  if (!row) return { api_key: null, webhook_secret: null };
  try {
    const parsed = JSON.parse(decryptChannelSecret(account.projectId, row.valueEnc)) as Partial<EmailAccountCredential>;
    return {
      api_key: typeof parsed.api_key === 'string' && parsed.api_key ? parsed.api_key : null,
      webhook_secret:
        typeof parsed.webhook_secret === 'string' && parsed.webhook_secret ? parsed.webhook_secret : null,
    };
  } catch {
    return { api_key: null, webhook_secret: null };
  }
}

/** The account's own Resend key, or null on the managed team. */
export async function emailOwnKeyForAccount(account: EmailInboxAccount): Promise<string | null> {
  return (await readAccountCredential(account)).api_key;
}

/** The own key of the account that owns `inboxId`, or null (managed, or no such account). */
export async function emailOwnKeyForInbox(projectId: string, inboxId: string): Promise<string | null> {
  const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
  return account ? emailOwnKeyForAccount(account) : null;
}

/**
 * Point the account at its team's current webhook. The webhook can change
 * under an inbox (a dev tunnel restarts, a webhook is recreated), and the
 * account then holds a secret nothing signs with any more.
 */
export async function updateEmailAccountWebhook(
  account: EmailInboxAccount,
  webhook: { id: string; signing_secret: string },
): Promise<void> {
  const current = await readAccountCredential(account);
  await db
    .update(connectionCredentials)
    .set({
      valueEnc: encryptChannelSecret(
        account.projectId,
        JSON.stringify({ api_key: current.api_key, webhook_secret: webhook.signing_secret }),
      ),
      updatedAt: new Date(),
    })
    .where(eq(connectionCredentials.connectionId, account.connectionId));
  await db
    .update(connectorConnections)
    .set({
      metadata: sql`${connectorConnections.metadata} || ${JSON.stringify({ webhook_id: webhook.id })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(connectorConnections.connectionId, account.connectionId));
}

/** The webhook signing secret that verifies mail for `inboxId`. */
export async function emailWebhookSecretForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
  return account ? (await readAccountCredential(account)).webhook_secret : null;
}

/** The sender policy of the inbox's account (allow-all when it has none). */
export async function emailSenderPolicyForInbox(
  projectId: string,
  inboxId: string,
): Promise<EmailSenderPolicy> {
  const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
  return account?.senderPolicy ?? DEFAULT_EMAIL_CHANNEL_SENDER_POLICY;
}

/**
 * Drop email state from before inboxes were accounts: the AgentMail and
 * per-slug `EMAIL_CHANNEL_*` secrets, the `external`-owned rows they made, and
 * any inbox claim with no active account. Idempotent.
 */
export async function purgeLegacyEmailState(projectId: string): Promise<number> {
  const secrets = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        isNull(projectSecrets.ownerUserId),
        or(
          like(projectSecrets.name, `${LEGACY_AGENTMAIL_SECRET_PREFIX}%`),
          like(projectSecrets.name, `${EMAIL_CHANNEL_SECRET_PREFIX}%`),
        ),
      ),
    );
  if (secrets.length > 0) await deleteProjectSecrets(projectId, secrets.map((row) => row.name));

  const connectorId = await emailConnectorId(projectId);
  let revoked = 0;
  if (connectorId) {
    const stale = await db
      .update(connectorConnections)
      .set({ status: 'revoked', isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(connectorConnections.connectorId, connectorId),
          eq(connectorConnections.status, 'active'),
          or(
            eq(connectorConnections.ownerType, 'external'),
            sql`not (${connectorConnections.metadata} ? 'inbox_id')`,
          ),
        ),
      )
      .returning({ connectionId: connectorConnections.connectionId });
    revoked = stale.length;
    await db
      .update(connectorConnections)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(connectorConnections.connectorId, connectorId),
          eq(connectorConnections.isDefault, true),
          ne(connectorConnections.status, 'active'),
        ),
      );
  }

  const live = new Set((await listEmailInboxAccounts(projectId)).map((a) => a.inboxId));
  // An add claims the inbox before its account row exists (and may sync in
  // between), so a claim younger than ORPHAN_GRACE_MS is never an orphan yet.
  const claims = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'email'),
        eq(chatInstalls.projectId, projectId),
        lt(chatInstalls.connectedAt, new Date(Date.now() - ORPHAN_GRACE_MS)),
      ),
    );
  const orphans = claims.map((c) => c.workspaceId).filter((id) => !live.has(id));
  if (connectorId && orphans.length > 0) {
    await db
      .delete(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, projectId),
          inArray(chatChannelBindings.workspaceId, orphans),
        ),
      );
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.projectId, projectId),
          inArray(chatInstalls.workspaceId, orphans),
        ),
      );
  }
  return secrets.length + revoked;
}

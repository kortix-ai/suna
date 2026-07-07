import { accountMembers, inboxItems, projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import type { SessionInvocationSource } from '../projects/session-lifecycle/types';

export type InboxItemKind = (typeof inboxItems.$inferInsert)['kind'];

const BACKGROUND_SOURCES: ReadonlySet<string> = new Set<SessionInvocationSource>([
  'trigger:webhook',
  'trigger:cron',
  'trigger:manual',
  'slack',
  'email',
  'telegram',
  'meet',
]);

export function isBackgroundSource(source: unknown): boolean {
  return typeof source === 'string' && BACKGROUND_SOURCES.has(source);
}

export function sessionSourceKind(source: unknown): string | null {
  switch (source) {
    case 'trigger:cron':
      return 'schedule';
    case 'trigger:webhook':
    case 'trigger:manual':
      return 'webhook';
    case 'slack':
      return 'slack';
    case 'telegram':
      return 'telegram';
    case 'email':
      return 'email';
    case 'meet':
      return 'meet';
    default:
      return null;
  }
}

type SessionRow = typeof projectSessions.$inferSelect;

export function inboxTitle(row: Pick<SessionRow, 'metadata' | 'branchName' | 'sessionId'>): string {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const customName = typeof meta.custom_name === 'string' ? meta.custom_name.trim() : '';
  const autoName = typeof meta.name === 'string' ? meta.name.trim() : '';
  const triggerSlug = typeof meta.trigger_slug === 'string' ? meta.trigger_slug.trim() : '';
  return customName || triggerSlug || autoName || row.branchName || row.sessionId;
}

export function attentionDedupKey(kind: InboxItemKind, sessionId: string, at: number): string {
  const minuteBucket = Math.floor(at / 60_000);
  return `${kind}:${sessionId}:${minuteBucket}`;
}

export interface RecordAttentionInput {
  accountId: string;
  projectId: string;
  userId: string;
  kind: InboxItemKind;
  title: string;
  dedupKey: string;
  sessionId?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAttention(input: RecordAttentionInput): Promise<void> {
  try {
    await db
      .insert(inboxItems)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        dedupKey: input.dedupKey,
        sessionId: input.sessionId ?? null,
        source: input.source ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({ target: [inboxItems.userId, inboxItems.dedupKey] });
  } catch (err) {
    console.warn(`[inbox] recordAttention failed (${input.kind}): ${String(err)}`);
  }
}

async function resolveInboxRecipient(
  accountId: string,
  fallbackUserId: string | null,
): Promise<string | null> {
  const [owner] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  return owner?.userId ?? fallbackUserId;
}

export async function recordSessionAttention(
  sessionId: string,
  kind: InboxItemKind,
  opts: { dedupKey?: string; metadata?: Record<string, unknown>; now?: number } = {},
): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!row) return;

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const source = meta.source;
    if (!isBackgroundSource(source)) return;

    const userId = await resolveInboxRecipient(row.accountId, row.createdBy);
    if (!userId) return;

    const triggerSlug = typeof meta.trigger_slug === 'string' ? meta.trigger_slug : undefined;
    const at = opts.now ?? Date.now();
    await recordAttention({
      accountId: row.accountId,
      projectId: row.projectId,
      userId,
      kind,
      title: inboxTitle(row),
      dedupKey: opts.dedupKey ?? attentionDedupKey(kind, sessionId, at),
      sessionId,
      source: sessionSourceKind(source),
      metadata: { ...opts.metadata, ...(triggerSlug ? { trigger_slug: triggerSlug } : {}) },
    });
  } catch (err) {
    console.warn(`[inbox] recordSessionAttention failed (${sessionId}, ${kind}): ${String(err)}`);
  }
}

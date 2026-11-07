/**
 * The split's owner email (design.md §3.2 C9): one email per (owner, source
 * account) when the account's last move is `done`. Owners only, never a
 * member, never a bulk send. `renderSplitOwnerEmail` is its one template.
 *
 * The outbox is `kortix.workspace_split_emails`, one row per
 * `workspace-split-email:<from_account_id>:<user_id>` (unique). The split
 * enqueues the rows when the account's last move is done; the leader tick
 * delivers them:
 *
 *   pending → sending (claimed: attempts + 1, lease OWNER_EMAIL_LEASE_MS)
 *           → sent | skipped (no address, no provider) | failed
 *   failed  → retried after a backoff, up to OWNER_EMAIL_MAX_ATTEMPTS
 *   sending with an expired lease (the process died mid-send) → claimed again
 *
 * Nothing is sent unless the split mode is `apply`: in `off` and `dry_run`
 * the rows wait. A claim takes `FOR UPDATE SKIP LOCKED` and every result
 * write is fenced on the claim's `attempts`, so two processes never send the
 * same row at once and a stale process never overwrites a newer result.
 * Delivery is at least once: only a crash after the provider accepted and
 * before the `sent` write sends again, and the message carries the row's key
 * as its idempotency key (Resend drops the repeat).
 */
import { sql } from 'drizzle-orm';
import { workspaceSettingsPath } from '@kortix/shared/workspace-settings';
import { config } from '../../config';
import type { WorkspaceSplitMode } from './split-runner';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { escapeHtml } from '../../shared/html';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { sendEmail as transportSendEmail } from '../../lib/email/transport';
import type { EmailMessage, EmailSendResult } from '../../lib/email/types';

export const OWNER_EMAIL_MAX_ATTEMPTS = 5;
/** How long a claimed send may run before another tick takes it back. */
export const OWNER_EMAIL_LEASE_MS = 5 * 60_000;
export type SendEmail = (message: EmailMessage) => Promise<EmailSendResult>;

export const splitEmailKey = (fromAccountId: string, userId: string) => `workspace-split-email:${fromAccountId}:${userId}`;

/** One workspace of a finished split, as the email lists it. */
export interface SplitWorkspaceLine {
  name: string;
  role: 'keeper' | 'moved';
  billing: 'free' | 'comped' | null;
  compedUntil: string | null;
}

export interface SplitEmailInput {
  email: string;
  sourceName: string;
  keeperWorkspaceId: string;
  workspaces: SplitWorkspaceLine[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function lineText(line: SplitWorkspaceLine): string {
  if (line.role === 'keeper') return 'keeps the plan, the credits and the billing history';
  if (line.billing === 'comped' && line.compedUntil) return `on your plan at no charge until ${day(line.compedUntil)}, then Free`;
  if (line.billing === 'comped') return 'on your plan at no charge until the current period ends, then Free';
  if (line.billing === 'free') return 'on Free, with this month’s free credits';
  // Never claim a plan the split did not record.
  return 'its plan is being set up: open its Billing settings to see it';
}

/** The owner email without sending it (brand voice 5.5: subject = the action, one button, one note). */
export function renderSplitOwnerEmail(input: SplitEmailInput): { subject: string; html: string; text: string } {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}${workspaceSettingsPath(input.keeperWorkspaceId, 'general')}`;
  const title = 'Review your new workspaces';
  const count = input.workspaces.length;
  const lead = `${input.sourceName} held ${count} projects. Each one is now its own workspace, with its own members, settings and billing.`;
  const note = 'Nothing was deleted: every session, file and history stayed with its project. Only people with access to a project joined its workspace. If a workspace asks you to reconnect ChatGPT or OpenCode, sign in again there.';
  const rows = input.workspaces
    .map((line) => `<div style="${S.row}"><span style="${S.strong}">${escapeHtml(line.name)}</span><br>${escapeHtml(lineText(line))}</div>`)
    .join('');
  const html = renderEmail({
    title,
    body: `
      <p style="${S.p}">${escapeHtml(lead)}</p>
      ${rows}
      ${actionButton(url, 'Review workspaces')}
      <p style="${S.smallNote}">${escapeHtml(note)}</p>
    `,
  });
  return {
    subject: 'Review your new Kortix workspaces',
    html,
    text: renderText({
      title,
      paragraphs: [lead, ...input.workspaces.map((line) => `${line.name}: ${lineText(line)}.`)],
      cta: { url, label: 'Review workspaces' },
      note,
    }),
  };
}

/** The account's finished split: its first done run, its owners and their workspaces. */
async function finishedSplit(fromAccountId: string) {
  const [anchor] = await db.execute<{ run_id: string; source_name: string; keeper_id: string | null }>(sql`
    SELECT r.run_id::text,
           COALESCE(b.old_name, a.name) AS source_name,
           (SELECT p.project_id::text FROM kortix.projects p
             WHERE p.account_id = r.from_account_id AND p.status = 'active' LIMIT 1) AS keeper_id
      FROM kortix.workspace_split_runs r
      JOIN kortix.accounts a ON a.account_id = r.from_account_id
      LEFT JOIN kortix.workspace_name_backups b ON b.account_id = r.from_account_id
     WHERE r.from_account_id = ${fromAccountId} AND r.phase = 'done'
     ORDER BY r.completed_at, r.run_id LIMIT 1`);
  if (!anchor?.keeper_id) return null;
  const workspaces = await db.execute<{ name: string; role: 'keeper' | 'moved'; billing: 'free' | 'comped' | null; comped_until: string | null; ord: number }>(sql`
    SELECT p.name, 'keeper' AS role, NULL AS billing, NULL AS comped_until, 0 AS ord
      FROM kortix.projects p WHERE p.project_id = ${anchor.keeper_id}
    UNION ALL
    SELECT p.name, 'moved', r.plan->'billing'->>'kind', r.plan->'billing'->>'compedUntil', 1
      FROM kortix.workspace_split_runs r JOIN kortix.projects p ON p.project_id = r.project_id AND p.account_id = r.to_account_id
     WHERE r.from_account_id = ${fromAccountId} AND r.phase = 'done'
     ORDER BY ord, name`);
  const owners = await db.execute<{ user_id: string; email: string | null }>(sql`
    SELECT DISTINCT ra.principal_id::text AS user_id, u.email
      FROM kortix.role_assignments ra
      JOIN kortix.roles r ON r.role_id = ra.role_id AND r.account_id IS NULL AND r.key = 'owner' AND r.scope_type = 'account'
      JOIN kortix.account_memberships m ON m.account_id = ra.account_id AND m.user_id = ra.principal_id
      LEFT JOIN auth.users u ON u.id = ra.principal_id
     WHERE ra.account_id = ${fromAccountId} AND ra.principal_type = 'user' AND ra.scope_type = 'account'
       AND (ra.expires_at IS NULL OR ra.expires_at > now())
     ORDER BY 1`);
  return { anchorRunId: anchor.run_id, sourceName: anchor.source_name, keeperId: anchor.keeper_id, workspaces, owners };
}

/**
 * One outbox row per owner of `fromAccountId`'s finished split. The caller
 * checked that the account's last move is done. A second call adds nothing
 * (the key is unique). Returns how many rows it added.
 */
export async function enqueueSplitOwnerEmails(fromAccountId: string): Promise<number> {
  const split = await finishedSplit(fromAccountId);
  if (!split || split.workspaces.length < 2 || !split.owners.length) return 0;
  const added = await db.execute<{ email_id: string }>(sql`
    INSERT INTO kortix.workspace_split_emails (idempotency_key, from_account_id, user_id, run_id)
    SELECT 'workspace-split-email:' || ${fromAccountId} || ':' || owner_id, ${fromAccountId}::uuid, owner_id::uuid, ${split.anchorRunId}::uuid
      FROM jsonb_array_elements_text(${JSON.stringify(split.owners.map((o) => o.user_id))}::jsonb) AS owner_id
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING email_id::text`);
  return added.length;
}

type ClaimedEmail = { email_id: string; idempotency_key: string; from_account_id: string; user_id: string; attempts: number };

/** Backoff after a failed attempt: 2, 4, 8, 16 minutes, at most an hour. */
function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 2 ** attempts * 60_000);
}

async function claimDue(limit: number, fromAccountId?: string): Promise<ClaimedEmail[]> {
  const scope = fromAccountId ? sql`AND from_account_id = ${fromAccountId}` : sql``;
  // A send that ran out of attempts while its lease was held ends as failed.
  await db.execute(sql`UPDATE kortix.workspace_split_emails
    SET state = 'failed', lease_until = NULL, last_error = COALESCE(last_error, 'lease_expired'), updated_at = now()
    WHERE state = 'sending' AND lease_until < now() AND attempts >= ${OWNER_EMAIL_MAX_ATTEMPTS} ${scope}`);
  return db.execute<ClaimedEmail>(sql`
    UPDATE kortix.workspace_split_emails e
       SET state = 'sending', attempts = e.attempts + 1, updated_at = now(),
           lease_until = now() + make_interval(secs => ${OWNER_EMAIL_LEASE_MS / 1000})
     WHERE e.email_id IN (
       SELECT email_id FROM kortix.workspace_split_emails
        WHERE attempts < ${OWNER_EMAIL_MAX_ATTEMPTS} ${scope}
          AND ((state IN ('pending', 'failed') AND next_attempt_at <= now())
               OR (state = 'sending' AND lease_until < now()))
        ORDER BY next_attempt_at, email_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING e.email_id::text, e.idempotency_key, e.from_account_id::text, e.user_id::text, e.attempts`);
}

/** Record one attempt's result, fenced on the claim. */
async function settle(row: ClaimedEmail, state: 'sent' | 'skipped' | 'failed', reason: string | null): Promise<void> {
  const retryAt = new Date(Date.now() + retryDelayMs(row.attempts)).toISOString();
  await db.execute(sql`UPDATE kortix.workspace_split_emails
    SET state = ${state}, lease_until = NULL, updated_at = now(), last_error = ${reason},
        sent_at = CASE WHEN ${state} = 'sent' THEN now() ELSE sent_at END,
        next_attempt_at = CASE WHEN ${state} = 'failed' THEN ${retryAt}::timestamptz ELSE next_attempt_at END
    WHERE email_id = ${row.email_id} AND attempts = ${row.attempts} AND state = 'sending'`);
}

export interface SplitEmailTotals { sent: number; failed: number; skipped: number }

/**
 * Deliver the due outbox rows (all accounts, or one). `mode` is the split
 * mode: anything but `apply` sends nothing. Returns how the attempts ended.
 */
export async function deliverSplitOwnerEmails(
  mode: WorkspaceSplitMode,
  options: { send?: SendEmail; fromAccountId?: string; limit?: number } = {},
): Promise<SplitEmailTotals> {
  const totals: SplitEmailTotals = { sent: 0, failed: 0, skipped: 0 };
  if (mode !== 'apply') return totals;
  const send = options.send ?? transportSendEmail;
  const claimed = await claimDue(options.limit ?? 20, options.fromAccountId);
  const splits = new Map<string, Awaited<ReturnType<typeof finishedSplit>>>();
  for (const row of claimed) {
    if (!splits.has(row.from_account_id)) splits.set(row.from_account_id, await finishedSplit(row.from_account_id));
    const split = splits.get(row.from_account_id);
    const owner = split?.owners.find((o) => o.user_id === row.user_id);
    if (!split || !owner) {
      // The split was reversed, or the person is no longer an owner.
      await settle(row, 'skipped', split ? 'not_an_owner' : 'split_not_finished');
      totals.skipped += 1;
      continue;
    }
    if (!owner.email) {
      await settle(row, 'skipped', 'no_email');
      totals.skipped += 1;
      continue;
    }
    const message = renderSplitOwnerEmail({
      email: owner.email,
      sourceName: split.sourceName,
      keeperWorkspaceId: split.keeperId,
      workspaces: split.workspaces.map((w) => ({ name: w.name, role: w.role, billing: w.billing, compedUntil: w.comped_until })),
    });
    let result: EmailSendResult;
    try {
      result = await send({ to: [owner.email], ...message, category: 'workspace-split', idempotencyKey: row.idempotency_key });
    } catch (error) {
      result = { ok: false, provider: 'smtp', error: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      await settle(row, 'sent', null);
      totals.sent += 1;
    } else if ('skipped' in result && result.skipped) {
      await settle(row, 'skipped', result.reason);
      totals.skipped += 1;
    } else {
      // The provider's text can carry the address: keep the status only.
      await settle(row, 'failed', `send_failed${'status' in result && result.status ? `:${result.status}` : ''}`);
      totals.failed += 1;
    }
  }
  if (totals.sent + totals.failed + totals.skipped) {
    // Counts only: no address, no name (CLAUDE.md, customer data).
    logger.info('[workspace-split] owner emails', { ...(options.fromAccountId ? { from_account_id: options.fromAccountId } : {}), ...totals });
  }
  return totals;
}

/** Enqueue the owner emails of `fromAccountId`'s finished split and deliver them now (apply mode only). */
export async function sendSplitOwnerEmails(fromAccountId: string, mode: WorkspaceSplitMode, send?: SendEmail): Promise<SplitEmailTotals> {
  await enqueueSplitOwnerEmails(fromAccountId);
  return deliverSplitOwnerEmails(mode, { send, fromAccountId });
}

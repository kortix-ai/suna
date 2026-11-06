/**
 * The split's owner email (design.md §3.2 C9): one email per (owner, source
 * account) when the account's last move is `done`, in `apply` mode only.
 * Owners only, never a member, never a bulk send. The idempotency key
 * `workspace-split-email:<from_account_id>:<user_id>` is recorded in the
 * `plan` of the account's first done run (`plan.owner_emails`), claimed under
 * an advisory lock before the send, so two processes never send twice.
 *
 * Delivery is the one transactional path (`lib/email/transport.ts`). A send
 * that fails is retried by the split tick up to OWNER_EMAIL_MAX_ATTEMPTS; a
 * deployment with no email provider records `skipped` and never retries.
 */
import { sql } from 'drizzle-orm';
import { workspaceSettingsPath } from '@kortix/shared/workspace-settings';
import { config } from '../../config';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { escapeHtml } from '../../shared/html';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { sendEmail as transportSendEmail } from '../../lib/email/transport';
import type { EmailMessage, EmailSendResult } from '../../lib/email/types';

export const OWNER_EMAIL_MAX_ATTEMPTS = 3;
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

type EmailState = { status: 'sending' | 'sent' | 'failed' | 'skipped'; attempts: number; at: string; reason?: string };

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
 * Claim one owner's email under the account's advisory lock: true when this
 * caller may send it now (never claimed, or a failed attempt under the cap).
 */
async function claim(anchorRunId: string, fromAccountId: string, key: string): Promise<EmailState | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`workspace-split-email:${fromAccountId}`}))`);
    const [row] = await tx.execute<{ state: EmailState | null }>(sql`
      SELECT (SELECT r.plan->'owner_emails'->${key} FROM kortix.workspace_split_runs r
               WHERE r.from_account_id = ${fromAccountId} AND r.plan->'owner_emails' ? ${key}
               ORDER BY r.run_id LIMIT 1) AS state`);
    const prior = row?.state ?? null;
    if (prior && (prior.status !== 'failed' || prior.attempts >= OWNER_EMAIL_MAX_ATTEMPTS)) return null;
    const next: EmailState = { status: 'sending', attempts: (prior?.attempts ?? 0) + 1, at: new Date().toISOString() };
    await record(tx, anchorRunId, key, next);
    return next;
  });
}

async function record(executor: Pick<typeof db, 'execute'>, runId: string, key: string, state: EmailState): Promise<void> {
  await executor.execute(sql`UPDATE kortix.workspace_split_runs
    SET plan = jsonb_set(plan, '{owner_emails}', COALESCE(plan->'owner_emails', '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(state)}::jsonb)),
        updated_at = now()
    WHERE run_id = ${runId}`);
}

/**
 * Email each owner of `fromAccountId` once about its finished split. The
 * caller checked that the account's last move is done and the mode is
 * `apply`. Returns how many sends ran and how they ended.
 */
export async function sendSplitOwnerEmails(fromAccountId: string, send: SendEmail = transportSendEmail): Promise<{ sent: number; failed: number; skipped: number }> {
  const totals = { sent: 0, failed: 0, skipped: 0 };
  const split = await finishedSplit(fromAccountId);
  if (!split || split.workspaces.length < 2) return totals;
  for (const owner of split.owners) {
    const key = splitEmailKey(fromAccountId, owner.user_id);
    const claimed = await claim(split.anchorRunId, fromAccountId, key);
    if (!claimed) continue;
    if (!owner.email) {
      await record(db, split.anchorRunId, key, { ...claimed, status: 'skipped', reason: 'no_email' });
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
      result = await send({ to: [owner.email], ...message, category: 'workspace-split' });
    } catch (error) {
      result = { ok: false, provider: 'smtp', error: error instanceof Error ? error.message : String(error) };
    }
    const status: EmailState['status'] = result.ok ? 'sent' : 'skipped' in result && result.skipped ? 'skipped' : 'failed';
    await record(db, split.anchorRunId, key, {
      ...claimed, status, at: new Date().toISOString(),
      ...(result.ok ? {} : { reason: 'reason' in result ? result.reason : 'send_failed' }),
    });
    totals[status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed'] += 1;
  }
  if (totals.sent + totals.failed + totals.skipped) {
    // Counts only: no address, no name (CLAUDE.md, customer data).
    logger.info('[workspace-split] owner emails', { from_account_id: fromAccountId, ...totals });
  }
  return totals;
}

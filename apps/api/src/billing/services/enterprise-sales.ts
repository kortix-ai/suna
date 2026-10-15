/**
 * Tell Kortix sales about an account that wants Enterprise
 * (.agents/skills/billing/references/plans-and-access.md, "Enterprise").
 *
 * Two moments send it: an owner or admin turns the Enterprise demo on, and a
 * signed-in user presses "Talk to sales". The user is already known, so there
 * is no form: the email carries the account, the user and the Enterprise state.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { renderEmail, renderText, S } from '../../lib/email/template';
import { escapeHtml } from '../../shared/html';
import { accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sendAlertEmail } from './owner-alerts';

export type SalesSignal = 'demo_on' | 'contact';

function salesRecipients(): string[] {
  return (config.DEMO_LEAD_NOTIFY_EMAIL || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

/** Email sales. Returns whether an email went out; never throws. */
export async function notifySales(input: {
  accountId: string;
  signal: SalesSignal;
  userEmail?: string | null;
  enterprise: 'off' | 'demo' | 'licensed';
  note?: string | null;
}): Promise<boolean> {
  const to = salesRecipients();
  if (to.length === 0) return false;
  const [account] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, input.accountId))
    .limit(1)
    .catch(() => []);
  const accountName = account?.name?.trim() || input.accountId;
  const what = input.signal === 'demo_on' ? 'turned the Enterprise demo on' : 'asked to talk to sales';
  const title = `${accountName} ${what}`;
  const lines = [
    `Account: ${accountName} (${input.accountId})`,
    `User: ${input.userEmail || 'unknown'}`,
    `Enterprise: ${input.enterprise}`,
    ...(input.note ? [`Note: ${input.note.slice(0, 2000)}`] : []),
  ];
  try {
    await sendAlertEmail({
      to,
      subject: `[Kortix sales] ${title}`,
      category: `enterprise-${input.signal}`,
      html: renderEmail({
        kicker: 'Sales',
        title,
        body: lines.map((line) => `<p style="${S.p}">${escapeHtml(line)}</p>`).join(''),
      }),
      text: renderText({ title, paragraphs: lines }),
    });
    return true;
  } catch (err) {
    logger.warn('[enterprise-sales] email failed', { accountId: input.accountId, error: (err as Error).message });
    return false;
  }
}

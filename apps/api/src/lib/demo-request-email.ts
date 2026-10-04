// Internal notification for public "book a demo" / demo-request submissions.
// Fires on the first-step form details, before (and regardless of) whether the
// lead goes on to book a Cal slot. Delivery goes through the shared
// provider-chain transport (./email/transport.ts); with no provider configured
// the send is skipped gracefully so lead capture never fails on account of
// email.
import { emailDomain, isWorkEmail } from '../accounts/personal-email';
import { config } from './config';
import { escapeHtml } from './html';
import { EMAIL_COLORS } from './email/brand-tokens.generated';
import { BRAND_FOOTER, renderEmail } from './email/template';
import { isEmailConfigured, sendEmail } from './email/transport';

export interface DemoRequestLead {
  name?: string;
  email: string;
  company_name?: string;
  company_size?: string;
  goal?: string;
  qualified?: boolean;
  source?: string;
  user_agent?: string | null;
}

export type DemoRequestNotifyResult =
  | { ok: true; status: number }
  | { ok: false; skipped: true; reason: 'email_not_configured' }
  | { ok: false; skipped?: false; status?: number; error: string };

function row(label: string, value: string | undefined | null): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  return `
    <tr>
      <td style="padding:6px 0;color:${EMAIL_COLORS.inkMuted};font-size:13px;font-weight:400;width:130px;vertical-align:top;text-align:left;">${escapeHtml(
        label,
      )}</td>
      <td style="padding:6px 0;color:${EMAIL_COLORS.ink};font-size:13px;font-weight:500;text-align:left;">${escapeHtml(v)}</td>
    </tr>`;
}

function renderHtml(lead: DemoRequestLead): string {
  const qualified = lead.qualified ? 'Yes — routed to Cal booking' : 'No — request received';
  const domain = emailDomain(lead.email);
  const domainKind = domain
    ? `${domain} (${isWorkEmail(lead.email) ? 'business' : 'personal'})`
    : null;
  const body = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
      ${row('Name', lead.name)}
      ${row('Email', lead.email)}
      ${row('Domain', domainKind)}
      ${row('Company', lead.company_name)}
      ${row('Company size', lead.company_size)}
      ${row('Goal', lead.goal)}
      ${row('Qualified', qualified)}
      ${row('Source', lead.source)}
    </table>`;
  return renderEmail({
    kicker: 'New demo request',
    title: lead.company_name?.trim() || lead.name?.trim() || lead.email,
    body,
  });
}

/** Plain-text alternative, built from the same fields as the HTML table. */
function renderPlainText(lead: DemoRequestLead): string {
  const fields: Array<[string, unknown]> = [
    ['Name', lead.name],
    ['Email', lead.email],
    ['Company', lead.company_name],
    ['Company size', lead.company_size],
    ['Goal', lead.goal],
    ['Qualified', lead.qualified],
    ['Source', lead.source],
  ];
  const lines = ['New demo request', ''];
  for (const [label, value] of fields) {
    const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? '').trim();
    if (text) lines.push(`${label}: ${text}`);
  }
  lines.push('', BRAND_FOOTER);
  return lines.join('\n');
}

/**
 * Send the internal "new demo request" notification. Never throws — returns a
 * result the caller can log. Recipients come from config.DEMO_LEAD_NOTIFY_EMAIL,
 * a comma-separated list (default marko@kortix.ai,hey@kortix.ai) — every
 * address gets every submission.
 */
export async function sendDemoRequestNotification(
  lead: DemoRequestLead,
): Promise<DemoRequestNotifyResult> {
  if (!isEmailConfigured()) {
    return { ok: false, skipped: true, reason: 'email_not_configured' };
  }

  const recipients = (config.DEMO_LEAD_NOTIFY_EMAIL || 'marko@kortix.ai,hey@kortix.ai')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  const who = lead.company_name?.trim() || lead.name?.trim() || lead.email;

  const result = await sendEmail({
    to: recipients,
    subject: `New demo request — ${who}`,
    html: renderHtml(lead),
    text: renderPlainText(lead),
    category: 'demo-request',
    from: {
      email: config.DEMO_LEAD_FROM_EMAIL || config.MAILTRAP_FROM_EMAIL,
      name: config.MAILTRAP_FROM_NAME,
    },
  });
  if (result.ok) return { ok: true, status: result.status };
  if ('skipped' in result && result.skipped) {
    return { ok: false, skipped: true, reason: 'email_not_configured' };
  }
  return {
    ok: false,
    status: 'status' in result ? result.status : undefined,
    error: 'error' in result ? result.error : 'send failed',
  };
}

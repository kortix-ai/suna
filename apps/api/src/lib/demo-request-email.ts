// Internal notification for public "book a demo" / demo-request submissions.
// Fires on the first-step form details, before (and regardless of) whether the
// lead goes on to book a Cal slot. Delivery goes through the shared
// provider-chain transport (./email/transport.ts); with no provider configured
// the send is skipped gracefully so lead capture never fails on account of
// email.
import { emailDomain, isWorkEmail } from '../accounts/personal-email';
import { config } from '../config';
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label: string, value: string | undefined | null): string {
  const v = (value ?? '').toString().trim();
  if (!v) return '';
  return `
    <tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;width:130px;vertical-align:top;">${escapeHtml(
        label,
      )}</td>
      <td style="padding:6px 0;color:#111111;font-size:13px;font-weight:500;">${escapeHtml(v)}</td>
    </tr>`;
}

function renderHtml(lead: DemoRequestLead): string {
  const qualified = lead.qualified ? 'Yes — routed to Cal booking' : 'No — request received';
  const domain = emailDomain(lead.email);
  const domainKind = domain
    ? `${domain} (${isWorkEmail(lead.email) ? 'business' : 'personal'})`
    : null;
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f6f7f9;">
      <tr><td align="center">
        <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
          <div style="padding:24px 28px 0;">
            <p style="font-size:11px;color:#6b7280;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 6px;">New demo request</p>
            <h1 style="font-size:20px;line-height:1.3;font-weight:600;color:#111111;margin:0;">${escapeHtml(
              lead.company_name?.trim() || lead.name?.trim() || lead.email,
            )}</h1>
          </div>
          <div style="padding:16px 28px 28px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
              ${row('Name', lead.name)}
              ${row('Email', lead.email)}
              ${row('Domain', domainKind)}
              ${row('Company', lead.company_name)}
              ${row('Company size', lead.company_size)}
              ${row('Goal', lead.goal)}
              ${row('Qualified', qualified)}
              ${row('Source', lead.source)}
            </table>
          </div>
          <div style="padding:16px 28px;text-align:center;border-top:1px solid #e5e7eb;background:#ffffff;">
            <p style="font-size:12px;color:#9ca3af;margin:0;">dosco — automated lead notification</p>
          </div>
        </div>
      </td></tr>
    </table>
  </body>
</html>`.trim();
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

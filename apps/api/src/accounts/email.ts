// Account-scoped invite email. Self-contained Mailtrap transport — formerly
// lived under teams/services/notifications.ts (which was sandbox-scoped).
import { config } from '../config';

const MAILTRAP_SEND_URL = 'https://send.api.mailtrap.io/api/send';

const BRAND_WORDMARK = 'Kortix';
const BRAND_FOOTER = 'Kortix — The Autonomous Company Operating System';

export type EmailDeliveryResult =
  | { ok: true; provider: 'mailtrap'; status: number }
  | { ok: false; skipped: true; reason: 'missing_mailtrap_token' }
  | { ok: false; skipped?: false; provider: 'mailtrap'; status?: number; error: string };

const COLOR_BG = '#f6f7f9';
const COLOR_CARD = '#ffffff';
const COLOR_BORDER = '#e5e7eb';
const COLOR_TEXT = '#111111';
const COLOR_MUTED = '#6b7280';
const COLOR_ACCENT = '#111111';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const S = {
  wrapper: `margin:0;padding:0;background:${COLOR_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`,
  outerTable: `width:100%;background:${COLOR_BG};`,
  container: `max-width:520px;margin:40px auto;background:${COLOR_CARD};border-radius:14px;border:1px solid ${COLOR_BORDER};overflow:hidden;`,
  header: `padding:28px 32px 0;text-align:center;`,
  wordmark: `font-size:15px;font-weight:700;letter-spacing:0.5px;color:${COLOR_TEXT};margin:0;`,
  body: `padding:18px 32px 36px;text-align:center;`,
  kicker: `font-size:11px;color:${COLOR_MUTED};letter-spacing:0.2em;text-transform:uppercase;margin:24px 0 8px;`,
  h1: `font-size:22px;line-height:1.25;font-weight:600;color:${COLOR_TEXT};margin:0 0 12px;`,
  p: `font-size:14px;line-height:1.6;color:${COLOR_MUTED};margin:0 0 24px;`,
  strong: `color:${COLOR_TEXT};font-weight:600;`,
  chipWrap: `margin:0 0 28px;`,
  chip: `display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid ${COLOR_BORDER};font-size:11px;color:${COLOR_MUTED};letter-spacing:0.06em;text-transform:uppercase;`,
  btn: `display:inline-block;padding:12px 28px;background:${COLOR_ACCENT};color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:500;`,
  footer: `padding:18px 32px;text-align:center;border-top:1px solid ${COLOR_BORDER};background:${COLOR_CARD};`,
  footerP: `font-size:12px;color:#9ca3af;margin:0;`,
  smallNote: `font-size:12px;color:${COLOR_MUTED};margin:24px 0 0;`,
};

function renderEmail(opts: { kicker?: string; title: string; body: string }): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
  </head>
  <body style="${S.wrapper}">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="${S.outerTable}">
      <tr>
        <td align="center">
          <div style="${S.container}">
            <div style="${S.header}">
              <p style="${S.wordmark}">${BRAND_WORDMARK}</p>
            </div>
            <div style="${S.body}">
              ${opts.kicker ? `<div style="${S.kicker}">${escapeHtml(opts.kicker)}</div>` : ''}
              <h1 style="${S.h1}">${escapeHtml(opts.title)}</h1>
              ${opts.body}
            </div>
            <div style="${S.footer}">
              <p style="${S.footerP}">${BRAND_FOOTER}</p>
            </div>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();
}

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  category: string;
}): Promise<EmailDeliveryResult> {
  if (!config.MAILTRAP_API_TOKEN) {
    return { ok: false, skipped: true, reason: 'missing_mailtrap_token' };
  }

  try {
    const res = await fetch(MAILTRAP_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.MAILTRAP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: config.MAILTRAP_FROM_EMAIL, name: config.MAILTRAP_FROM_NAME },
        to: [{ email: opts.to }],
        subject: opts.subject,
        html: opts.html,
        category: opts.category,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[accounts/email] Mailtrap ${res.status}: ${body}`);
      return {
        ok: false,
        provider: 'mailtrap',
        status: res.status,
        error: body || res.statusText || 'Mailtrap request failed',
      };
    }

    return { ok: true, provider: 'mailtrap', status: res.status };
  } catch (err) {
    const message = (err as Error).message;
    console.warn('[accounts/email] send failed:', message);
    return { ok: false, provider: 'mailtrap', error: message };
  }
}

// Public, share-anywhere invite URL. The same link is embedded in the invite
// email and returned by every invite API route, so a copied link behaves
// exactly like one received via email. Single source of truth for both the
// account- and project-level invite flows.
export function buildInviteUrl(inviteId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/invites/${inviteId}`;
}

// Sends the invite email for both account-level invites (join the team) and
// project-level invites (collaborate on a specific project). The two flows
// share one transport + template; pass `projectName` to frame the copy around
// a project instead of the whole account. Both create an `account_invitations`
// row redeemed at the same /invites/:id link.
export async function sendAccountInviteEmail(opts: {
  email: string;
  accountName: string;
  inviterEmail: string | null;
  inviteId: string;
  // Display label for the role chip (account: admin|member, project:
  // manager|editor|viewer). Rendered verbatim (uppercased).
  role?: string;
  // When set, the invite is framed as joining this project rather than the
  // whole account/team (project-level /access/invite flow).
  projectName?: string | null;
}): Promise<EmailDeliveryResult> {
  const url = buildInviteUrl(opts.inviteId);

  const inviterLine = opts.inviterEmail
    ? `<span style="${S.strong}">${escapeHtml(opts.inviterEmail)}</span> invited you`
    : `You've been invited`;

  const roleChip = opts.role
    ? `<div style="${S.chipWrap}"><span style="${S.chip}">${escapeHtml(
        opts.role.toUpperCase(),
      )}</span></div>`
    : '';

  const target = opts.projectName
    ? `the <span style="${S.strong}">${escapeHtml(opts.projectName)}</span> project`
    : `the <span style="${S.strong}">${escapeHtml(opts.accountName)}</span> team`;

  const signupTail = opts.projectName
    ? 'the project will appear in your account automatically.'
    : 'the team will appear in your accounts list automatically.';

  const body = `
    <p style="${S.p}">
      ${inviterLine} to join ${target} on Kortix.
    </p>
    ${roleChip}
    <a href="${escapeHtml(url)}" style="${S.btn}">Review invite</a>
    <p style="${S.smallNote}">
      Don't have a Kortix account yet? You'll be prompted to sign up first —
      ${signupTail}
    </p>
  `;

  const subjectTarget = opts.projectName
    ? `collaborate on "${opts.projectName}"`
    : `join "${opts.accountName}"`;

  const html = renderEmail({
    kicker: "You're invited",
    title: opts.projectName
      ? `Join ${opts.projectName} on Kortix`
      : `Join ${opts.accountName} on Kortix`,
    body,
  });

  return send({
    to: opts.email,
    subject: `You're invited to ${subjectTarget} on Kortix`,
    html,
    category: 'account-invite',
  });
}

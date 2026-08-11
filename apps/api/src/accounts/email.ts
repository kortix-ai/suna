// Account-scoped invite email. Rendering lives here; delivery goes through the
// shared provider-chain transport (lib/email/transport.ts).
import { config } from '../config';
import { isEmailConfigured, sendEmail, type EmailSendResult } from '../lib/email/transport';

const BRAND_WORDMARK = 'Kortix';
const BRAND_FOOTER = 'Kortix — The Autonomous Company Operating System';

export type EmailDeliveryResult = EmailSendResult;

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

function send(opts: {
  to: string;
  subject: string;
  html: string;
  category: string;
}): Promise<EmailDeliveryResult> {
  return sendEmail({ to: [opts.to], subject: opts.subject, html: opts.html, category: opts.category });
}

// Whether invite-email delivery is wired up. Lets callers that fire the email
// without awaiting it (fire-and-forget) still report an accurate email_sent /
// skip_reason synchronously: with no provider configured, sendEmail() would
// skip with email_not_configured regardless.
export function isInviteEmailConfigured(): boolean {
  return isEmailConfigured();
}

// Public, share-anywhere invite URL. The same link is embedded in the invite
// email and returned by every invite API route, so a copied link behaves
// exactly like one received via email. Single source of truth for both the
// account- and Workspace-level invite flows.
export function buildInviteUrl(inviteId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/invites/${inviteId}`;
}

// Sends the invite email for both account-level invites (join the team) and
// Workspace-level invites (collaborate in a specific Workspace). The two flows
// share one transport + template; pass `workspaceName` to frame the copy around
// a Workspace instead of the whole account. Both create an `account_invitations`
// row redeemed at the same /invites/:id link.
export async function sendAccountInviteEmail(opts: {
  email: string;
  accountName: string;
  inviterEmail: string | null;
  inviteId: string;
  // Display label for the role chip (account: admin|member, Workspace:
  // manager|editor|user). Rendered verbatim (uppercased).
  role?: string;
  // When set, the invite is framed as joining this Workspace rather than the
  // whole account/team (Workspace-level /access/invite flow).
  workspaceName?: string | null;
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

  const target = opts.workspaceName
    ? `the <span style="${S.strong}">${escapeHtml(opts.workspaceName)}</span> Workspace`
    : `the <span style="${S.strong}">${escapeHtml(opts.accountName)}</span> team`;

  const signupTail = opts.workspaceName
    ? 'the Workspace will appear in your account automatically.'
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

  const subjectTarget = opts.workspaceName
    ? `collaborate in "${opts.workspaceName}"`
    : `join "${opts.accountName}"`;

  const html = renderEmail({
    kicker: "You're invited",
    title: opts.workspaceName
      ? `Join ${opts.workspaceName} on Kortix`
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

export async function sendWorkspaceAccessRequestEmail(opts: {
  email: string;
  workspaceName: string | null;
  requesterEmail: string;
  reviewUrl: string;
  message?: string | null;
}): Promise<EmailDeliveryResult> {
  const workspaceName = opts.workspaceName?.trim() || 'a Kortix Workspace';
  const message = opts.message?.trim();
  const messageBlock = message
    ? `<p style="${S.p}"><span style="${S.strong}">Message:</span><br />${escapeHtml(message)}</p>`
    : '';

  const body = `
    <p style="${S.p}">
      <span style="${S.strong}">${escapeHtml(opts.requesterEmail)}</span>
      requested access to <span style="${S.strong}">${escapeHtml(workspaceName)}</span>.
    </p>
    ${messageBlock}
    <a href="${escapeHtml(opts.reviewUrl)}" style="${S.btn}">Review request</a>
    <p style="${S.smallNote}">
      Workspace managers can approve or decline this from Customize → Members.
    </p>
  `;

  const html = renderEmail({
    kicker: 'Access request',
    title: 'Review Workspace access',
    body,
  });

  return send({
    to: opts.email,
    subject: `${opts.requesterEmail} requested access to ${workspaceName}`,
    html,
    category: 'project-access-request',
  });
}

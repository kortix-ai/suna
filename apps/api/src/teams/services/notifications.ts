import { config } from '../../config';

const MAILTRAP_SEND_URL = 'https://send.api.mailtrap.io/api/send';

// ─── Primitives (all inline) ────────────────────────────────────────────────

const BRAND_WORDMARK = 'Kortix';
const BRAND_FOOTER = 'Kortix — The Autonomous Company Operating System';

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

function renderEmail(opts: {
  kicker?: string;
  title: string;
  body: string;
}): string {
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

// ─── Transport ──────────────────────────────────────────────────────────────

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  category: string;
}): Promise<void> {
  if (!config.MAILTRAP_API_TOKEN) return;
  try {
    const res = await fetch(MAILTRAP_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.MAILTRAP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: {
          email: config.MAILTRAP_FROM_EMAIL,
          name: config.MAILTRAP_FROM_NAME,
        },
        to: [{ email: opts.to }],
        subject: opts.subject,
        html: opts.html,
        category: opts.category,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[teams/notifications] Mailtrap ${res.status}: ${body}`);
    }
  } catch (err) {
    console.warn('[teams/notifications] send failed:', (err as Error).message);
  }
}

function frontendBase(): string {
  return config.FRONTEND_URL || 'https://app.kortix.com';
}

// ─── Public: invite email ───────────────────────────────────────────────────

export async function sendInviteEmail(opts: {
  email: string;
  sandboxName: string;
  inviterEmail: string | null;
  inviteId: string | null;
  /** Optional: show the preselected role on the invite so the recipient
   * knows what they'll get before accepting. */
  role?: 'admin' | 'member';
}): Promise<void> {
  const url = opts.inviteId
    ? `${frontendBase()}/invites/${opts.inviteId}`
    : `${frontendBase()}/auth?email=${encodeURIComponent(opts.email)}`;

  const inviterLine = opts.inviterEmail
    ? `<span style="${S.strong}">${escapeHtml(opts.inviterEmail)}</span> invited you`
    : `You've been invited`;

  const roleChip = opts.role
    ? `<div style="${S.chipWrap}"><span style="${S.chip}">${escapeHtml(
        opts.role.toUpperCase(),
      )}</span></div>`
    : '';

  const body = `
    <p style="${S.p}">
      ${inviterLine} to collaborate on
      <span style="${S.strong}">${escapeHtml(opts.sandboxName)}</span>.
    </p>
    ${roleChip}
    <a href="${escapeHtml(url)}" style="${S.btn}">Review invite</a>
    <p style="${S.smallNote}">
      Don't have a Kortix account yet? You'll be prompted to sign up first —
      the workspace will appear on your instances page automatically.
    </p>
  `;

  const html = renderEmail({
    kicker: "You're invited",
    title: `Join ${opts.sandboxName} on Kortix`,
    body,
  });

  await send({
    to: opts.email,
    subject: `You're invited to "${opts.sandboxName}" on Kortix`,
    html,
    category: 'sandbox-invite',
  });
}

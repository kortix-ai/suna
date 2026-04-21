import { config } from '../../config';

const MAILTRAP_SEND_URL = 'https://send.api.mailtrap.io/api/send';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCard(body: string): string {
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { margin: 0; padding: 0; background: #f8f9fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .container { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; }
  .header { padding: 32px 32px 24px; text-align: center; }
  .logo { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; color: #111; }
  .body { padding: 0 32px 32px; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; color: #111; margin: 0 0 8px; }
  p { font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 24px; }
  .name { font-weight: 600; color: #111; }
  .btn { display: inline-block; padding: 10px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500; }
  .footer { padding: 16px 32px; text-align: center; border-top: 1px solid #f3f4f6; }
  .footer p { font-size: 12px; color: #9ca3af; margin: 0; }
</style></head>
<body>
  <div class="container">
    <div class="header"><div class="logo">Kortix</div></div>
    <div class="body">${body}</div>
    <div class="footer"><p>Kortix &mdash; The Autonomous Company Operating System</p></div>
  </div>
</body></html>`.trim();
}

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

export async function sendInviteEmail(opts: {
  email: string;
  sandboxName: string;
  inviterEmail: string | null;
  inviteId: string | null;
}): Promise<void> {
  const url = opts.inviteId
    ? `${frontendBase()}/invites/${opts.inviteId}`
    : `${frontendBase()}/auth?email=${encodeURIComponent(opts.email)}`;
  const inviter = opts.inviterEmail
    ? `<span class="name">${escapeHtml(opts.inviterEmail)}</span> invited you`
    : `You've been invited`;

  const body = `
    <h1>You've been invited to Kortix</h1>
    <p>${inviter} to collaborate on <span class="name">${escapeHtml(opts.sandboxName)}</span>. Review the invite to accept or decline — if you don't have a Kortix account yet, you'll be prompted to sign up.</p>
    <a href="${escapeHtml(url)}" class="btn">Review invite</a>
  `;

  await send({
    to: opts.email,
    subject: `You're invited to "${opts.sandboxName}" on Kortix`,
    html: renderCard(body),
    category: 'sandbox-invite',
  });
}

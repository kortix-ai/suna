// Account- and project-scoped invite / access-request email. Rendering uses the
// shared Kortix email shell (lib/email/template.ts); delivery goes through the
// one platform transport (lib/email/transport.ts).
import { config } from '../lib/config';
import { renderEmail, renderText, actionButton, S } from '../lib/email/template';
import { escapeHtml } from '../shared/html';
import { isEmailConfigured, sendEmail, type EmailSendResult } from '../lib/email/transport';

export type EmailDeliveryResult = EmailSendResult;

function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: string;
}): Promise<EmailDeliveryResult> {
  return sendEmail({
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    category: opts.category,
  });
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
  // manager|member). Rendered verbatim (uppercased).
  role?: string;
  // When set, the invite is framed as joining this project rather than the
  // whole account/team (project-level /access/invite flow).
  projectName?: string | null;
}): Promise<EmailDeliveryResult> {
  const url = buildInviteUrl(opts.inviteId);
  // Brand voice 5.5: name the inviter. A request without a user email (a
  // service token) names the account that sent it instead.
  const inviter = opts.inviterEmail || opts.accountName;
  const inviterLine = `<span style="${S.strong}">${escapeHtml(inviter)}</span> invited you`;
  // Sentence case, never uppercase (brand voice 5.5).
  const role = opts.role ? opts.role.charAt(0).toUpperCase() + opts.role.slice(1).toLowerCase() : null;

  const roleChip = role
    ? `<div style="${S.chipWrap}"><span style="${S.chip}">${escapeHtml(role)}</span></div>`
    : '';

  const target = opts.projectName
    ? `the <span style="${S.strong}">${escapeHtml(opts.projectName)}</span> project`
    : `the <span style="${S.strong}">${escapeHtml(opts.accountName)}</span> team`;

  const signupTail = opts.projectName
    ? 'the project will appear in your account automatically.'
    : 'the team will appear in your accounts list automatically.';
  // Accepting requires the invited address (email_matches_caller), so say which
  // one. Brand voice 5.5: one closing note, ending with the ignore line.
  const note = `This invitation is for ${opts.email}. Sign in with that address, or sign up with it if you don't have a Kortix account yet — ${signupTail} If you were not expecting this invitation, you can ignore this email.`;

  const body = `
    <p style="${S.p}">
      ${inviterLine} to join ${target} on Kortix.
    </p>
    ${roleChip}
    ${actionButton(url, 'Review invite')}
    <p style="${S.smallNote}">${escapeHtml(note)}</p>
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

  const targetText = opts.projectName
    ? `the ${opts.projectName} project`
    : `the ${opts.accountName} team`;

  return send({
    to: opts.email,
    subject: `You're invited to ${subjectTarget} on Kortix`,
    html,
    text: renderText({
      title: opts.projectName
        ? `Join ${opts.projectName} on Kortix`
        : `Join ${opts.accountName} on Kortix`,
      paragraphs: [
        `${inviter} invited you to join ${targetText} on Kortix.`,
        ...(role ? [`Role: ${role}`] : []),
      ],
      cta: { url, label: 'Review invite' },
      note,
    }),
    category: 'account-invite',
  });
}

export async function sendProjectAccessRequestEmail(opts: {
  email: string;
  projectName: string | null;
  requesterEmail: string;
  reviewUrl: string;
  message?: string | null;
}): Promise<EmailDeliveryResult> {
  const projectName = opts.projectName?.trim() || 'a Kortix project';
  const message = opts.message?.trim();
  const messageBlock = message
    ? `<p style="${S.p}"><span style="${S.strong}">Message:</span><br />${escapeHtml(message)}</p>`
    : '';

  const body = `
    <p style="${S.p}">
      <span style="${S.strong}">${escapeHtml(opts.requesterEmail)}</span>
      requested access to <span style="${S.strong}">${escapeHtml(projectName)}</span>.
    </p>
    ${messageBlock}
    ${actionButton(opts.reviewUrl, 'Review request')}
    <p style="${S.smallNote}">
      Project managers can approve or decline this from Customize → Members.
    </p>
  `;

  const html = renderEmail({
    kicker: 'Access request',
    title: 'Review project access',
    body,
  });

  return send({
    to: opts.email,
    subject: `${opts.requesterEmail} requested access to ${projectName}`,
    html,
    text: renderText({
      title: 'Review project access',
      paragraphs: [
        `${opts.requesterEmail} requested access to ${projectName}.`,
        ...(message ? [`Message: ${message}`] : []),
      ],
      cta: { url: opts.reviewUrl, label: 'Review request' },
      note: 'Project managers can approve or decline this from Customize → Members.',
    }),
    category: 'project-access-request',
  });
}

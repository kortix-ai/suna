// Account- and project-scoped invite / access-request email. Rendering uses the
// shared Kortix email shell (lib/email/template.tsx); delivery goes through the
// one platform transport (lib/email/transport.ts).
import { config } from '../config';
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

// Sends the invite email for both invite routes: the workspace members screen
// and the older project access screen. Both name the workspace; `projectName`
// is its name when the account's own name differs. Both create an `account_invitations`
// row redeemed at the same /invites/:id link.
type InviteEmailInput = {
  email: string;
  accountName: string;
  inviterEmail: string | null;
  inviteId: string;
  // The ladder role the invite grants (member | manager | admin), shown as
  // the role chip in sentence case.
  role?: string;
  // The workspace's name when it is not the account's (the older
  // /access/invite flow passes the project's name).
  projectName?: string | null;
};

export async function sendAccountInviteEmail(opts: InviteEmailInput): Promise<EmailDeliveryResult> {
  return send({ to: opts.email, ...renderAccountInviteEmail(opts), category: 'account-invite' });
}

/** The invite email without sending it. */
export function renderAccountInviteEmail(opts: InviteEmailInput): { subject: string; html: string; text: string } {
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

  // One container: the workspace. `projectName` is the workspace's name when
  // the invite came from its access screen; otherwise the account's name is.
  const workspaceName = opts.projectName || opts.accountName;
  const target = `the <span style="${S.strong}">${escapeHtml(workspaceName)}</span> workspace`;

  // Accepting requires the invited address (email_matches_caller), so say which
  // one. Brand voice 5.5: one closing note, ending with the ignore line.
  const note = `This invitation is for ${opts.email}. Sign in with that address, or sign up with it if you don't have a Kortix account yet — it will appear in your workspaces. If you were not expecting this invitation, you can ignore this email.`;

  const body = `
    <p style="${S.p}">
      ${inviterLine} to join ${target} on Kortix.
    </p>
    ${roleChip}
    ${actionButton(url, 'Review invite')}
    <p style="${S.smallNote}">${escapeHtml(note)}</p>
  `;

  const subjectTarget = `join "${workspaceName}"`;

  const html = renderEmail({
    title: `Join ${workspaceName} on Kortix`,
    body,
  });

  const targetText = `the ${workspaceName} workspace`;

  return {
    subject: `You're invited to ${subjectTarget} on Kortix`,
    html,
    text: renderText({
      title: `Join ${workspaceName} on Kortix`,
      paragraphs: [
        `${inviter} invited you to join ${targetText} on Kortix.`,
        ...(role ? [`Role: ${role}`] : []),
      ],
      cta: { url, label: 'Review invite' },
      note,
    }),
  };
}

type ProjectAddedEmailInput = {
  email: string;
  projectId: string;
  projectName: string;
  inviterEmail: string | null;
  role: string;
};

export async function sendProjectAddedEmail(opts: ProjectAddedEmailInput): Promise<EmailDeliveryResult> {
  return send({ to: opts.email, ...renderProjectAddedEmail(opts), category: 'project-added' });
}

export function renderProjectAddedEmail(opts: ProjectAddedEmailInput): { subject: string; html: string; text: string } {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}/workspaces/${encodeURIComponent(opts.projectId)}`;
  const title = `Open ${opts.projectName} on Kortix`;
  const lead = `${opts.inviterEmail || 'A workspace manager'} added you to the ${opts.projectName} workspace as ${opts.role}.`;
  const note = `This access is for ${opts.email}. Sign in with that address to open the workspace. You already have access; no invitation acceptance is required. If you were not expecting this access, contact a workspace admin.`;
  return {
    subject: `Open "${opts.projectName}" on Kortix`,
    html: renderEmail({
      title,
      body: `<p style="${S.p}">${escapeHtml(lead)}</p>${actionButton(url, 'Open workspace')}<p style="${S.smallNote}">${escapeHtml(note)}</p>`,
    }),
    text: renderText({ title, paragraphs: [lead], cta: { url, label: 'Open workspace' }, note }),
  };
}

type AccessRequestEmailInput = {
  email: string;
  projectName: string | null;
  requesterEmail: string;
  reviewUrl: string;
  message?: string | null;
};

export async function sendProjectAccessRequestEmail(opts: AccessRequestEmailInput): Promise<EmailDeliveryResult> {
  return send({ to: opts.email, ...renderProjectAccessRequestEmail(opts), category: 'project-access-request' });
}

export function renderProjectAccessRequestEmail(opts: AccessRequestEmailInput): { subject: string; html: string; text: string } {
  const projectName = opts.projectName?.trim() || 'a Kortix workspace';
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
      Workspace admins and managers can approve or decline this in Workspace settings → Members.
    </p>
  `;

  const html = renderEmail({
    title: 'Review workspace access',
    body,
  });

  return {
    subject: `${opts.requesterEmail} requested access to ${projectName}`,
    html,
    text: renderText({
      title: 'Review workspace access',
      paragraphs: [
        `${opts.requesterEmail} requested access to ${projectName}.`,
        ...(message ? [`Message: ${message}`] : []),
      ],
      cta: { url: opts.reviewUrl, label: 'Review request' },
      note: 'Workspace admins and managers can approve or decline this in Workspace settings → Members.',
    }),
  };
}

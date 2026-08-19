// Auth email bodies — magic link, signup confirmation, password recovery,
// email change, reauthentication code.
//
// GoTrue can only render its own plain templates and can only send over SMTP.
// Routing it through the send-email hook means these use the same Kortix shell,
// the same sender identity and the same provider chain as invites, so an
// operator who configures Resend or SES (no SMTP anywhere) still gets working
// magic links.
import { actionButton, escapeHtml, renderEmail, renderText, S } from '../../lib/email/template';

export type AuthEmailActionType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email_change_current'
  | 'email_change_new'
  | 'reauthentication';

export interface AuthEmailContent {
  subject: string;
  html: string;
  text: string;
  category: string;
}

interface Copy {
  subject: string;
  kicker: string;
  title: string;
  lead: string;
  cta: string;
  note: string;
}

const COPY: Record<Exclude<AuthEmailActionType, 'reauthentication'>, Copy> = {
  signup: {
    subject: 'Confirm your email',
    kicker: 'Confirm your email',
    title: 'Confirm your email address',
    lead: 'Confirm this address to finish creating your Kortix account.',
    cta: 'Confirm email',
    note: 'If you did not create a Kortix account, you can ignore this email.',
  },
  invite: {
    subject: 'You have been invited to Kortix',
    kicker: "You're invited",
    title: 'You have been invited',
    lead: 'Accept the invitation to create your Kortix account.',
    cta: 'Accept invite',
    note: 'If you were not expecting this invitation, you can ignore this email.',
  },
  magiclink: {
    subject: 'Your Kortix sign-in link',
    kicker: 'Sign in',
    title: 'Sign in to Kortix',
    lead: 'Use the link below to sign in. It expires shortly and can be used once.',
    cta: 'Sign in',
    note: 'If you did not request this link, you can ignore this email.',
  },
  recovery: {
    subject: 'Reset your Kortix password',
    kicker: 'Password reset',
    title: 'Reset your password',
    lead: 'Use the link below to choose a new password.',
    cta: 'Reset password',
    note: 'If you did not request a password reset, you can ignore this email.',
  },
  email_change: {
    subject: 'Confirm your new email address',
    kicker: 'Email change',
    title: 'Confirm your new email address',
    lead: 'Confirm this change to move your Kortix account to the new address.',
    cta: 'Confirm change',
    note: 'If you did not request this change, reset your password immediately.',
  },
  email_change_current: {
    subject: 'Confirm your email change',
    kicker: 'Email change',
    title: 'Confirm your email change',
    lead: 'Confirm from your current address to move your Kortix account.',
    cta: 'Confirm change',
    note: 'If you did not request this change, reset your password immediately.',
  },
  email_change_new: {
    subject: 'Confirm your new email address',
    kicker: 'Email change',
    title: 'Confirm your new email address',
    lead: 'Confirm this address to finish moving your Kortix account to it.',
    cta: 'Confirm change',
    note: 'If you did not request this change, you can ignore this email.',
  },
};

/** Six-digit code flow — no link is issued for reauthentication. */
function renderCode(token: string): AuthEmailContent {
  const body = `
    <p style="${S.p}">Enter this code to confirm it is you.</p>
    <div style="${S.chipWrap}"><span style="${S.code}">${escapeHtml(token)}</span></div>
    <p style="${S.smallNote}">
      The code expires shortly. If you did not request it, you can ignore this email.
    </p>
  `;
  const title = 'Confirm it is you';
  const note = 'The code expires shortly. If you did not request it, you can ignore this email.';
  return {
    subject: 'Your Kortix confirmation code',
    html: renderEmail({ kicker: 'Confirmation code', title, body }),
    text: renderText({
      title,
      paragraphs: ['Enter this code to confirm it is you.'],
      code: token,
      note,
    }),
    category: 'auth-reauthentication',
  };
}

export function renderAuthEmail(input: {
  actionType: AuthEmailActionType;
  actionUrl: string;
  token: string;
}): AuthEmailContent {
  if (input.actionType === 'reauthentication') return renderCode(input.token);

  const copy = COPY[input.actionType];
  const body = `
    <p style="${S.p}">${escapeHtml(copy.lead)}</p>
    ${actionButton(input.actionUrl, copy.cta)}
    <p style="${S.smallNote}">${escapeHtml(copy.note)}</p>
  `;
  return {
    subject: copy.subject,
    html: renderEmail({ kicker: copy.kicker, title: copy.title, body }),
    text: renderText({
      title: copy.title,
      paragraphs: [copy.lead],
      cta: { url: input.actionUrl, label: copy.cta },
      note: copy.note,
    }),
    category: `auth-${input.actionType.replace(/_/g, '-')}`,
  };
}

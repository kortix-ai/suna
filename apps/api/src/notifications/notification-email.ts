// What a notification email says (KRTX-1742): the immediate automation alert
// and the digest of unread rows. One Kortix shell (lib/email/template.ts);
// voice rules: .agents/skills/kortix-brand/references/verbal/voice-and-tone.md 5.5.
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { config } from '../config';
import { actionButton, renderEmail, renderText, S } from '../lib/email/template';
import type { EmailMessage } from '../lib/email/types';
import { escapeHtml } from '../shared/html';

export type RenderedEmail = Pick<EmailMessage, 'subject' | 'html' | 'text'>;

export interface NotificationEmailItem {
  kind: NotificationKindName;
  title: string;
  body: string;
  /** App path of the subject (`/projects/...`); made absolute here. */
  url: string;
}

export const KIND_LABELS: Record<NotificationKindName, string> = {
  turn_done: 'Session finished',
  turn_error: 'Session failed',
  question: 'Question waiting',
  permission: 'Approval needed',
  shared: 'Shared with you',
  automation_failed: 'Automation failing',
  automation_recovered: 'Automation recovered',
};

/** The settings pane that holds the per-kind Push and Email switches. */
const SETTINGS_PATH = '/settings/sessions';
const SETTINGS_LINK_LABEL = 'Settings → Notifications';
const SETTINGS_LEAD = 'Change which notifications get email in';

/** An app path as a link that works from a mail client. */
export function absoluteAppUrl(path: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function message(parts: {
  subject: string;
  kicker: string;
  title: string;
  /** Plain sentences; the first one may name the subject in bold. */
  lead: { text: string; strong?: string };
  detail?: string;
  /** What happens next, or what to do. */
  next?: string;
  extra?: { html: string; text: string[] };
  cta: { url: string; label: string };
  /** Why the reader gets this email; always ends with the settings link. */
  note: string;
}): RenderedEmail {
  const settingsUrl = absoluteAppUrl(SETTINGS_PATH);
  const { lead } = parts;
  const leadHtml = lead.strong
    ? `<span style="${S.strong}">${escapeHtml(lead.strong)}</span> ${escapeHtml(lead.text)}`
    : escapeHtml(lead.text);
  return {
    subject: parts.subject,
    html: renderEmail({
      kicker: parts.kicker,
      title: parts.title,
      body: `
        <p style="${S.p}">${leadHtml}</p>
        ${parts.detail ? `<p style="${S.p}">${escapeHtml(parts.detail)}</p>` : ''}
        ${parts.next ? `<p style="${S.p}">${escapeHtml(parts.next)}</p>` : ''}
        ${parts.extra?.html ?? ''}
        ${actionButton(parts.cta.url, parts.cta.label)}
        <p style="${S.smallNote}">${escapeHtml(parts.note)} ${escapeHtml(SETTINGS_LEAD)} <a href="${escapeHtml(settingsUrl)}" style="${S.strong}text-decoration:underline;">${escapeHtml(SETTINGS_LINK_LABEL)}</a>.</p>
      `,
    }),
    text: renderText({
      title: parts.title,
      paragraphs: [
        lead.strong ? `${lead.strong} ${lead.text}` : lead.text,
        ...(parts.detail ? [parts.detail] : []),
        ...(parts.next ? [parts.next] : []),
        ...(parts.extra?.text ?? []),
      ],
      cta: parts.cta,
      note: `${parts.note} ${SETTINGS_LEAD} ${SETTINGS_LINK_LABEL}: ${settingsUrl}`,
    }),
  };
}

/**
 * One automation alert, sent as it happens. Null for any other kind: those
 * are emailed only in the digest.
 */
export function renderImmediateNotificationEmail(item: NotificationEmailItem): RenderedEmail | null {
  const cta = { url: absoluteAppUrl(item.url), label: 'Open automations' };
  // True for the creator, the last editor, a reminder's owner and a project
  // manager who gets the alert because nobody else can read the trigger.
  const note = 'You get this email because you created or edited this automation, or you manage its project.';
  if (item.kind === 'automation_failed') {
    return message({
      subject: `Automation failing: ${item.title}`,
      kicker: 'Automation alert',
      title: 'An automation is failing',
      lead: { strong: item.title, text: 'is failing.' },
      detail: item.body ? `Error: ${item.body}` : undefined,
      next: 'It stays failing until a run succeeds. Open it to see the last error and fix the cause.',
      cta,
      note,
    });
  }
  if (item.kind === 'automation_recovered') {
    return message({
      subject: `Automation working again: ${item.title}`,
      kicker: 'Automation alert',
      title: 'An automation works again',
      lead: { strong: item.title, text: 'ran successfully after a failure.' },
      next: 'It works again. If it fails again, you get a new alert.',
      cta,
      note,
    });
  }
  return null;
}

/** One email for a user's unread notifications: up to 10 listed, then "and N more". */
export function renderNotificationDigestEmail(input: { items: readonly NotificationEmailItem[]; more: number }): RenderedEmail {
  const total = input.items.length + input.more;
  const noun = total === 1 ? 'notification' : 'notifications';
  const rows = input.items.map((item) => ({ ...item, label: KIND_LABELS[item.kind], href: absoluteAppUrl(item.url) }));
  const moreLine = input.more > 0 ? `And ${input.more} more.` : '';
  const html = rows
    .map((row) => `
        <div style="text-align:left;margin:0 0 16px;">
          <div style="${S.kicker}margin:0 0 2px;">${escapeHtml(row.label)}</div>
          <a href="${escapeHtml(row.href)}" style="${S.strong}text-decoration:underline;">${escapeHtml(row.title)}</a>
          ${row.body ? `<div style="${S.p}margin:2px 0 0;">${escapeHtml(row.body)}</div>` : ''}
        </div>`)
    .join('');
  return message({
    subject: `Review ${total} unread ${noun} in Kortix`,
    kicker: 'Notification digest',
    title: `${total} unread ${noun}`,
    lead: { text: `${total === 1 ? 'This notification was' : 'These notifications were'} unread for 15 minutes or more.` },
    extra: {
      html: `${html}${moreLine ? `<p style="${S.p}text-align:left;">${escapeHtml(moreLine)}</p>` : ''}`,
      text: [
        ...rows.map((row) => [`${row.label}: ${row.title}`, ...(row.body ? [row.body] : []), row.href].join('\n')),
        ...(moreLine ? [moreLine] : []),
      ],
    },
    cta: { url: absoluteAppUrl('/projects'), label: 'Open Kortix' },
    note: 'You get this email for unread questions, failed sessions and shares.',
  });
}

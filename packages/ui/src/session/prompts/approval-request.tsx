'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { Textarea } from '../../primitives/textarea';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  ArrowRightIcon,
  CellSignalHighIcon,
  CheckCircleIcon,
  ClockIcon,
  FileIcon,
  InfoIcon,
  ShieldWarningIcon,
  UserIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import type { SessionAuditAction } from '@kortix/sdk';
import { approvalReviewable } from './session-approval-review';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

/** Matches `Date#toLocaleString()` with no options — date + time, default locale. */
const requestedAtFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Who may decide a call, as the API names it (`resolvers`, KRTX-1724). */
export type ApprovalResolvers = NonNullable<SessionAuditAction['resolvers']>;

export interface ApprovalRequestData {
  action: string;
  risk: string | null;
  projectName?: string | null;
  requestedAt: string;
  argsPreview: Record<string, unknown> | null;
  reviewComplete?: boolean;
  /** False when the VIEWER may not see connector arguments (Review Center
   *  read-only members). Changes only the wording — the call is unreviewable
   *  either way, but "nothing was recorded" would be a lie here. */
  previewAuthorized?: boolean;
  /** False when the VIEWER may not approve or deny the call (`can_resolve`,
   *  KRTX-1724): the card then says who decides instead of offering a
   *  decision the API answers with 403. */
  canResolve?: boolean;
  /** Who decides the call, for a viewer who may not (`resolvers`). Null or
   *  absent: the plain wording. */
  resolvers?: ApprovalResolvers | null;
  /** The agent's own description of the call's effect (`--reason`). Shown as
   *  unverified: the parameters stay the evidence. */
  approvalContext?: string | null;
  /** Content the server loaded for the reviewer (the draft behind a
   *  `draft_id`). Shown above the call's own arguments. */
  resolvedPreview?: Record<string, unknown> | null;
  /** The connector name `resolvedPreview` was loaded from. */
  resolvedFrom?: string | null;
  /** Set when the server could not load that content (`unavailable`). */
  resolvedError?: string | null;
  resolution?: ApprovalDecisionValue | null;
  pending: boolean;
  status?: string | null;
  resolvedAt?: string | null;
}

export type ApprovalDecisionValue = 'approve' | 'deny';

/** `note` is the approver's optional message; it reaches the agent with the
 *  decision, so a deny can say what to do instead. */
export type ApprovalDecisionHandler = (decision: ApprovalDecisionValue, note?: string) => void;

// The rule lives in the pure module so non-React callers share it.
export { approvalReviewable };

interface ApprovalRequestProps {
  request: ApprovalRequestData;
  onDecision?: ApprovalDecisionHandler;
  busyDecision?: ApprovalDecisionValue | null;
  outcome?: ApprovalDecisionValue | null;
  error?: string | null;
  /** The host renders Approve / Deny itself (the Review Center puts them in
   *  the page header). The card then shows only the call. */
  hideDecision?: boolean;
  /** Who besides a project manager may decide, for a viewer who may not
   *  (`request.canResolve === false`). Null: the plain wording. */
  resolverName?: string | null;
  className?: string;
}

/**
 * `dense` is the in-conversation rendering: the same parameters and the same
 * two buttons, at the notice card's px-3 rhythm and without the page-scale
 * chrome. The full-page and side-panel surfaces keep the default scale.
 */
interface DenseProp {
  dense?: boolean;
}

const PRIORITY_ARGS = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'channel', 'url', 'subject'];

function riskTone(risk: string | null): 'destructive' | 'warning' | 'muted' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'write') return 'warning';
  return 'muted';
}

function orderedArgEntries(preview: Record<string, unknown>): Array<[string, unknown]> {
  const rank = (key: string) => {
    const index = PRIORITY_ARGS.indexOf(key.toLowerCase());
    return index === -1 ? PRIORITY_ARGS.length : index;
  };
  return Object.entries(preview).sort((left, right) => rank(left[0]) - rank(right[0]));
}

/**
 * A parameter value held to a fixed height. A long value (a file list, a
 * document body) would otherwise push the rest of the call off the page. It
 * fades at the cut and expands in place, so nothing is hidden from review.
 */
function ClampedValue({ children, className }: { children: React.ReactNode; className?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    // Expanded, the box has no cut to measure; keep the last answer.
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);
  const clamped = overflows && !expanded;
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={cn(
          !expanded && 'max-h-48 overflow-hidden',
          clamped && '[mask-image:linear-gradient(to_bottom,black_65%,transparent)]',
          className,
        )}
      >
        {children}
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline-offset-2 hover:underline"
        >
          {expanded ? tI18nComplete.raw('text94ea9b1d33a0') : tI18nComplete.raw('textf5c9bd131486')}
        </button>
      ) : null}
    </div>
  );
}

function renderArgValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(renderArgValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function resolvedLabel(
  request: Pick<ApprovalRequestData, 'resolution' | 'status'>,
  outcome?: ApprovalDecisionValue | null,
) {
  const decision = outcome ?? request.resolution;
  if (decision === 'approve') return 'Approved';
  if (decision === 'deny') return 'Denied';
  if (request.status === 'denied') return 'Denied';
  if (request.status === 'error') return 'Failed';
  if (request.status === 'expired') return 'Expired';
  if (request.status === 'ok') return 'Allowed';
  return 'Completed';
}

export function resolvedTone(label: string): 'success' | 'destructive' | 'muted' {
  if (label === 'Approved' || label === 'Allowed') return 'success';
  if (label === 'Denied' || label === 'Failed') return 'destructive';
  return 'muted';
}

/**
 * The send actions that render as an email card. Matched on the action path
 * (`<connector slug>.<tool>`), so a non-mail call with `{to, body}` (an SMS)
 * keeps the key/value list.
 */
const EMAIL_ACTION = /^gmail[\w-]*\.(send_email|send_draft|reply_to_thread)$/i;

/** Header rows of an email: label key → the keys that fill it, first match wins. */
const EMAIL_HEADERS = [
  ['from', ['from', 'from_email', 'sender']],
  ['to', ['to', 'recipient_email', 'recipients']],
  ['cc', ['cc']],
  ['bcc', ['bcc']],
  ['subject', ['subject']],
] as const;
const EMAIL_BODY_KEYS = ['body', 'message_body', 'html'];
const EMAIL_ATTACHMENT_KEYS = ['attachments', 'attachment'];
/** Additional To recipients (Composio `GMAIL_SEND_EMAIL.extra_recipients`): shown in the To row. */
const EXTRA_TO_KEY = 'extra_recipients';
/** Arguments that change nothing a reviewer judges. Every other argument stays visible. */
const EMAIL_HIDDEN_KEYS = ['draft_id', 'user_id', 'is_html'];
const EMAIL_KEYS = new Set<string>([
  ...EMAIL_HEADERS.flatMap(([, keys]) => keys),
  ...EMAIL_BODY_KEYS,
  ...EMAIL_ATTACHMENT_KEYS,
  EXTRA_TO_KEY,
  ...EMAIL_HIDDEN_KEYS,
]);

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function listOf(value: unknown): unknown[] {
  return emptyValue(value) ? [] : Array.isArray(value) ? value : [value];
}

/** An attachment by its file name; the whole value when it has none. */
function attachmentName(item: unknown): unknown {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const named = (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).filename;
    if (typeof named === 'string' && named) return named;
  }
  return item;
}

/**
 * One email built from the content Kortix loaded (`loaded`, the draft) merged
 * over the call's own arguments. Null unless `action` is a mail send and the
 * content reads as an email: a recipient plus a body, a subject or a loaded
 * sender. `extra_recipients` joins the To row; `attachment(s)` is the
 * Attachments row; `rest` is every other argument except the harmless
 * `EMAIL_HIDDEN_KEYS`, shown under the card.
 */
function emailView(
  action: string | null | undefined,
  args: Record<string, unknown> | null,
  loaded: Record<string, unknown> | null,
) {
  if (!action || !EMAIL_ACTION.test(action)) return null;
  const merged = { ...args, ...loaded };
  const pick = (keys: readonly string[]) => keys.find((key) => key in merged);
  const recipient = pick(EMAIL_HEADERS[1][1]);
  if (!recipient || !(pick(EMAIL_BODY_KEYS) || 'subject' in merged || loaded?.from)) return null;
  const valueOf = (keys: readonly string[]) => {
    const key = pick(keys);
    return key === undefined ? undefined : merged[key];
  };
  const header = EMAIL_HEADERS.map(([label, keys]) => {
    if (label !== 'to') return { label, value: valueOf(keys) };
    const to = [...listOf(valueOf(keys)), ...listOf(merged[EXTRA_TO_KEY])];
    return { label, value: to.length > 0 ? to : undefined };
  });
  const body = valueOf(EMAIL_BODY_KEYS);
  const files = listOf(valueOf(EMAIL_ATTACHMENT_KEYS));
  const attachments = files.map(attachmentName);
  const rest = Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !EMAIL_KEYS.has(key)));
  return { header, body, attachments, files, rest };
}

const MERGE_ACTION = /^github[\w-]*\.merge_(a_)?pull_request$/i;
const ISSUE_ACTION = /^linear[\w-]*\.create(_linear)?_issue$/i;
/** Arguments the pull-request card shows itself; every other one is listed under it. */
const MERGE_KEYS = new Set(['owner', 'repo', 'pull_number', 'title', 'head', 'base', 'merge_method']);
/** Arguments the issue card shows itself; every other one is listed under it. */
const ISSUE_KEYS = new Set(['team', 'team_name', 'title', 'description', 'priority', 'assignee', 'labels']);

/** A non-empty string or a number, as text. Null for anything else. */
function textOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function restOf(args: Record<string, unknown> | null, shown: Set<string>) {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !shown.has(key)));
}

/** `{owner, repo}` → "owner/repo"; a `repo` that already has its owner stays as sent. */
function repoOf(merged: Record<string, unknown>): string | null {
  const repo = textOf(merged.repo);
  const owner = textOf(merged.owner);
  if (!repo) return null;
  return owner && !repo.includes('/') ? `${owner}/${repo}` : repo;
}

function mergeView(
  action: string | null | undefined,
  args: Record<string, unknown> | null,
  loaded: Record<string, unknown> | null,
) {
  if (!action || !MERGE_ACTION.test(action)) return null;
  const merged = { ...args, ...loaded };
  const number = textOf(merged.pull_number);
  if (!number) return null;
  return {
    number,
    repo: repoOf(merged),
    title: textOf(merged.title),
    head: textOf(merged.head),
    base: textOf(merged.base),
    method: textOf(merged.merge_method),
    rest: restOf(args, MERGE_KEYS),
  };
}

/** Linear priority: the word when the call sends one, its 1–4 level otherwise. 0 is "no priority". */
export type IssuePriority = { word: string } | { level: 1 | 2 | 3 | 4 } | null;

function priorityOf(value: unknown): IssuePriority {
  if (typeof value === 'number') {
    return value === 1 || value === 2 || value === 3 || value === 4 ? { level: value } : null;
  }
  const word = textOf(value);
  return word ? { word } : null;
}

function issueView(
  action: string | null | undefined,
  args: Record<string, unknown> | null,
  loaded: Record<string, unknown> | null,
) {
  if (!action || !ISSUE_ACTION.test(action)) return null;
  const merged = { ...args, ...loaded };
  const title = textOf(merged.title);
  if (!title) return null;
  return {
    team: textOf(merged.team_name) ?? textOf(merged.team),
    title,
    description: textOf(merged.description),
    priority: priorityOf(merged.priority),
    assignee: textOf(merged.assignee),
    labels: listOf(merged.labels).map(textOf).filter((label): label is string => label !== null),
    rest: restOf(args, ISSUE_KEYS),
  };
}

/**
 * What the call does, in the words of the headline sentence ("Writer wants to
 * …"). Read from the arguments and the content Kortix loaded, never invented:
 * a value the call does not carry falls back to the plain action.
 */
export type ApprovalSubject =
  | { kind: 'email'; recipient: string; others: number }
  | { kind: 'merge'; number: string; base: string | null }
  | { kind: 'issue'; priority: NonNullable<IssuePriority>; team: string }
  | { kind: 'newIssue' }
  | { kind: 'action' };

export function approvalSubject(
  action: string | null | undefined,
  args: Record<string, unknown> | null,
  loaded: Record<string, unknown> | null = null,
): ApprovalSubject {
  const email = emailView(action, args, loaded);
  const to = email ? listOf(email.header.find(({ label }) => label === 'to')?.value).map(textOf) : [];
  if (email && to[0]) return { kind: 'email', recipient: to[0], others: to.length - 1 };
  const merge = mergeView(action, args, loaded);
  if (merge) return { kind: 'merge', number: merge.number, base: merge.base };
  const issue = issueView(action, args, loaded);
  if (issue?.team && issue.priority) return { kind: 'issue', priority: issue.priority, team: issue.team };
  if (action && ISSUE_ACTION.test(action)) return { kind: 'newIssue' };
  return { kind: 'action' };
}

/** The word on the Approve button: what approving does. */
export function approvalVerb(action: string | null | undefined): 'send' | 'merge' | 'create' | null {
  if (!action) return null;
  if (EMAIL_ACTION.test(action)) return 'send';
  if (MERGE_ACTION.test(action)) return 'merge';
  if (ISSUE_ACTION.test(action)) return 'create';
  return null;
}

/** The translated priority word ("High"). */
export function useIssuePriorityWord(): (priority: NonNullable<IssuePriority>) => string {
  const t = useTranslations('hardcodedUi.approvalPage');
  return (priority) => ('word' in priority ? priority.word : t(`priority${priority.level}`));
}

/** An attachment's size, when the call states one in bytes. */
const kilobytes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'kilobyte',
  maximumFractionDigits: 0,
});
function attachmentSize(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const size = (item as Record<string, unknown>).size;
  return typeof size === 'number' && size >= 0 ? kilobytes.format(Math.max(1, size / 1024)) : null;
}

/** The call names its target only by id (`draft_id`), or names nothing at all. */
function argsOnlyIds(preview: Record<string, unknown> | null): boolean {
  return Object.keys(preview ?? {}).every((key) => /^id$|_id$|Id$/.test(key));
}

function ArgValue({
  value,
  channelNames,
}: {
  value: unknown;
  channelNames?: ReadonlyMap<string, string>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.approvalParameters');
  if (emptyValue(value)) return <span className="text-muted-foreground">{t('none')}</span>;
  if (value === '[redacted]') {
    return (
      <span className="text-muted-foreground italic">{tI18nComplete.raw('text1c57f31d6315')}</span>
    );
  }
  return (
    <>
      {renderArgValue(value)}
      {typeof value === 'string' && channelNames?.has(value) ? (
        <span className="text-muted-foreground"> · {channelNames.get(value)}</span>
      ) : null}
    </>
  );
}

/** The section label strip: a title and one muted line under it. */
function ParametersStrip({
  title,
  description,
  hint,
  dense,
}: DenseProp & { title: string; description?: string; hint?: string | null }) {
  return (
    <div className={cn('bg-primary/[0.03]', dense ? 'px-3 py-1.5' : 'px-4 py-2')}>
      <p className="text-foreground text-xs font-medium">{title}</p>
      {description ? (
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      ) : null}
      {hint ? (
        <p className="text-muted-foreground mt-1 flex items-start gap-1.5 text-xs text-pretty">
          <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" />
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** One preview's values as a key/value list. */
function PreviewValues({
  preview,
  dense = false,
  channelNames,
}: DenseProp & {
  preview: Record<string, unknown>;
  channelNames?: ReadonlyMap<string, string>;
}) {
  const entries = orderedArgEntries(preview);
  const valueSize = dense ? 'text-xs' : 'text-sm';
  if (entries.length === 0) return null;
  return (
    <dl>
      {entries.map(([key, value]) => (
        <div
          key={key}
          className={cn(
            'border-border grid gap-1 border-b last:border-b-0 sm:gap-3',
            dense
              ? 'px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)]'
              : 'px-4 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]',
          )}
        >
          <dt className="text-muted-foreground font-mono text-xs tracking-normal break-all">{key}</dt>
          <dd className="min-w-0">
            <ClampedValue
              className={cn('text-foreground wrap-break-word whitespace-pre-wrap', valueSize)}
            >
              <ArgValue value={value} channelNames={channelNames} />
            </ClampedValue>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The email a send call delivers: From, To, Cc, Bcc and Subject rows (From,
 * To and Subject always present, an empty one reads "None"; Cc and Bcc only
 * when set), a divider, then the body.
 * `caption` names where loaded content came from ("Loaded from Gmail").
 */
function EmailCard({
  email,
  caption,
  incomplete = null,
  hint = null,
  dense = false,
  channelNames,
}: DenseProp & {
  email: NonNullable<ReturnType<typeof emailView>>;
  caption?: string | null;
  /** The preview was shortened: the line that says elisions are marked in place. */
  incomplete?: string | null;
  /** A warning: content the server could not load. */
  hint?: string | null;
  channelNames?: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('hardcodedUi.approvalParameters');
  const valueSize = dense ? 'text-xs' : 'text-sm';
  const attachments = email.attachments.length > 0 ? email.attachments : null;
  return (
    <div className={dense ? 'px-3 py-2' : 'px-4 py-3'}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
        {email.header
          // Cc and Bcc show only when set; the other rows always show.
          .filter(({ label, value }) => !((label === 'cc' || label === 'bcc') && emptyValue(value)))
          .map(({ label, value }) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground text-xs">{t(label)}</dt>
            <dd
              className={cn(
                'text-foreground min-w-0 wrap-break-word',
                valueSize,
                label === 'subject' && !emptyValue(value) && 'font-medium',
              )}
            >
              <ArgValue value={value} channelNames={channelNames} />
            </dd>
          </Fragment>
        ))}
        {attachments ? (
          <>
            <dt className="text-muted-foreground text-xs">{t('attachments')}</dt>
            <dd className={cn('text-foreground min-w-0 wrap-break-word', valueSize)}>
              <ArgValue value={attachments} />
            </dd>
          </>
        ) : null}
      </dl>
      <div className="border-border mt-3 border-t pt-3">
        <ClampedValue className={cn('text-foreground wrap-break-word whitespace-pre-wrap', valueSize)}>
          <ArgValue value={email.body} />
        </ClampedValue>
      </div>
      {incomplete ? <p className="text-muted-foreground mt-3 text-xs text-pretty">{incomplete}</p> : null}
      {hint ? (
        <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs text-pretty">
          <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" />
          {hint}
        </p>
      ) : null}
      {caption ? <p className="text-muted-foreground mt-3 text-xs">{caption}</p> : null}
    </div>
  );
}

/** A muted line under a native preview: where content came from, or what is missing. */
function PreviewNote({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <p className="text-muted-foreground flex items-start gap-1.5 text-xs text-pretty">
      {warn ? <WarningIcon className="text-kortix-orange mt-px size-3.5 shrink-0" /> : null}
      {children}
    </p>
  );
}

/**
 * The email as the recipient gets it: the header rows (Cc and Bcc only when
 * set), then the subject as a bold line over the body, then each attachment
 * as a small tile.
 */
function NativeEmail({
  email,
  notes,
  channelNames,
}: {
  email: NonNullable<ReturnType<typeof emailView>>;
  notes: React.ReactNode;
  channelNames?: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('hardcodedUi.approvalParameters');
  const subject = email.header.find(({ label }) => label === 'subject')?.value;
  const rows = email.header.filter(
    ({ label, value }) =>
      label !== 'subject' && !((label === 'cc' || label === 'bcc') && emptyValue(value)),
  );
  return (
    <>
      <dl className="border-border grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-b px-4 py-3 text-xs">
        {rows.map(({ label, value }) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="text-foreground min-w-0 wrap-anywhere">
              <ArgValue value={value} channelNames={channelNames} />
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="flex flex-col gap-2 p-4">
        <p className="text-foreground text-sm font-semibold wrap-anywhere">
          {emptyValue(subject) ? (
            <span className="text-muted-foreground font-normal">{t('subject')}: {t('none')}</span>
          ) : (
            <ArgValue value={subject} />
          )}
        </p>
        <ClampedValue className="text-foreground text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
          <ArgValue value={email.body} />
        </ClampedValue>
        {email.files.map((file, index) => {
          const size = attachmentSize(file);
          return (
            <span
              key={index}
              className="bg-muted flex max-w-full items-center gap-2 self-start rounded-md py-1.5 pr-2.5 pl-2 text-xs"
            >
              <FileIcon aria-hidden className="text-foreground size-4 shrink-0" />
              <span className="text-foreground min-w-0 truncate">
                <ArgValue value={email.attachments[index]} />
              </span>
              {size ? <span className="text-muted-foreground shrink-0 tabular-nums">{size}</span> : null}
            </span>
          );
        })}
        {notes}
      </div>
    </>
  );
}

/** A pull request merge as GitHub shows it: repository, title, branches, method. */
function NativeMerge({ view }: { view: NonNullable<ReturnType<typeof mergeView>> }) {
  const t = useTranslations('hardcodedUi.approvalPage');
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {view.repo ? <p className="text-muted-foreground text-xs wrap-anywhere">{view.repo}</p> : null}
      <p className="text-foreground text-sm font-semibold wrap-anywhere">
        {view.title ? `${view.title} #${view.number}` : t('pullRequest', { number: view.number })}
      </p>
      {view.head || view.base || view.method ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {view.head && view.base ? (
            <>
              <code className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 font-mono">{view.head}</code>
              <ArrowRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <code className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 font-mono">{view.base}</code>
            </>
          ) : null}
          {view.method ? (
            <span className="text-muted-foreground">
              {view.head && view.base ? '· ' : ''}
              {t('mergeMethod', { method: view.method })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One property of a new issue, as a small outlined chip. */
function IssueChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="border-border text-foreground flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs">
      {icon}
      {children}
    </span>
  );
}

/** A new issue as Linear shows it: team, title, description, then its properties. */
function NativeIssue({ view }: { view: NonNullable<ReturnType<typeof issueView>> }) {
  const t = useTranslations('hardcodedUi.approvalPage');
  const priorityWord = useIssuePriorityWord();
  const chips = view.priority || view.assignee || view.labels.length > 0;
  return (
    <>
      <div className="flex flex-col gap-2 px-4 py-3">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {view.team ? (
            <>
              <span className="wrap-anywhere">{view.team}</span>
              <span aria-hidden>›</span>
            </>
          ) : null}
          <span>{t('newIssue')}</span>
        </p>
        <p className="text-foreground text-sm font-semibold wrap-anywhere">{view.title}</p>
        {view.description ? (
          <ClampedValue className="text-muted-foreground text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            {view.description}
          </ClampedValue>
        ) : null}
      </div>
      {chips ? (
        <div className="border-border flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5">
          {view.priority ? (
            <IssueChip icon={<CellSignalHighIcon aria-hidden className="size-3 shrink-0" />}>
              {priorityWord(view.priority)}
            </IssueChip>
          ) : null}
          {view.assignee ? (
            <IssueChip icon={<UserIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />}>
              {view.assignee}
            </IssueChip>
          ) : null}
          {view.labels.map((label) => (
            <IssueChip
              key={label}
              icon={<span aria-hidden className="bg-muted-foreground size-2 shrink-0 rounded-full" />}
            >
              {label}
            </IssueChip>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The redacted parameters the connector would receive — the whole reason an
 * approval is decidable rather than a guess. Shared by the standalone page, the
 * Review Center, the Audit panel, and the in-session notice so all show the
 * same values. Renders nothing when the call recorded no arguments and the
 * server loaded nothing: the decision surface says it cannot be reviewed.
 *
 * `resolvedPreview`: content the server loaded for the reviewer (the draft a
 * `draft_id` points at). A mail send (`action`) renders as ONE email
 * (`EmailCard`): the loaded content merged over the arguments, captioned with
 * the connector it came from (`resolvedFrom`), with no section headers. The
 * arguments outside the email follow it as a key/value list, except
 * `draft_id`, `user_id` and `is_html`. Other loaded content renders above the
 * arguments. An empty record counts as absent. `resolvedError`: the server
 * could not load it, so the strip warns that the agent's description is all
 * there is.
 *
 * `channelNames`: a value that is a bound Slack conversation id shows its name
 * beside it. The id stays, because it is the exact parameter.
 */
export function ApprovalParameters({
  action = null,
  argsPreview,
  reviewComplete = true,
  resolvedPreview = null,
  resolvedFrom = null,
  resolvedError = null,
  dense = false,
  native = false,
  channelNames,
  className,
}: DenseProp & {
  /** The call's action path (`gmail.send_email`). Only a mail send renders as an email card. */
  action?: string | null;
  /** Show a Gmail send, a GitHub merge and a Linear issue as the app shows them,
   *  in one bordered card (the approval decision panel). Every argument the
   *  card does not show is listed under it. */
  native?: boolean;
  argsPreview: Record<string, unknown> | null;
  reviewComplete?: boolean;
  resolvedPreview?: Record<string, unknown> | null;
  resolvedFrom?: string | null;
  resolvedError?: string | null;
  channelNames?: ReadonlyMap<string, string>;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.approvalParameters');
  const empty = !argsPreview || Object.keys(argsPreview).length === 0;
  const loaded = resolvedPreview && Object.keys(resolvedPreview).length > 0 ? resolvedPreview : null;
  // Nothing recorded and nothing loaded: no section at all. The decision
  // surface says the call cannot be reviewed.
  if (empty && !loaded) return null;
  const email = emailView(action, argsPreview, loaded);
  // A display name, never the bare slug: `gmail` reads "Gmail".
  const connector = resolvedFrom ? resolvedFrom.charAt(0).toUpperCase() + resolvedFrom.slice(1) : null;
  const caption = loaded
    ? connector
      ? t('loadedFrom', { connector })
      : t('loadedFromConnector')
    : null;
  const frame = cn(
    'divide-border divide-y',
    dense ? 'border-border overflow-hidden rounded-sm border' : 'border-border border-t',
    className,
  );
  if (native) {
    const card = 'border-border divide-border divide-y overflow-hidden rounded-lg border';
    if (email) {
      const incomplete = reviewComplete ? null : tI18nComplete.raw('text877c39a121a9');
      const unavailable = resolvedError
        ? argsPreview && 'draft_id' in argsPreview
          ? t('resolvedUnavailable')
          : t('senderUnavailable')
        : null;
      return (
        <div className={cn(card, className)}>
          <div>
            <NativeEmail
              email={email}
              channelNames={channelNames}
              notes={
                <>
                  {incomplete ? <PreviewNote>{incomplete}</PreviewNote> : null}
                  {unavailable ? <PreviewNote warn>{unavailable}</PreviewNote> : null}
                  {caption ? <PreviewNote>{caption}</PreviewNote> : null}
                </>
              }
            />
          </div>
          <PreviewValues preview={email.rest} channelNames={channelNames} />
        </div>
      );
    }
    const merge = mergeView(action, argsPreview, loaded);
    const issue = merge ? null : issueView(action, argsPreview, loaded);
    const view = merge ?? issue;
    if (view) {
      return (
        <div className={cn(card, className)}>
          <div>{merge ? <NativeMerge view={merge} /> : issue ? <NativeIssue view={issue} /> : null}</div>
          <PreviewValues preview={view.rest} channelNames={channelNames} />
          {reviewComplete && !caption ? null : (
            <div className="flex flex-col gap-1.5 px-4 py-2.5">
              {reviewComplete ? null : <PreviewNote>{tI18nComplete.raw('text877c39a121a9')}</PreviewNote>}
              {caption ? <PreviewNote>{caption}</PreviewNote> : null}
            </div>
          )}
        </div>
      );
    }
  }
  // An email send is ONE email card with no section headers. Arguments that
  // are not part of the email, except the harmless ones, follow it as a list.
  if (email) {
    return (
      <div className={frame}>
        <EmailCard
          email={email}
          caption={caption}
          incomplete={reviewComplete ? null : tI18nComplete.raw('text877c39a121a9')}
          hint={
            resolvedError
              ? argsPreview && 'draft_id' in argsPreview
                ? t('resolvedUnavailable')
                : t('senderUnavailable')
              : null
          }
          dense={dense}
          channelNames={channelNames}
        />
        <PreviewValues preview={email.rest} dense={dense} channelNames={channelNames} />
      </div>
    );
  }
  // The agent's words are all there is: a call that names its target only by
  // id, or content the server could not load.
  const blind = !loaded && argsOnlyIds(argsPreview) && !(empty && !reviewComplete);
  const hint = !loaded && resolvedError ? t('resolvedUnavailable') : blind ? t('idsOnlyHint') : null;

  return (
    <div className={frame}>
      {loaded ? (
        <>
          <ParametersStrip dense={dense} title={caption ?? ''} />
          <PreviewValues preview={loaded} dense={dense} channelNames={channelNames} />
        </>
      ) : null}
      {!empty ? (
        <>
          <ParametersStrip
            dense={dense}
            title={tI18nComplete.raw('texte68b36b17cbd')}
            description={
              reviewComplete
                ? tI18nComplete.raw('textc5a9e0731890')
                : tI18nComplete.raw('text877c39a121a9')
            }
            hint={hint}
          />
          <PreviewValues preview={argsPreview} dense={dense} channelNames={channelNames} />
        </>
      ) : null}
    </div>
  );
}

/**
 * What the agent says the call does. Reference arguments (`{draft_id}`) name a
 * target without showing it, so the agent describes the effect. It is the
 * agent's claim, labelled as such; the parameters below remain the evidence.
 */
export function ApprovalAgentContext({
  context,
  dense = false,
  quote = false,
  className,
}: DenseProp & {
  context: string | null | undefined;
  /** The decision panel: the words as a muted quotation, the note's trigger at the trailing edge, no label. */
  quote?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.approvalParameters');
  const noteId = useId();
  if (!context) return null;
  const trigger = (
    <>
      {/* Radix opens a hover card on pointer hover and on keyboard focus. */}
      <HoverCard openDelay={150}>
        <HoverCardTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground shrink-0"
            aria-label={t('aboutDescription')}
            aria-describedby={noteId}
          >
            <InfoIcon
              weight={quote ? 'regular' : 'fill'}
              className={dense ? 'size-3' : 'size-3.5'}
            />
          </Button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-64 p-3">
          <p className="text-muted-foreground text-xs text-pretty">
            {tI18nComplete.raw('textfa0db737cb09')}
          </p>
        </HoverCardContent>
      </HoverCard>
      {/* The hover card mounts only while open; the note stays readable to
          a screen reader through aria-describedby. */}
      <span id={noteId} className="sr-only">
        {tI18nComplete.raw('textfa0db737cb09')}
      </span>
    </>
  );
  if (quote) {
    return (
      <div className={cn('flex items-start gap-1.5', className)}>
        <p className="text-muted-foreground min-w-0 flex-1 text-sm text-pretty wrap-break-word whitespace-pre-wrap">
          {t('quoted', { text: context })}
        </p>
        {trigger}
      </div>
    );
  }
  return (
    <div
      className={cn(
        dense ? 'border-border rounded-sm border px-3 py-2' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-foreground text-xs font-medium">{tI18nComplete.raw('text9dcde51d9ff2')}</p>
        {trigger}
      </div>
      <p
        className={cn(
          'text-foreground mt-1 wrap-break-word whitespace-pre-wrap',
          dense ? 'text-xs' : 'text-sm',
        )}
      >
        {context}
      </p>
    </div>
  );
}

/**
 * Shown ONLY when the row records no parameters at all — a call written before
 * previews existed, or a viewer not authorised to see connector arguments.
 * There is no Approve button beside it: approving what you cannot see is the
 * one thing this gate exists to prevent, and a permanently disabled control
 * next to a warning is not a decision, it is a dead end.
 */
export function ApprovalUnreviewableNotice({
  previewAuthorized = true,
  dense = false,
  className,
}: DenseProp & { previewAuthorized?: boolean; className?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <p
      className={cn(
        'text-kortix-orange text-xs text-pretty',
        dense ? '' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      {previewAuthorized
        ? tI18nComplete.raw('text7c4a3e7e2251')
        : tI18nComplete.raw('textf7873b149941')}
    </p>
  );
}

/**
 * Who decides a call, in one sentence, for a viewer who may not (KRTX-1724).
 * A session started with an API token or a service account is decided by
 * managers only (`resolvers: 'managers'`). Otherwise the person who started
 * it decides too: `resolverName` names them when it is known.
 */
export function useApprovalWaitingText(
  resolvers?: ApprovalResolvers | null,
  resolverName?: string | null,
): string {
  const t = useTranslations('hardcodedUi.approvalWaiting');
  if (resolvers === 'managers') return t('byManager');
  return resolverName ? t('byName', { name: resolverName }) : t('byOwner');
}

/** Shown in place of the decision to a viewer who may not decide the call. */
export function ApprovalWaitingNotice({
  resolverName,
  resolvers,
  dense = false,
  className,
}: DenseProp & {
  resolverName?: string | null;
  resolvers?: ApprovalResolvers | null;
  className?: string;
}) {
  const text = useApprovalWaitingText(resolvers, resolverName);
  return (
    <p
      className={cn(
        'text-muted-foreground flex items-start gap-1.5 text-xs text-pretty',
        dense ? '' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      <ClockIcon className="mt-px size-3.5 shrink-0" />
      {text}
    </p>
  );
}

/**
 * The only two decisions on offer, everywhere. Deliberately no "allow for
 * session" / "always allow": a decision applies to exactly the call that asked
 * for it — a one-click waiver would pre-authorise later calls with entirely
 * different arguments. Standing permission is authored in the Policies panel.
 */
export function ApprovalDecisionActions({
  onDecision,
  busyDecision = null,
  approvable = true,
  disabled = false,
  dense = false,
  stretch = false,
  sessionId,
  notePlaceholder,
  approveLabel,
  className,
}: DenseProp & {
  /** The note's label and placeholder. Default: "Message to the agent (optional)". */
  notePlaceholder?: string;
  /** The Approve button's words. Default: "Approve this call". */
  approveLabel?: string;
  /** Both decisions and the note are off: the call can no longer be decided. */
  disabled?: boolean;
  /** Picks the session's own busy mark, the one its busy indicator shows.
   *  Without it the default mark is used. */
  sessionId?: string | null;
  /** The two decisions share the row in equal halves (the standalone page's
   *  narrow column), instead of sitting at its trailing edge. */
  stretch?: boolean;
  onDecision: ApprovalDecisionHandler;
  busyDecision?: ApprovalDecisionValue | null;
  /** False only when the call shows nothing to review — Approve is then not
   *  offered at all, instead of rendered as a control that can never fire. */
  approvable?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [note, setNote] = useState('');
  const size = dense ? 'sm' : 'default';
  const decide = (decision: ApprovalDecisionValue) =>
    onDecision(decision, note.trim() || undefined);

  return (
    <div className={cn('space-y-2', dense ? '' : 'border-border border-t px-4 py-3', className)}>
      <Textarea
        aria-label={notePlaceholder ?? tI18nComplete.raw('text2edf70730233')}
        placeholder={notePlaceholder ?? tI18nComplete.raw('text2edf70730233')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        disabled={disabled || busyDecision !== null}
        minHeight={36}
        maxHeight={160}
        className={cn('font-normal', dense ? 'text-xs' : 'text-sm')}
      />
      <div
        className={cn(
          'flex gap-2',
          stretch ? '[&>button]:flex-1' : 'flex-col-reverse sm:flex-row sm:justify-end',
        )}
      >
        <Button
          type="button"
          size={size}
          variant="outline"
          disabled={disabled || busyDecision !== null}
          onClick={() => decide('deny')}
        >
          {busyDecision === 'deny' ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
          {tI18nComplete.raw('text05a2d7332eb9')}
        </Button>
        {approvable ? (
          <Button
            type="button"
            size={size}
            disabled={disabled || busyDecision !== null}
            onClick={() => decide('approve')}
          >
            {busyDecision === 'approve' ? (
              <SessionDotMatrix size={14} className="shrink-0" />
            ) : null}
            {approveLabel ?? tI18nComplete.raw('texta1982c442ca3')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ApprovalRequest({
  request,
  onDecision,
  busyDecision = null,
  outcome = null,
  error = null,
  hideDecision = false,
  resolverName = null,
  className,
}: ApprovalRequestProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const reviewComplete = request.reviewComplete !== false;
  const reviewable = approvalReviewable(
    request.argsPreview,
    request.reviewComplete,
    request.resolvedPreview,
  );
  const waiting = request.pending && outcome === null && request.canResolve === false;
  const actionable = request.pending && !waiting && onDecision;
  const resolved = !request.pending || outcome !== null;
  const resolutionLabel = resolvedLabel(request, outcome);
  const resolutionTone = resolvedTone(resolutionLabel);
  const positiveResolution = resolutionTone === 'success';

  return (
    <section className={cn('bg-popover overflow-hidden rounded-md border', className)}>
      <header className="flex items-start gap-3 px-4 py-4">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-sm',
            resolved
              ? positiveResolution
                ? 'bg-kortix-green/15 text-kortix-green'
                : resolutionTone === 'destructive'
                  ? 'bg-kortix-red/15 text-kortix-red'
                  : 'bg-muted text-muted-foreground'
              : 'bg-kortix-orange/15 text-kortix-orange',
          )}
        >
          {resolved ? (
            positiveResolution ? (
              <CheckCircleIcon weight="fill" className="size-5" />
            ) : (
              <XCircleIcon weight="fill" className="size-5" />
            )
          ) : (
            <ShieldWarningIcon className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              {tI18nComplete.raw('text00d60e31a4e6')}
            </span>
            <code className="text-foreground font-mono text-sm font-medium break-all">
              {request.action}
            </code>
            {request.risk ? (
              <Badge variant={riskTone(request.risk)} size="xs" className="capitalize">
                {request.risk}
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs text-pretty">
            {request.projectName ? `${request.projectName} · ` : ''}
            {tI18nComplete.raw('text2d9e28289fac')}{' '}
            {requestedAtFormat.format(new Date(request.requestedAt))}
          </p>
        </div>
        {resolved ? (
          <Badge variant={resolutionTone} size="sm">
            {resolutionLabel}
          </Badge>
        ) : null}
      </header>

      <ApprovalAgentContext context={request.approvalContext} />

      <ApprovalParameters
        action={request.action}
        argsPreview={request.argsPreview}
        reviewComplete={reviewComplete}
        resolvedPreview={request.resolvedPreview}
        resolvedFrom={request.resolvedFrom}
        resolvedError={request.resolvedError}
      />

      {error ? (
        <p className="text-destructive border-border border-t px-4 py-3 text-xs">{error}</p>
      ) : null}

      {actionable && !reviewable ? (
        <ApprovalUnreviewableNotice previewAuthorized={request.previewAuthorized !== false} />
      ) : null}

      {actionable && !hideDecision ? (
        <ApprovalDecisionActions
          onDecision={actionable}
          busyDecision={busyDecision}
          approvable={reviewable}
        />
      ) : null}

      {waiting ? (
        <ApprovalWaitingNotice resolverName={resolverName} resolvers={request.resolvers} />
      ) : null}
    </section>
  );
}

'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { Textarea } from '../../primitives/textarea';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  CheckCircleIcon,
  ClockIcon,
  ShieldWarningIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import type { SessionAuditAction } from '@kortix/sdk';
import { approvalReviewable } from './session-approval-review';
import { Fragment, useEffect, useRef, useState } from 'react';

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

/** Header rows of an email: label key → the keys that fill it, first match wins. */
const EMAIL_HEADERS = [
  ['from', ['from', 'sender']],
  ['to', ['to', 'recipient_email', 'recipients']],
  ['cc', ['cc']],
  ['bcc', ['bcc']],
  ['subject', ['subject']],
] as const;
const EMAIL_BODY_KEYS = ['body', 'message_body', 'html'];

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * One email built from the content Kortix loaded (`loaded`, the draft) merged
 * over the call's own arguments: every header row and the body, each present
 * even when empty. Null when neither reads as an email: a recipient plus a
 * body, a subject or a loaded sender.
 */
function emailView(args: Record<string, unknown> | null, loaded: Record<string, unknown> | null) {
  const merged = { ...args, ...loaded };
  const pick = (keys: readonly string[]) => keys.find((key) => key in merged);
  const recipient = pick(EMAIL_HEADERS[1][1]);
  if (!recipient || !(pick(EMAIL_BODY_KEYS) || 'subject' in merged || loaded?.from)) return null;
  const valueOf = (keys: readonly string[]) => {
    const key = pick(keys);
    return key === undefined ? undefined : merged[key];
  };
  const header = EMAIL_HEADERS.map(([label, keys]) => ({ label, value: valueOf(keys) }));
  const body = valueOf(EMAIL_BODY_KEYS);
  const attachments = loaded?.attachments;
  return { header, body, attachments };
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
 * The email a send call delivers: From, To, Cc, Bcc and Subject rows (each
 * always present; an empty one reads "None"), a divider, then the body.
 * `caption` names where loaded content came from ("Loaded from Gmail").
 */
function EmailCard({
  email,
  caption,
  dense = false,
  channelNames,
}: DenseProp & {
  email: NonNullable<ReturnType<typeof emailView>>;
  caption?: string | null;
  channelNames?: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('hardcodedUi.approvalParameters');
  const valueSize = dense ? 'text-xs' : 'text-sm';
  const attachments = Array.isArray(email.attachments) && email.attachments.length > 0 ? email.attachments : null;
  return (
    <div className={dense ? 'px-3 py-2' : 'px-4 py-3'}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
        {email.header.map(({ label, value }) => (
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
      {caption ? <p className="text-muted-foreground mt-3 text-xs">{caption}</p> : null}
    </div>
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
 * `draft_id` points at). An email send renders as ONE email (`EmailCard`):
 * the loaded content merged over the arguments, captioned with the connector
 * it came from (`resolvedFrom`), with no other section; arguments that are
 * not part of the email are not shown. Other loaded content renders above the
 * arguments. An empty record counts as absent. `resolvedError`: the server
 * could not load it, so the strip warns that the agent's description is all
 * there is.
 *
 * `channelNames`: a value that is a bound Slack conversation id shows its name
 * beside it. The id stays, because it is the exact parameter.
 */
export function ApprovalParameters({
  argsPreview,
  reviewComplete = true,
  resolvedPreview = null,
  resolvedFrom = null,
  resolvedError = null,
  dense = false,
  channelNames,
  className,
}: DenseProp & {
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
  const email = emailView(argsPreview, loaded);
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
  // An email send is ONE email: no section headers, and the arguments that
  // are not part of the email (`draft_id`, `is_html`) stay out of it.
  if (email) {
    return (
      <div className={frame}>
        <EmailCard email={email} caption={caption} dense={dense} channelNames={channelNames} />
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
  className,
}: DenseProp & { context: string | null | undefined; className?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (!context) return null;
  return (
    <div
      className={cn(
        dense ? 'border-border rounded-sm border px-3 py-2' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      <p className="text-foreground text-xs font-medium">{tI18nComplete.raw('text9dcde51d9ff2')}</p>
      <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
        {tI18nComplete.raw('textfa0db737cb09')}
      </p>
      <p
        className={cn(
          'text-foreground mt-2 wrap-break-word whitespace-pre-wrap',
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
  className,
}: DenseProp & {
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
        aria-label={tI18nComplete.raw('text2edf70730233')}
        placeholder={tI18nComplete.raw('text2edf70730233')}
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
            {tI18nComplete.raw('texta1982c442ca3')}
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

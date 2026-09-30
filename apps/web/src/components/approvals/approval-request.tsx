'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CheckCircleIcon, ShieldWarningIcon, XCircleIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/** Matches `Date#toLocaleString()` with no options — date + time, default locale. */
const requestedAtFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

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
  /** The agent's own description of the call's effect (`--reason`). Shown as
   *  unverified: the parameters stay the evidence. */
  approvalContext?: string | null;
  resolution?: ApprovalDecisionValue | null;
  pending: boolean;
  status?: string | null;
  resolvedAt?: string | null;
}

export type ApprovalDecisionValue = 'approve' | 'deny';

/** `note` is the approver's optional message; it reaches the agent with the
 *  decision, so a deny can say what to do instead. */
export type ApprovalDecisionHandler = (decision: ApprovalDecisionValue, note?: string) => void;

/**
 * Can a human actually judge this call from what we recorded?
 *
 * TRUNCATION IS NOT BLINDNESS. `reviewComplete` (server:
 * `args_preview_complete`) goes false whenever the preview builder elided
 * ANYTHING — an 11th recipient, a 96-char URL, a fourth nesting level, an
 * attachment body — and every elision is written into the preview the human
 * reads (`[+3 more]`, `[204800 chars omitted]`). Gating the decision on it made
 * an ordinary "email this PDF" call permanently un-approvable: a disabled
 * button beside a warning, with Deny as the only possible answer.
 *
 * Reviewability is the narrower question: is there anything to look at? A call
 * that shows its parameters is decidable, elisions and all. One that shows none
 * is not — and no approve path is offered for it, rather than a dead control.
 *
 * Mirrors `approvalPreviewReviewable` in apps/api (connectors/args-preview.ts),
 * which enforces the same rule on POST /approvals/:executionId.
 */
export function approvalReviewable(
  argsPreview: Record<string, unknown> | null | undefined,
  reviewComplete: boolean | undefined,
): boolean {
  if (argsPreview && Object.keys(argsPreview).length > 0) return true;
  // No preview is still reviewable when the server confirms nothing was
  // withheld — an argument-less call hides nothing.
  return reviewComplete !== false;
}

interface ApprovalRequestProps {
  request: ApprovalRequestData;
  onDecision?: ApprovalDecisionHandler;
  busyDecision?: ApprovalDecisionValue | null;
  outcome?: ApprovalDecisionValue | null;
  error?: string | null;
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
  if (request.status === 'ok') return 'Allowed';
  return 'Completed';
}

export function resolvedTone(label: string): 'success' | 'destructive' | 'muted' {
  if (label === 'Approved' || label === 'Allowed') return 'success';
  if (label === 'Denied' || label === 'Failed') return 'destructive';
  return 'muted';
}

/**
 * The redacted parameters the connector would receive — the whole reason an
 * approval is decidable rather than a guess. Shared by the standalone page, the
 * Audit panel, and the in-session notice so all three show the same values.
 */
export function ApprovalParameters({
  argsPreview,
  reviewComplete = true,
  dense = false,
  className,
}: DenseProp & {
  argsPreview: Record<string, unknown> | null;
  reviewComplete?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const entries = argsPreview ? orderedArgEntries(argsPreview) : [];

  return (
    <div
      className={cn(
        dense ? 'border-border overflow-hidden rounded-sm border' : 'border-border border-t',
        className,
      )}
    >
      <div
        className={cn(
          'bg-primary/[0.03] border-border',
          // No list under it means no divider — otherwise the empty case draws
          // a rule along the bottom of the box for nothing.
          entries.length > 0 && 'border-b',
          dense ? 'px-3 py-1.5' : 'px-4 py-2',
        )}
      >
        <p className="text-foreground text-xs font-medium">
          {tI18nComplete.raw('texte68b36b17cbd')}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          {entries.length === 0
            ? tI18nComplete.raw('textf126c0b0d185')
            : reviewComplete
              ? tI18nComplete.raw('textc5a9e0731890')
              : tI18nComplete.raw('text877c39a121a9')}
        </p>
      </div>
      {entries.length > 0 && (
        <dl>
          {entries.map(([key, value]) => (
            <div
              key={key}
              className={cn(
                'border-border grid gap-1 border-b last:border-b-0 sm:gap-3',
                dense
                  ? 'px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)]'
                  : 'px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]',
              )}
            >
              <dt className="text-muted-foreground font-mono text-xs break-all">{key}</dt>
              <dd
                className={cn(
                  'text-foreground min-w-0 wrap-break-word whitespace-pre-wrap',
                  dense ? 'text-xs' : 'text-sm',
                )}
              >
                {value === '[redacted]' ? (
                  <span className="text-muted-foreground italic">
                    {tI18nComplete.raw('text1c57f31d6315')}
                  </span>
                ) : (
                  renderArgValue(value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
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
 * The only two decisions on offer, everywhere. Deliberately no "allow for
 * session" / "always allow": a decision applies to exactly the call that asked
 * for it — a one-click waiver would pre-authorise later calls with entirely
 * different arguments. Standing permission is authored in the Policies panel.
 */
export function ApprovalDecisionActions({
  onDecision,
  busyDecision = null,
  approvable = true,
  dense = false,
  stretch = false,
  className,
}: DenseProp & {
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
        disabled={busyDecision !== null}
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
          disabled={busyDecision !== null}
          onClick={() => decide('deny')}
        >
          {busyDecision === 'deny' ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <XIcon className="size-4 shrink-0" />
          )}
          {tI18nComplete.raw('text05a2d7332eb9')}
        </Button>
        {approvable ? (
          <Button
            type="button"
            size={size}
            disabled={busyDecision !== null}
            onClick={() => decide('approve')}
          >
            {busyDecision === 'approve' ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <CheckCircleIcon className="size-4 shrink-0" />
            )}
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
  className,
}: ApprovalRequestProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const reviewComplete = request.reviewComplete !== false;
  const reviewable = approvalReviewable(request.argsPreview, request.reviewComplete);
  const actionable = request.pending && onDecision;
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

      <ApprovalParameters argsPreview={request.argsPreview} reviewComplete={reviewComplete} />

      {error ? (
        <p className="text-destructive border-border border-t px-4 py-3 text-xs">{error}</p>
      ) : null}

      {actionable && !reviewable ? (
        <ApprovalUnreviewableNotice previewAuthorized={request.previewAuthorized !== false} />
      ) : null}

      {actionable ? (
        <ApprovalDecisionActions
          onDecision={actionable}
          busyDecision={busyDecision}
          approvable={reviewable}
        />
      ) : null}
    </section>
  );
}

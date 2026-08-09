'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { CheckCircleIcon, ShieldWarningIcon, XCircleIcon, XIcon } from '@phosphor-icons/react';

export interface ApprovalRequestData {
  action: string;
  risk: string | null;
  projectName?: string | null;
  requestedAt: string;
  argsPreview: Record<string, unknown> | null;
  reviewComplete?: boolean;
  resolution?: ApprovalDecisionValue | null;
  pending: boolean;
  status?: string | null;
  resolvedAt?: string | null;
}

export type ApprovalDecisionValue = 'approve' | 'deny';

interface ApprovalRequestProps {
  request: ApprovalRequestData;
  onDecision?: (decision: ApprovalDecisionValue) => void;
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

function resolvedLabel(request: ApprovalRequestData, outcome?: ApprovalDecisionValue | null) {
  const decision = outcome ?? request.resolution;
  if (decision === 'approve') return 'Approved';
  if (decision === 'deny') return 'Denied';
  if (request.status === 'denied') return 'Denied';
  if (request.status === 'error') return 'Failed';
  if (request.status === 'ok') return 'Allowed';
  return 'Completed';
}

function resolvedTone(label: string): 'success' | 'destructive' | 'muted' {
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
          'bg-primary/[0.03] border-border border-b',
          dense ? 'px-3 py-1.5' : 'px-4 py-2',
        )}
      >
        <p className="text-foreground text-xs font-medium">Parameters</p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          {reviewComplete
            ? 'These are the redacted values the connector will receive.'
            : 'Some connector values could not be displayed in full.'}
        </p>
      </div>
      {entries.length > 0 ? (
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
                  <span className="text-muted-foreground italic">Hidden credential</span>
                ) : (
                  renderArgValue(value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p
          className={cn(
            'text-muted-foreground text-xs text-pretty',
            dense ? 'px-3 py-2' : 'px-4 py-4',
          )}
        >
          This call has no recorded parameter preview. Review the session context before you approve
          it.
        </p>
      )}
    </div>
  );
}

/** Why Approve is unavailable. Denying an unreviewable call is still allowed. */
export function ApprovalIncompleteNotice({
  dense = false,
  className,
}: DenseProp & { className?: string }) {
  return (
    <p
      className={cn(
        'text-kortix-orange text-xs text-pretty',
        dense ? '' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      Kortix cannot approve this call because the complete parameters are not available. You can
      deny it.
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
  approveDisabled = false,
  dense = false,
  className,
}: DenseProp & {
  onDecision: (decision: ApprovalDecisionValue) => void;
  busyDecision?: ApprovalDecisionValue | null;
  approveDisabled?: boolean;
  className?: string;
}) {
  const size = dense ? 'sm' : 'default';

  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        dense ? '' : 'border-border border-t px-4 py-3',
        className,
      )}
    >
      <Button
        type="button"
        size={size}
        variant="outline"
        disabled={busyDecision !== null}
        onClick={() => onDecision('deny')}
      >
        {busyDecision === 'deny' ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <XIcon className="size-4 shrink-0" />
        )}
        Deny
      </Button>
      <Button
        type="button"
        size={size}
        disabled={busyDecision !== null || approveDisabled}
        onClick={() => onDecision('approve')}
      >
        {busyDecision === 'approve' ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <CheckCircleIcon className="size-4 shrink-0" />
        )}
        Approve this call
      </Button>
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
  const reviewComplete = request.reviewComplete !== false;
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
            <span className="text-muted-foreground text-xs">Run</span>
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
            Requested {new Date(request.requestedAt).toLocaleString()}
          </p>
        </div>
        {resolved ? (
          <Badge variant={resolutionTone} size="sm">
            {resolutionLabel}
          </Badge>
        ) : null}
      </header>

      <ApprovalParameters argsPreview={request.argsPreview} reviewComplete={reviewComplete} />

      {error ? (
        <p className="text-destructive border-border border-t px-4 py-3 text-xs">{error}</p>
      ) : null}

      {!reviewComplete ? <ApprovalIncompleteNotice /> : null}

      {actionable ? (
        <ApprovalDecisionActions
          onDecision={actionable}
          busyDecision={busyDecision}
          approveDisabled={!reviewComplete}
        />
      ) : null}
    </section>
  );
}

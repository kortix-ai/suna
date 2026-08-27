'use client';

/**
 * In-session "agent needs your approval" card, pinned above the composer.
 *
 * It is a decision surface again — but only because it now shows what is being
 * decided. Two rules constrain it, and both came from real failures:
 *
 *  1. **Never ask an unanswerable question.** The card used to show
 *     `Run gmail.send_email` and nothing else — no recipient, no subject — so
 *     "is this allowed?" could not be judged. Whether a call is safe depends on
 *     its ARGUMENTS. The fix was to move the decision to a standalone page that
 *     listed them; the fix here is to expand the redacted parameters in place,
 *     using the SAME `ApprovalParameters` component that page renders. The
 *     question and the evidence now arrive together, without leaving the
 *     session.
 *  2. **One decision, one call.** The buttons are exactly Deny and Approve this
 *     call (`ApprovalDecisionActions`). The old session-wide, blanket, and
 *     per-tool waiver buttons are gone: a reflex click that clears today's
 *     prompt must not pre-authorise every later call, including ones with
 *     entirely different arguments. To let a tool run unattended, author an
 *     `always_run` rule in the Policies panel, where the whole rule set is in
 *     view.
 *
 * The standalone /approve/<token> page stays, reachable from the ↗ on every
 * row. That link is what gets relayed out-of-band (chat, email), so the human
 * need not be watching the session — and it is the same absolute URL the API
 * mints, so there is one link shape.
 *
 * Liveness is unchanged: rows come from the shared `useSessionAudit` query,
 * which polls every 5s here. A decision taken anywhere else — the link, the
 * Audit panel, another tab — drops the row on the next poll.
 */

import {
  ApprovalDecisionActions,
  type ApprovalDecisionValue,
  ApprovalParameters,
  ApprovalUnreviewableNotice,
  approvalReviewable,
} from '@/components/approvals/approval-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  approvalArgsSummary,
  approvalNoticeHeadline,
  type ApprovalNoticeRow,
  approvalNoticeRows,
  approvalRequestFromAction,
  type DecidedApproval,
  nextExpandedApproval,
} from '@/features/session/session-approval-review';
import {
  relativeTime,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { cn } from '@/lib/utils';
import {
  CaretDownIcon,
  CheckCircleIcon,
  ArrowSquareOutIcon as ExternalLink,
  ShieldWarningIcon as ShieldAlert,
} from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** How long a just-decided row stays on screen to confirm the outcome. */
const DECIDED_LINGER_MS = 5_000;

export function SessionApprovalPrompt() {
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();
  const { data } = useSessionAudit(projectId, projectSessionId);
  const resolve = useResolveApproval(projectId, projectSessionId);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, ApprovalDecisionValue>>({});
  const [decided, setDecided] = useState<Record<string, DecidedApproval>>({});

  // Each lingering confirmation owns one timer; drop them all on unmount so a
  // late setState never lands on a torn-down card.
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const rows = approvalNoticeRows(data?.actions ?? [], decided);

  const decide = (executionId: string, decision: ApprovalDecisionValue) => {
    const row = rows.find((candidate) => candidate.action.execution_id === executionId);
    if (!row) return;
    setBusy((current) => ({ ...current, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision },
      {
        onSuccess: () => {
          setDecided((current) => ({
            ...current,
            [executionId]: { action: row.action, decision },
          }));
          setExpanded((current) => (current === executionId ? null : current));
          successToast(decision === 'approve' ? 'Action approved' : 'Action denied');
          timers.current.push(
            window.setTimeout(() => {
              setDecided((current) => {
                const next = { ...current };
                delete next[executionId];
                return next;
              });
            }, DECIDED_LINGER_MS),
          );
        },
        onError: (cause: unknown) =>
          errorToast(cause instanceof Error ? cause.message : 'Failed to resolve approval'),
        onSettled: () =>
          setBusy((current) => {
            const next = { ...current };
            delete next[executionId];
            return next;
          }),
      },
    );
  };

  return (
    <SessionApprovalNotice
      rows={rows}
      expanded={expanded}
      busy={busy}
      onToggle={(executionId) =>
        setExpanded((current) => nextExpandedApproval(current, executionId))
      }
      onDecide={decide}
    />
  );
}

interface SessionApprovalNoticeProps {
  rows: ApprovalNoticeRow[];
  /** Execution id of the one open row, or null. */
  expanded: string | null;
  busy: Record<string, ApprovalDecisionValue>;
  onToggle: (executionId: string) => void;
  onDecide: (executionId: string, decision: ApprovalDecisionValue) => void;
}

/**
 * The card itself — no data fetching, no mutation, so both the collapsed and
 * the expanded rendering are directly testable.
 */
export function SessionApprovalNotice({
  rows,
  expanded,
  busy,
  onToggle,
  onDecide,
}: SessionApprovalNoticeProps) {
  if (rows.length === 0) return null;

  const pendingCount = rows.filter((row) => row.decision === null).length;
  const headline = approvalNoticeHeadline(pendingCount);

  return (
    <div
      className={cn(
        // `w-full`, or the composer's `items-center` strip shrinks this card to
        // its CONTENT width — so the notice was as wide as whatever tool name
        // happened to be pending, and looked broken at random. Same reason the
        // reply bar and `QuestionPrompt` carry it (see composer.tsx). Vertical
        // spacing belongs to that strip's `gap-2`, not to a margin here.
        'bg-popover w-full overflow-hidden rounded-md border',
        pendingCount > 0 ? 'border-kortix-orange/25' : 'border-border',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b px-3 py-2',
          pendingCount > 0 ? 'border-kortix-orange/20' : 'border-border',
        )}
      >
        {pendingCount > 0 ? (
          <ShieldAlert className="text-kortix-orange size-4" />
        ) : (
          <CheckCircleIcon weight="fill" className="text-kortix-green size-4" />
        )}
        <span className="text-foreground text-xs font-medium">{headline.title}</span>
        {headline.hint ? (
          <span className="text-muted-foreground text-xs">— {headline.hint}</span>
        ) : null}
      </div>
      <ul className="divide-border divide-y">
        {rows.map(({ action, decision }) => {
          const executionId = action.execution_id;
          const summary = approvalArgsSummary(action);
          const request = approvalRequestFromAction(action, decision === null);
          const open = expanded === executionId;
          const reviewComplete = request.reviewComplete !== false;
          // NOT the same test. A shortened value is still a reviewable one —
          // see `approvalReviewable`. Only a call with nothing to show loses
          // the Approve button, and it loses the button rather than wearing a
          // disabled one.
          const reviewable = approvalReviewable(request.argsPreview, request.reviewComplete);

          return (
            <li key={executionId}>
              <Disclosure open={open} onOpenChange={() => onToggle(executionId)}>
                <DisclosureTrigger>
                  <div
                    className={cn(
                      'flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors',
                      'hover:bg-foreground/[0.03]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground text-xs">Run</span>
                        <code className="text-foreground truncate font-mono text-xs font-medium">
                          {action.action}
                        </code>
                        {action.risk ? (
                          <Badge
                            variant={riskTone(action.risk)}
                            size="xs"
                            className="shrink-0 capitalize"
                          >
                            {action.risk}
                          </Badge>
                        ) : null}
                      </div>
                      {summary ? (
                        <p className="text-foreground/80 mt-0.5 truncate font-mono text-xs">
                          {summary}
                        </p>
                      ) : null}
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Requested {relativeTime(action.at)}
                      </p>
                    </div>
                    {decision ? (
                      <Badge
                        variant={decision === 'approve' ? 'success' : 'destructive'}
                        size="sm"
                        className="shrink-0"
                      >
                        {decision === 'approve' ? 'Approved' : 'Denied'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                        Review
                        <CaretDownIcon
                          className={cn(
                            'size-3 transition-transform duration-150',
                            open && 'rotate-180',
                          )}
                        />
                      </span>
                    )}
                    {action.approval_url ? (
                      <Hint label="Open the full approval page" side="top">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground shrink-0"
                          asChild
                        >
                          {/* Plain anchor, not next/link: the same absolute URL is what
                              gets relayed out-of-band, so there is one link shape. It
                              opens a new tab, as the ExternalLink icon promises —
                              in this tab it would tear down the live session. */}
                          <a
                            href={action.approval_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open the full approval page"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        </Button>
                      </Hint>
                    ) : null}
                  </div>
                </DisclosureTrigger>
                <DisclosureContent>
                  <div className="space-y-2 px-3 pb-3">
                    <ApprovalParameters
                      dense
                      argsPreview={request.argsPreview}
                      reviewComplete={reviewComplete}
                    />
                    {decision === null && !reviewable ? <ApprovalUnreviewableNotice dense /> : null}
                    {decision === null ? (
                      <ApprovalDecisionActions
                        dense
                        onDecision={(next) => onDecide(executionId, next)}
                        busyDecision={busy[executionId] ?? null}
                        approvable={reviewable}
                      />
                    ) : null}
                  </div>
                </DisclosureContent>
              </Disclosure>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

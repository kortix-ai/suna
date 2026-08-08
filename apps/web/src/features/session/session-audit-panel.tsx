'use client';

import {
  type ApprovalDecisionValue,
  ApprovalRequest,
  type ApprovalRequestData,
} from '@/components/approvals/approval-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  statusLabel,
  statusTone,
  useResolveApproval,
  useSessionAudit,
  useSessionAuditTimeline,
} from '@/features/session/session-audit-shared';
import type { AuditEvent, SessionAuditAction } from '@kortix/sdk';
import { CaretRightIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

function argsPreview(action: SessionAuditAction): Record<string, unknown> | null {
  const summary = action.result_summary;
  if (!summary || typeof summary !== 'object') return null;
  const preview = summary.args_preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
  return preview as Record<string, unknown>;
}

function requestFromAction(
  action: SessionAuditAction,
  pending = isPendingAction(action),
): ApprovalRequestData {
  const summary = action.result_summary;
  const decision = summary?.decision;
  return {
    action: action.action,
    risk: action.risk,
    requestedAt: action.at,
    argsPreview: argsPreview(action),
    reviewComplete: !pending || !summary || summary.args_preview_complete === true,
    resolution: decision === 'approve' || decision === 'deny' ? decision : null,
    pending,
    status: action.status,
    resolvedAt: action.resolved_at,
  };
}

export function SessionAuditPanel({
  projectId,
  projectSessionId,
}: {
  projectId?: string;
  projectSessionId?: string;
}) {
  const approvalQuery = useSessionAudit(projectId, projectSessionId);
  const { data } = approvalQuery;
  const timelineQuery = useSessionAuditTimeline(projectId, projectSessionId, {
    enabled: data !== undefined && data.audit_access !== false,
  });
  const resolve = useResolveApproval(projectId, projectSessionId);
  const [busy, setBusy] = useState<Record<string, ApprovalDecisionValue>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ApprovalDecisionValue>>({});
  const [selected, setSelected] = useState<SessionAuditAction | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);

  const actions = data?.actions ?? [];
  const events = useMemo(
    () => (timelineQuery.data?.pages ?? []).flatMap((page) => page.events ?? []),
    [timelineQuery.data],
  );
  const pending = actions.filter(isPendingAction);
  const history = events.length > 0 ? [] : actions.filter((action) => !isPendingAction(action));
  const historyGated = data?.audit_access === false;

  const decide = (executionId: string, decision: ApprovalDecisionValue) => {
    setBusy((current) => ({ ...current, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision },
      {
        onSuccess: () => {
          setOutcomes((current) => ({ ...current, [executionId]: decision }));
          successToast(decision === 'approve' ? 'Action approved' : 'Action denied');
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
    <div className="flex h-full w-full flex-col">
      <header className="border-border flex-shrink-0 border-b px-6 py-3">
        <h2 className="text-foreground text-sm font-medium">Audit</h2>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          Reconstruct every session event in order and review governed actions.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {approvalQuery.isLoading || (data?.audit_access !== false && timelineQuery.isLoading) ? (
          <div className="flex justify-center py-16">
            <Loading />
          </div>
        ) : approvalQuery.isError || timelineQuery.isError ? (
          <ErrorState
            size="sm"
            title="Could not load the audit trail"
            description="Retry the session audit request."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void approvalQuery.refetch();
                  void timelineQuery.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : actions.length === 0 && events.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            size="sm"
            title={historyGated ? 'Nothing awaiting approval' : 'No governed actions yet'}
            description={
              historyGated
                ? 'Pending approvals appear here. Historical audit access requires Enterprise.'
                : 'Messages, tools, connectors, providers, usage, and lifecycle events appear here.'
            }
          />
        ) : (
          <div className="space-y-6">
            {pending.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-foreground text-xs font-medium tracking-wide uppercase">
                    Needs your approval
                  </h3>
                  <Badge variant="warning" size="xs">
                    {pending.length}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {pending.map((action) => {
                    const outcome = outcomes[action.execution_id] ?? null;
                    return (
                      <ApprovalRequest
                        key={action.execution_id}
                        request={requestFromAction(action, outcome === null)}
                        onDecision={(decision) => decide(action.execution_id, decision)}
                        busyDecision={busy[action.execution_id] ?? null}
                        outcome={outcome}
                      />
                    );
                  })}
                </div>
              </section>
            ) : null}

            {events.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Ordered timeline
                  </h3>
                  <Badge variant="muted" size="xs" className="tabular-nums">
                    {events.length}
                  </Badge>
                </div>
                <ul className="bg-popover overflow-hidden rounded-md border">
                  {events.map((event) => (
                    <li key={event.event_id} className="border-border border-b last:border-b-0">
                      <button
                        type="button"
                        className="hover:bg-primary/[0.03] flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors active:scale-[0.96]"
                        onClick={() => setSelectedEvent(event)}
                      >
                        <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-xs tabular-nums">
                          {event.session_sequence ?? '—'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <code className="text-foreground truncate font-mono text-sm">
                              {event.action}
                            </code>
                            {event.phase ? (
                              <Badge variant="outline" size="xs" className="capitalize">
                                {event.phase}
                              </Badge>
                            ) : null}
                            <Badge
                              variant={
                                event.outcome === 'success'
                                  ? 'success'
                                  : event.outcome === 'pending'
                                    ? 'warning'
                                    : event.outcome === 'failure' || event.outcome === 'denied'
                                      ? 'destructive'
                                      : 'muted'
                              }
                              size="xs"
                              className="capitalize"
                            >
                              {event.outcome ?? 'recorded'}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-0.5 truncate text-xs">
                            {event.authoritative_source ?? event.source ?? 'system'} ·{' '}
                            {relativeTime(event.occurred_at)}
                          </p>
                        </div>
                        <CaretRightIcon className="text-muted-foreground size-4 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
                {timelineQuery.hasNextPage ? (
                  <div className="flex justify-center pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={timelineQuery.isFetchingNextPage}
                      onClick={() => void timelineQuery.fetchNextPage()}
                    >
                      {timelineQuery.isFetchingNextPage ? <Loading className="size-3.5" /> : null}
                      Load more events
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {history.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  History
                </h3>
                <ul className="bg-popover overflow-hidden rounded-md border">
                  {history.map((action) => (
                    <li
                      key={action.execution_id}
                      className="border-border border-b last:border-b-0"
                    >
                      <button
                        type="button"
                        className="hover:bg-primary/[0.03] flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors"
                        onClick={() => setSelected(action)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <code className="text-foreground truncate font-mono text-sm">
                              {action.action}
                            </code>
                            {action.risk ? (
                              <Badge
                                variant={riskTone(action.risk)}
                                size="xs"
                                className="capitalize"
                              >
                                {action.risk}
                              </Badge>
                            ) : null}
                            <Badge variant={statusTone(action.status)} size="xs">
                              {statusLabel(action.status)}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-0.5 truncate text-xs">
                            {action.acted_by_email ?? 'agent'} · {relativeTime(action.at)}
                            {action.resolved_by_email
                              ? ` · ${action.status === 'denied' ? 'denied' : 'approved'} by ${action.resolved_by_email}`
                              : ''}
                          </p>
                        </div>
                        <CaretRightIcon className="text-muted-foreground size-4 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {historyGated ? (
              <p className="text-muted-foreground text-xs text-pretty">
                Enterprise audit access includes the full history of allowed and denied actions.
              </p>
            ) : null}
          </div>
        )}
      </div>

      <Modal
        open={selected !== null}
        onOpenChange={(open) => (!open ? setSelected(null) : undefined)}
      >
        <ModalContent className="lg:max-w-xl">
          <ModalHeader>
            <ModalTitle>Governed action</ModalTitle>
            <ModalDescription>The same parameter view used for live approvals.</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] overflow-y-auto">
            {selected ? <ApprovalRequest request={requestFromAction(selected, false)} /> : null}
          </ModalBody>
        </ModalContent>
      </Modal>

      <Modal
        open={selectedEvent !== null}
        onOpenChange={(open) => (!open ? setSelectedEvent(null) : undefined)}
      >
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Session event</ModalTitle>
            <ModalDescription>
              Canonical event #{selectedEvent?.session_sequence ?? '—'} with redacted summaries.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] space-y-4 overflow-y-auto">
            {selectedEvent ? (
              <>
                <div className="bg-popover grid rounded-md border sm:grid-cols-2">
                  {[
                    ['Action', selectedEvent.action],
                    ['Phase', selectedEvent.phase],
                    ['Source', selectedEvent.authoritative_source ?? selectedEvent.source],
                    ['Event ID', selectedEvent.event_id],
                    ['OpenCode session', selectedEvent.opencode_session_id],
                    ['Message ID', selectedEvent.message_id],
                    ['Tool call ID', selectedEvent.tool_call_id],
                    ['Execution ID', selectedEvent.execution_id],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="border-border min-w-0 space-y-1 border-b p-3 sm:border-r sm:nth-[2n]:border-r-0"
                    >
                      <p className="text-muted-foreground text-xs font-medium">{label}</p>
                      <p className="text-foreground font-mono text-xs break-all tabular-nums">
                        {value ?? '—'}
                      </p>
                    </div>
                  ))}
                </div>
                {selectedEvent.input_summary || selectedEvent.output_summary ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <AuditSummary label="Redacted input" value={selectedEvent.input_summary} />
                    <AuditSummary label="Redacted output" value={selectedEvent.output_summary} />
                  </div>
                ) : null}
              </>
            ) : null}
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
}

function AuditSummary({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="bg-popover overflow-hidden rounded-md border">
      <div className="border-border border-b px-3 py-2">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
      </div>
      <pre className="text-foreground max-h-64 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

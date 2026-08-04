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
} from '@/features/session/session-audit-shared';
import type { SessionAuditAction } from '@kortix/sdk';
import { CaretRightIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useState } from 'react';

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
  const { data, isLoading, isError, refetch } = useSessionAudit(projectId, projectSessionId);
  const resolve = useResolveApproval(projectId, projectSessionId);
  const [busy, setBusy] = useState<Record<string, ApprovalDecisionValue>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ApprovalDecisionValue>>({});
  const [selected, setSelected] = useState<SessionAuditAction | null>(null);

  const actions = data?.actions ?? [];
  const pending = actions.filter(isPendingAction);
  const history = actions.filter((action) => !isPendingAction(action));
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
          Review governed actions and inspect every parameter before you decide.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loading />
          </div>
        ) : isError ? (
          <ErrorState
            size="sm"
            title="Could not load the audit trail"
            description="Retry the session audit request."
            action={
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                Retry
              </Button>
            }
          />
        ) : actions.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            size="sm"
            title={historyGated ? 'Nothing awaiting approval' : 'No governed actions yet'}
            description={
              historyGated
                ? 'Pending approvals appear here. Historical audit access requires Enterprise.'
                : 'Policy-gated connector calls appear here with their exact parameters.'
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
    </div>
  );
}

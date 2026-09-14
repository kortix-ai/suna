'use client';

import {
  type ApprovalDecisionValue,
  ApprovalRequest,
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
import { approvalRequestFromAction } from '@/features/session/session-approval-review';
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
import { useTranslations } from '@/i18n/use-translations';
import type { AuditEvent, SessionAuditAction } from '@kortix/sdk';
import { CaretRightIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

export function SessionAuditPanel({
  projectId,
  projectSessionId,
}: {
  projectId?: string;
  projectSessionId?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          successToast(
            decision === tI18nComplete.raw('text74e21680eac7')
              ? tI18nComplete.raw('text0674d4a026cb')
              : tI18nComplete.raw('text4341be8eb7f0'),
          );
        },
        onError: (cause: unknown) =>
          errorToast(
            cause instanceof Error ? cause.message : tI18nComplete.raw('textaa7e623fc09a'),
          ),
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
      <header className="border-border shrink-0 border-b px-6 py-3">
        <h2 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('textbb6aea287396')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          {tI18nComplete.raw('text2ce0023296d9')}
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
            title={tI18nComplete.raw('text43127bce57bf')}
            description={tI18nComplete.raw('textb4415e2f9e92')}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void approvalQuery.refetch();
                  void timelineQuery.refetch();
                }}
              >
                {tI18nComplete.raw('text942087cc2d41')}
              </Button>
            }
          />
        ) : actions.length === 0 && events.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            size="sm"
            title={
              historyGated
                ? tI18nComplete.raw('text13d50aaa238b')
                : tI18nComplete.raw('text877c91ca4226')
            }
            description={
              historyGated
                ? tI18nComplete.raw('text382d329c7bac')
                : tI18nComplete.raw('text07d75205a8ee')
            }
          />
        ) : (
          <div className="space-y-6">
            {pending.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-foreground text-xs font-medium">
                    {tI18nComplete.raw('text635ea5c1ebb7')}
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
                        request={approvalRequestFromAction(action, outcome === null)}
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
                  <h3 className="text-muted-foreground text-xs font-medium">
                    {tI18nComplete.raw('text129e6ae61447')}
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
                        className="hover:bg-primary/[0.03] flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-[background-color,transform] active:scale-[0.96]"
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
                      {tI18nComplete.raw('text96f2482de866')}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {history.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-muted-foreground text-xs font-medium">
                  {tI18nComplete.raw('text0e7696009337')}
                </h3>
                <ul className="bg-popover overflow-hidden rounded-md border">
                  {history.map((action) => (
                    <li
                      key={action.execution_id}
                      className="border-border border-b last:border-b-0"
                    >
                      <button
                        type="button"
                        className="hover:bg-primary/[0.03] flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-[background-color,transform] active:scale-[0.96]"
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
                              ? tI18nComplete('text0e16f24ee012', {
                                  value0: action.status === 'denied' ? 'denied' : 'approved',
                                  value1: action.resolved_by_email,
                                })
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
                {tI18nComplete.raw('text3206f60e481f')}
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
            <ModalTitle>{tI18nComplete.raw('textf9b4f002634b')}</ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text18fb4a5618b9')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] overflow-y-auto">
            {selected ? (
              <ApprovalRequest request={approvalRequestFromAction(selected, false)} />
            ) : null}
          </ModalBody>
        </ModalContent>
      </Modal>

      <Modal
        open={selectedEvent !== null}
        onOpenChange={(open) => (!open ? setSelectedEvent(null) : undefined)}
      >
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text7ed62f13532a')}</ModalTitle>
            <ModalDescription>
              {tI18nComplete.raw('text20cec9e797c9')}
              {selectedEvent?.session_sequence ?? '—'} {tI18nComplete.raw('text28419d670fef')}
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
                    [tI18nComplete.raw('text3045abafb173'), selectedEvent.event_id],
                    [tI18nComplete.raw('text5a26f4425c82'), selectedEvent.opencode_session_id],
                    [tI18nComplete.raw('text11d5959da5d3'), selectedEvent.message_id],
                    [tI18nComplete.raw('textfce8323af972'), selectedEvent.tool_call_id],
                    [tI18nComplete.raw('texte8c80b20c2f7'), selectedEvent.execution_id],
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
                    <AuditSummary
                      label={tI18nComplete.raw('text57c5a5829f70')}
                      value={selectedEvent.input_summary}
                    />
                    <AuditSummary
                      label={tI18nComplete.raw('textf130203efa7f')}
                      value={selectedEvent.output_summary}
                    />
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

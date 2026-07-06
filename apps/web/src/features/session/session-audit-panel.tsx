'use client';

/**
 * Side-panel "Audit" view — the PER-SESSION half of the approve/ask/block model.
 *
 * Shows the chronological trail of every governed action the agent took in this
 * session, with any items still awaiting a decision pinned at the top as
 * actionable Approve/Deny cards. The person who launched the session (or an
 * account owner/admin) resolves them here without leaving the session.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  statusLabel,
  statusTone,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import type { SessionAuditAction } from '@kortix/sdk/projects-client';
import { Check, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';

export function SessionAuditPanel({
  projectId,
  projectSessionId,
}: {
  projectId?: string;
  projectSessionId?: string;
}) {
  const { data, isLoading, isError, refetch } = useSessionAudit(projectId, projectSessionId);
  const resolve = useResolveApproval(projectId, projectSessionId);
  const [busy, setBusy] = useState<Record<string, 'approve' | 'deny'>>({});

  const actions = data?.actions ?? [];
  const pending = actions.filter(isPendingAction);
  const history = actions.filter((a) => !isPendingAction(a));
  // Non-Enterprise accounts get pending approvals only — the historical trail
  // is gated on the `auditAccess` entitlement (absent field = entitled backend).
  const historyGated = data?.audit_access === false;

  const decide = (executionId: string, decision: 'approve' | 'deny') => {
    setBusy((b) => ({ ...b, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision },
      {
        onSuccess: () => successToast(decision === 'approve' ? 'Action approved' : 'Action denied'),
        onError: (e: unknown) =>
          errorToast(e instanceof Error ? e.message : 'Failed to resolve approval'),
        onSettled: () =>
          setBusy((b) => {
            const next = { ...b };
            delete next[executionId];
            return next;
          }),
      },
    );
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex-shrink-0 border-b border-border/60 px-6 py-3">
        <h2 className="text-foreground text-sm font-semibold tracking-tight">Audit</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Every governed action this session took — and anything awaiting your approval.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loading className="animate-spin" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <p className="text-muted-foreground text-sm">
              Couldn't load this session's audit trail.
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : actions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <ShieldCheck className="text-muted-foreground/60 size-6" />
            <p className="text-foreground text-sm font-medium">
              {historyGated ? 'Nothing awaiting approval' : 'No governed actions yet'}
            </p>
            <p className="text-muted-foreground text-xs">
              {historyGated
                ? 'Actions the agent needs approval for show up here. The full audit trail is available on the Enterprise plan.'
                : 'When the agent runs a tool or connector a policy gates, it shows up here.'}
            </p>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <section>
                <div className="flex items-center gap-2 bg-amber-400/[0.06] px-6 pt-4 pb-2">
                  <span className="text-foreground text-xs font-semibold uppercase tracking-wide">
                    Needs your approval
                  </span>
                  <Badge variant="warning" size="xs">
                    {pending.length}
                  </Badge>
                </div>
                <List>
                  {pending.map((a) => {
                    const b = busy[a.execution_id];
                    return (
                      <ListRow
                        key={a.execution_id}
                        title={
                          <code title={a.action} className="font-mono text-sm">
                            {a.action}
                          </code>
                        }
                        badges={
                          a.risk ? (
                            <Badge variant={riskTone(a.risk)} size="xs" className="capitalize">
                              {a.risk}
                            </Badge>
                          ) : null
                        }
                        subtitle={
                          <span className="text-muted-foreground text-xs">
                            Requested by {a.acted_by_email ?? 'the agent'} · {relativeTime(a.at)}
                          </span>
                        }
                        trailing={
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1"
                              disabled={!!b}
                              onClick={() => decide(a.execution_id, 'deny')}
                            >
                              {b === 'deny' ? (
                                <Loading className="size-3.5 animate-spin" />
                              ) : (
                                <X className="size-3.5" />
                              )}
                              Deny
                            </Button>
                            <Button
                              size="sm"
                              className="gap-1"
                              disabled={!!b}
                              onClick={() => decide(a.execution_id, 'approve')}
                            >
                              {b === 'approve' ? (
                                <Loading className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                              Approve
                            </Button>
                          </>
                        }
                      />
                    );
                  })}
                </List>
              </section>
            )}

            {history.length > 0 && (
              <section>
                {pending.length > 0 && (
                  <div className="px-6 pt-4 pb-2">
                    <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                      History
                    </span>
                  </div>
                )}
                <List>
                  {history.map((a: SessionAuditAction) => (
                    <ListRow
                      key={a.execution_id}
                      title={<code className="font-mono text-sm">{a.action}</code>}
                      badges={
                        <>
                          {a.risk ? (
                            <Badge variant={riskTone(a.risk)} size="xs" className="capitalize">
                              {a.risk}
                            </Badge>
                          ) : null}
                          <Badge variant={statusTone(a.status)} size="xs">
                            {statusLabel(a.status)}
                          </Badge>
                        </>
                      }
                      subtitle={
                        <span className="text-muted-foreground text-xs">
                          {a.acted_by_email ?? 'agent'} · {relativeTime(a.at)}
                          {a.resolved_by_email
                            ? ` · ${a.status === 'denied' ? 'denied' : 'approved'} by ${a.resolved_by_email}`
                            : ''}
                        </span>
                      }
                    />
                  ))}
                </List>
              </section>
            )}

            {historyGated && (
              <p className="text-muted-foreground px-6 py-4 text-xs">
                The full audit trail of allowed and denied actions is available on the Enterprise
                plan.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

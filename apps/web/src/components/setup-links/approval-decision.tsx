'use client';

import {
  type ApprovalDecisionValue,
  ApprovalRequest,
} from '@/components/approvals/approval-request';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { type ApprovalLinkDetails, getApprovalLink, resolveApproval } from '@kortix/sdk';
import { WarningIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

export function ApprovalDecision({ token }: { token: string }) {
  const [details, setDetails] = useState<ApprovalLinkDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyDecision, setBusyDecision] = useState<ApprovalDecisionValue | null>(null);
  const [outcome, setOutcome] = useState<ApprovalDecisionValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getApprovalLink(token)
      .then((body) => {
        if (!cancelled) setDetails(body);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load this approval.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function decide(decision: ApprovalDecisionValue) {
    if (!details) return;
    setBusyDecision(decision);
    setError(null);
    try {
      await resolveApproval(details.workspace_id, details.execution_id, decision);
      setOutcome(decision);
      setDetails((current) => (current ? { ...current, pending: false } : current));
      successToast(decision === 'approve' ? 'Action approved' : 'Action denied');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not record your decision.';
      setError(message);
      errorToast(message);
    } finally {
      setBusyDecision(null);
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
        <Loading className="size-4 shrink-0" />
        Loading approval
      </div>
    );
  }

  if (!details) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-red/15 text-kortix-red flex size-10 items-center justify-center rounded-sm">
          <WarningIcon className="size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">This approval cannot be opened</p>
        <p className="text-muted-foreground max-w-sm text-xs text-pretty">
          {error ?? 'The link is invalid or expired.'}
        </p>
      </div>
    );
  }

  return (
    <ApprovalRequest
      request={{
        action: details.action,
        risk: details.risk,
        workspaceName: details.workspace_name,
        requestedAt: details.requested_at,
        argsPreview: details.args_preview,
        reviewComplete: details.review_complete === true,
        resolution:
          !details.pending && details.status === 'ok'
            ? 'approve'
            : !details.pending && details.status === 'denied'
              ? 'deny'
              : null,
        pending: details.pending,
        status: details.status,
        resolvedAt: details.resolved_at,
      }}
      onDecision={decide}
      busyDecision={busyDecision}
      outcome={outcome}
      error={error}
    />
  );
}

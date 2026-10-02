'use client';

import type { ApprovalDecisionValue } from '@/components/approvals/approval-request';
import { ApprovalDecisionPanel } from '@/components/setup-links/approval-decision';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { useTranslations } from '@/i18n/use-translations';
import type { ApprovalLinkDetails } from '@kortix/sdk';

import { connectorCallId } from './review-actions';
import type { ReviewItem } from './types';

/**
 * A Connector approval as the standalone approve page reads it, built from the
 * Review Center row the inbox already holds — no second request. Null for any
 * item that is not one adapted Connector call.
 */
export function reviewApprovalDetails(item: ReviewItem): ApprovalLinkDetails | null {
  const executionId = connectorCallId(item.id);
  const call = item.kind === 'approval' ? item.detail.actions?.[0] : undefined;
  if (!executionId || !call) return null;
  const pending = item.status === 'needs_you';
  return {
    kind: 'approval',
    project_id: '',
    project_name: item.project,
    execution_id: executionId,
    session_id: item.sessionId ?? null,
    action: call.actionPath || call.title,
    connector: call.connector || null,
    risk: call.connectorRisk ?? null,
    status: item.status === 'approved' ? 'ok' : item.status === 'rejected' ? 'denied' : 'pending_approval',
    pending,
    args_preview: call.rawArgsPreview ?? null,
    review_complete: call.reviewComplete === true,
    args_summary: null,
    approval_context: call.approvalContext ?? null,
    policy_source: call.policySource,
    requested_at: item.createdAt,
    resolved_at: null,
    expires_at: '',
  };
}

/**
 * The standalone approve page (`/approve/[token]`), in a modal over the inbox.
 * One approval UI everywhere: the same panel, the same rows, the same decision.
 * No `onDecision` = the viewer may read the call but not decide it.
 */
export function ApprovalDecisionModal({
  details,
  previewAuthorized,
  busyDecision,
  onDecision,
  onOpenSession,
  onClose,
}: {
  details: ApprovalLinkDetails | null;
  previewAuthorized?: boolean;
  busyDecision: ApprovalDecisionValue | null;
  onDecision?: (decision: ApprovalDecisionValue, note?: string) => void;
  onOpenSession?: () => void;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Modal open={details !== null} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="lg:h-auto lg:max-h-[85svh] lg:max-w-md">
        <ModalTitle className="sr-only">{tI18nComplete.raw('text1862f81ed9d6')}</ModalTitle>
        <ModalDescription className="sr-only">
          {tI18nComplete.raw('text32c6817c8380')}
        </ModalDescription>
        {details ? (
          <div className="px-6 pt-8 pb-6">
            <ApprovalDecisionPanel
              details={details}
              outcome={null}
              busyDecision={busyDecision}
              error={null}
              onDecision={onDecision}
              onOpenSession={onOpenSession}
              previewAuthorized={previewAuthorized}
            />
          </div>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

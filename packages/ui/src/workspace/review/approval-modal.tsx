'use client';

import {
  type ApprovalDecisionValue,
  type ApprovalResolvers,
  useApprovalWaitingText,
} from '../../session/prompts/approval-request';
import { ApprovalDecisionPanel } from '../../markdown/setup-links/approval-decision';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import { useTranslations } from '../../i18n';
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
  // `waiting`: still pending, on someone else's decision (KRTX-1724).
  const pending = item.status === 'needs_you' || item.status === 'waiting';
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
  resolvers = null,
}: {
  details: ApprovalLinkDetails | null;
  previewAuthorized?: boolean;
  /** Who decides the call, for a viewer who may not (KRTX-1724). */
  resolvers?: ApprovalResolvers | null;
  busyDecision: ApprovalDecisionValue | null;
  onDecision?: (decision: ApprovalDecisionValue, note?: string) => void;
  onOpenSession?: () => void;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const waitingText = useApprovalWaitingText(resolvers);
  // The panel's own rule: a pending call with no decision on offer waits on
  // someone else, so the dialog is not announced as a request to this viewer.
  const waiting = details?.pending === true && !onDecision;
  return (
    <Modal open={details !== null} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="lg:h-auto lg:max-h-[85svh] lg:max-w-md">
        <ModalTitle className="sr-only">
          {waiting ? tI18nComplete.raw('textdb0e960b68b5') : tI18nComplete.raw('text1862f81ed9d6')}
        </ModalTitle>
        <ModalDescription className="sr-only">
          {waiting ? waitingText : tI18nComplete.raw('text32c6817c8380')}
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
              resolvers={resolvers}
              markOnMobile
            />
          </div>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

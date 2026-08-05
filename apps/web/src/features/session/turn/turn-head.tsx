'use client';

/**
 * The rows above a turn's assistant content: the worker-run report card, the
 * kortix_system indicator and the user message.
 *
 * Extracted verbatim from `SessionTurnImpl`'s render. It renders a fragment on
 * purpose — the caller owns the wrappers (`group/turn space-y-2.5` today, a
 * virtualized row tomorrow).
 *
 * `SessionReportCard` lives here, and `session-chat.tsx` re-exports it: it is
 * this file's only row that came from there, and importing it back out of
 * `session-chat` made the turn modules cyclic with the 4,200-line component
 * they were split out of.
 */

import { SubSessionModal } from '@/features/session/sub-session-modal';
import { cn } from '@/lib/utils';
import type { KortixSystemMessage, SessionReport } from '@/lib/utils/kortix-system-tags';
import {
  WarningIcon as AlertTriangle,
  CheckCircleIcon as CheckCircle,
  ArrowSquareOutIcon as ExternalLink,
} from '@phosphor-icons/react';
import type { SessionTurnProps } from '../session-chat';
import type { TurnModel } from './use-turn-model';
import { UserMessage } from './user-message';

// ============================================================================
// Session report card — the worker-run result row
// ============================================================================

/**
 * The worker-run result row shown above a turn — an entity row in the design
 * system's sense, not a tinted banner: the surface stays neutral and the status
 * lives in one tinted icon tile, so a run of these reads as a list rather than
 * a stack of coloured alerts.
 *
 * Extracted from the turn body so the row can be rendered (and looked at) on
 * its own, and so the turn's render reads as a list of sections rather than
 * forty lines of card markup inlined among them.
 */
export function SessionReportCard({
  report,
  onOpen,
}: {
  report: SessionReport;
  onOpen: () => void;
}) {
  const complete = report.status === 'COMPLETE';
  return (
    // A real <button>: Enter, Space and the focus ring come free, where the
    // previous role="button" div hand-rolled Enter only.
    <button
      type="button"
      onClick={onOpen}
      className="group/report bg-popover hover:bg-accent/40 flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors active:scale-[0.99]"
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          complete ? 'bg-kortix-green/15' : 'bg-kortix-red/15',
        )}
      >
        {complete ? (
          <CheckCircle className="text-kortix-green size-4" />
        ) : (
          <AlertTriangle className="text-kortix-red size-4" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">
          Worker {complete ? 'complete' : 'failed'}
        </span>
        {/* One meta line, truncated by CSS against the real available width —
            the old 60-character slice cut mid-word at every viewport and still
            overflowed narrow ones. */}
        {(report.project || report.prompt) && (
          <span className="text-muted-foreground block truncate text-xs">
            {report.project}
            {report.project && report.prompt && (
              <span className="text-muted-foreground/40"> &bull; </span>
            )}
            {report.prompt}
          </span>
        )}
      </span>

      <ExternalLink className="text-muted-foreground/40 group-hover/report:text-muted-foreground size-3.5 shrink-0 transition-colors" />
    </button>
  );
}

// ============================================================================
// System message indicator — subtle inline pill for kortix_system messages
// ============================================================================

function SystemMessageIndicator({ messages }: { messages: KortixSystemMessage[] }) {
  if (messages.length === 0) return null;

  // Combine all messages into a single line: "Goal · iteration 3/50"
  const parts = messages.map((msg) => (msg.detail ? `${msg.label} · ${msg.detail}` : msg.label));
  const text = parts.join('  ·  ');

  return (
    <div className="-my-1 flex items-center gap-2">
      <div className="bg-border/30 h-px flex-1" />
      <span className="text-muted-foreground/30 text-xs whitespace-nowrap select-none">{text}</span>
      <div className="bg-border/30 h-px flex-1" />
    </div>
  );
}

export function TurnHead({ model, props }: { model: TurnModel; props: SessionTurnProps }) {
  const {
    sessionReport,
    sessionReportModalOpen,
    setSessionReportModalOpen,
    hasVisibleUserContent,
    systemMessages,
  } = model;
  const {
    turn,
    agentNames,
    commandMessages,
    commands,
    sessionId,
    isPlanAnchor,
    onRewind,
    rewindDisabled,
  } = props;

  return (
    // The old markup made these siblings of the segment list inside
    // `group/turn space-y-2.5`. Flattened into their own row they lose
    // that 10px rhythm unless it is restored here.
    <div className="space-y-2.5">
      {/* ── Session report card — clickable, opens worker session modal ── */}
      {sessionReport && (
        <>
          <SessionReportCard
            report={sessionReport}
            onOpen={() => setSessionReportModalOpen(true)}
          />
          <SubSessionModal
            open={sessionReportModalOpen}
            onOpenChange={setSessionReportModalOpen}
            sessionId={sessionReport.sessionId}
            title={`Worker${sessionReport.project ? ` · ${sessionReport.project}` : ''}`}
          />
        </>
      )}

      {/* ── System message indicator — shown for kortix_system-only messages ── */}
      {!hasVisibleUserContent && !sessionReport && systemMessages.length > 0 && (
        <SystemMessageIndicator messages={systemMessages} />
      )}

      {/* ── User message ── */}
      {/* Hide the user bubble when the user message has no visible content
			    (e.g. background task notification with only synthetic parts). */}
      {hasVisibleUserContent && (
        <div>
          <UserMessage
            message={turn.userMessage}
            agentNames={agentNames}
            commandInfo={commandMessages?.get(turn.userMessage.info.id)}
            commands={commands}
            sessionId={sessionId}
            ownsPlan={isPlanAnchor}
            onRewind={onRewind}
            rewindDisabled={rewindDisabled}
          />
        </div>
      )}
    </div>
  );
}

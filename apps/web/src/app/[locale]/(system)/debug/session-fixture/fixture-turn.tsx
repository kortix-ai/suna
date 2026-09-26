'use client';

/**
 * FixtureTurn — one turn of the COR-91 parity fixture, composed from the same
 * exported pieces and in the same order as `SessionTurnImpl` in
 * `features/session/session-chat.tsx`:
 *
 *   user message (+ queued / interrupted status) → segments (ActivityBurst,
 *   standalone ToolPartRenderer, prose) → response → busy slot (retry + busy
 *   indicator) → TurnErrorDisplay → action bar (copy + SessionTurnMeta).
 *   A compaction turn is the CompactionMarker / CompactionFailedRow alone.
 *
 * `SessionTurnImpl` is module-private, so this file re-states its branches
 * for the shapes the fixture carries. Not ported, because the fixture never
 * reaches them: shell mode, slash-command cards, session-report and
 * kortix_system cards, optimistic answer caches, TurnOutcomes, the connect-
 * provider dialog, and the 2.5 s status throttle (the status applies at once).
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Copy } from '@/features/icon/icons/copy';
import { SandboxUrlDetector } from '@/features/session/sandbox-url-detector';
import { SessionBusyIndicator } from '@/features/session/session-busy-indicator';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SessionTurnMeta } from '@/features/session/session-turn-meta';
import { sessionTurnDurationMs, sessionTurnEndedAt } from '@/features/session/session-turn-meta-rows';
import { ToolPartRenderer, TurnLiveContext } from '@/features/session/tool/tool-renderers';
import { ActivityBurst } from '@/features/session/turn/activity-burst';
import { CompactionFailedRow, CompactionMarker } from '@/features/session/turn/compaction-card';
import { compactionTurnInfo } from '@/features/session/turn/compaction-state';
import { isPlanWriteTool } from '@/features/session/turn/plan-anchor';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  type QueuedPromptState,
} from '@/features/session/turn/queued-prompt-bubbles';
import { ShowGroupRenderer } from '@/features/session/tool/show-group-renderer';
import { segmentTurn } from '@/features/session/turn/segment-turn';
import { ThrottledMarkdown } from '@/features/session/turn/throttled-markdown';
import { UserMessage } from '@/features/session/turn/user-message';
import { showTurnBusyIndicator } from '@/features/session/turn-busy-visibility';
import { cn } from '@/lib/utils';
import {
  type PermissionRequest,
  type QuestionRequest,
  type SessionStatus,
  type TextPart,
  type ToolPart,
  type Turn,
  collectTurnParts,
  findLastTextPart,
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  getTurnStatus,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
  unwrapError,
} from '@/ui';
import { groupShowSegments, isAbortError } from '@kortix/sdk';

const NOOP_PERMISSION_REPLY = async () => {};

/** `SessionTurnImpl`'s turn error: the message error, else a dismissed question's error. */
function turnErrorText(turn: Turn): string | undefined {
  const msgError = getTurnError(turn);
  if (msgError) return msgError;
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue;
      const tool = part as ToolPart;
      if (tool.tool === 'question' && tool.state.status === 'error' && 'error' in tool.state) {
        return tool.state.error.replace(/^Error:\s*/, '');
      }
    }
  }
  return undefined;
}

/** `deriveTurnErrorAbortState`: the first structured error's identity decides. */
function turnAbortState(turn: Turn): boolean {
  for (const msg of turn.assistantMessages) {
    const err = (msg.info as { error?: unknown }).error;
    if (err && typeof err === 'object') return isAbortError(err);
  }
  return false;
}

export interface FixtureTurnProps {
  turn: Turn;
  sessionId: string;
  sessionStatus: SessionStatus | undefined;
  sessionWorking: boolean;
  isWorkingTurn: boolean;
  queueState: QueuedPromptState | null;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  agentNames: string[];
}

export function FixtureTurn({
  turn,
  sessionId,
  sessionStatus,
  sessionWorking,
  isWorkingTurn,
  queueState,
  permissions,
  questions,
  agentNames,
}: FixtureTurnProps) {
  const [copied, setCopied] = useState(false);
  const allParts = useMemo(() => collectTurnParts(turn), [turn]);
  const hasSteps = useMemo(
    () =>
      allParts.some(({ part }) => {
        if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch') return true;
        if (isToolPart(part)) {
          if (isPlanWriteTool(part.tool) || part.tool === 'task' || part.tool === 'question') return false;
          return shouldShowToolPart(part);
        }
        return false;
      }),
    [allParts],
  );
  const hasReasoning = useMemo(
    () => allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim()),
    [allParts],
  );
  const working = isWorkingTurn && sessionWorking;
  const compactionInfo = useMemo(() => compactionTurnInfo(turn), [turn]);

  const activeAssistantMessage = useMemo(() => {
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as { time?: { completed?: number } }).time?.completed) return msg;
    }
    return turn.assistantMessages.at(-1);
  }, [turn.assistantMessages]);
  const streamingResponseRaw = useMemo(
    () =>
      activeAssistantMessage?.parts.reduce((text, p) => (isTextPart(p) ? text + (p.text ?? '') : text), '') ?? '',
    [activeAssistantMessage],
  );
  const responseRaw = findLastTextPart(allParts)?.text ?? '';
  const completedTextParts = useMemo(
    () =>
      allParts
        .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
        .filter((text): text is string => Boolean(text)),
    [allParts],
  );
  const response = working
    ? streamingResponseRaw || responseRaw
    : !hasSteps && completedTextParts.length > 0
      ? completedTextParts.join('\n\n')
      : responseRaw.trim();

  const retryInfo = useMemo(() => (isWorkingTurn ? getRetryInfo(sessionStatus) : undefined), [sessionStatus, isWorkingTurn]);
  const retryMessage = useMemo(
    () => (isWorkingTurn ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );
  // Web's retry countdown: recomputed every second while a retry frame is up.
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) return;
    const update = () => setSecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [retryInfo]);
  const retrySecondsLeft = retryInfo ? secondsLeft : 0;
  const costInfo = useMemo(() => (!working ? getTurnCost(allParts) : undefined), [allParts, working]);

  const turnError = turnErrorText(turn);
  const turnErrorIsAbort = turnAbortState(turn);
  const turnErrorDetails = useMemo(() => getTurnErrorDetails(turn), [turn]);

  // Answered questions ride into their burst; pending ones are dropped (the
  // composer's question prompt owns them).
  const pendingQuestionCallIds = useMemo(
    () => new Set(questions.flatMap((q) => (q.sessionID === sessionId && q.tool?.callID ? [q.tool.callID] : []))),
    [questions, sessionId],
  );
  const standaloneCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const permission of permissions) {
      if (permission.sessionID === sessionId && permission.tool?.callID) ids.add(permission.tool.callID);
    }
    return ids;
  }, [permissions, sessionId]);
  const segments = useMemo(() => {
    const parts: (typeof allParts)[number]['part'][] = [];
    for (const { part } of allParts) {
      if (isToolPart(part) && isPlanWriteTool(part.tool)) continue;
      if (isToolPart(part) && part.tool === 'question') {
        const answers = (part.state as { metadata?: { answers?: unknown[] } }).metadata?.answers;
        if (pendingQuestionCallIds.has(part.callID) || !answers?.length) continue;
      }
      parts.push(part);
    }
    return groupShowSegments(segmentTurn(parts, { standaloneCallIds }), { standaloneCallIds });
  }, [allParts, pendingQuestionCallIds, standaloneCallIds]);

  const hasAssistantContent = turn.assistantMessages.length > 0;
  const statusText = hasAssistantContent ? getTurnStatus(allParts) : '';

  if (compactionInfo.isCompaction) {
    const running = working || compactionInfo.inFlight;
    if (running || response || compactionInfo.hasContent) {
      return (
        <div className="group/turn">
          <CompactionMarker running={running} summary={response} />
        </div>
      );
    }
    const rawError = compactionInfo.error;
    return (
      <div className="group/turn">
        <CompactionFailedRow
          error={turnError ?? (rawError != null ? unwrapError(rawError) : undefined)}
          isAbort={turnErrorIsAbort || (typeof rawError === 'object' && rawError !== null && isAbortError(rawError))}
        />
      </div>
    );
  }

  const handleCopy = async () => {
    if (!response) return;
    await navigator.clipboard.writeText(response);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group/turn text-factor-[2] space-y-2.5">
      <div
        data-turn-queue-state={queueState ?? undefined}
        className={cn('duration-slow transition-opacity', queueState && QUEUED_BUBBLE_OPACITY_CLASS)}
      >
        <UserMessage
          message={turn.userMessage}
          agentNames={agentNames}
          sessionId={sessionId}
          ownsPlan={false}
          rewindDisabled
          // Main: queued and interrupted prompts show no status words; the bubble tone carries them.
        />
      </div>

      {(working || hasSteps || hasReasoning) && hasAssistantContent && (
        <TurnLiveContext.Provider value={working}>
          <div className="space-y-3">
            {segments.map((segment, index) => {
              if (segment.kind === 'burst') {
                return (
                  <ActivityBurst
                    key={`burst-${segment.parts[0]?.id ?? 'empty'}`}
                    parts={segment.parts}
                    sessionId={sessionId}
                    working={working}
                    isTrailing={index === segments.length - 1}
                    density="normal"
                  />
                );
              }
              if (segment.kind === 'show-group') {
                const visible = segment.parts.filter(shouldShowToolPart);
                if (visible.length === 0) return null;
                return visible.length === 1 ? (
                  <ToolPartRenderer key={visible[0].id} part={visible[0]} sessionId={sessionId} />
                ) : (
                  <ShowGroupRenderer key={visible[0].id} parts={visible} sessionId={sessionId} />
                );
              }
              if (segment.kind === 'standalone') {
                if (!shouldShowToolPart(segment.part)) return null;
                return (
                  <ToolPartRenderer
                    key={segment.part.id}
                    part={segment.part}
                    sessionId={sessionId}
                    permission={getPermissionForTool(permissions, segment.part.callID)}
                    onPermissionReply={NOOP_PERMISSION_REPLY}
                  />
                );
              }
              if (!hasSteps) return null;
              const text = (segment.part as TextPart).text?.trim();
              if (!text) return null;
              return (
                <div key={segment.part.id} className="min-w-0 text-sm">
                  <ThrottledMarkdown content={text} isStreaming={working} />
                </div>
              );
            })}
          </div>
        </TurnLiveContext.Provider>
      )}

      {working && !hasSteps && response && (
        <div className="min-w-0 text-sm">
          <ThrottledMarkdown content={response} isStreaming />
        </div>
      )}
      {!working && !hasSteps && response && (
        <div className="text-sm">
          <SandboxUrlDetector content={response} isStreaming={false} />
        </div>
      )}

      {showTurnBusyIndicator({ working, hasError: !!turnError, isRetrying: !!retryInfo }) && (
        <div className="space-y-2">
          {retryInfo && retryMessage && (
            <SessionRetryDisplay
              message={retryMessage}
              attempt={retryInfo.attempt}
              secondsLeft={retrySecondsLeft}
              details={retryInfo.details}
            />
          )}
          <SessionBusyIndicator
            sessionId={sessionId}
            statusText={statusText || undefined}
            retryLabel={retryInfo ? 'Waiting to retry' : undefined}
          />
        </div>
      )}

      {turnError && (
        <TurnErrorDisplay errorText={turnError} errorDetails={turnErrorDetails} isAbort={turnErrorIsAbort} />
      )}

      {!working && (
        <div className="duration-normal flex items-center gap-0.5 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
          {response ? (
            <Button variant="ghost" size="icon-sm" onClick={handleCopy} aria-label={copied ? 'Copied' : 'Copy'} className="hit-area-3">
              {copied ? (
                <CheckIcon className="text-muted-foreground size-[1.05rem]" />
              ) : (
                <Copy className="text-muted-foreground size-[1.05rem]" />
              )}
            </Button>
          ) : null}
          <SessionTurnMeta
            endedAt={sessionTurnEndedAt(turn)}
            durationMs={sessionTurnDurationMs(turn)}
            cost={costInfo}
            className="flex items-center justify-center"
          />
        </div>
      )}
    </div>
  );
}

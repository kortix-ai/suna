/**
 * SessionTurn — one user message and the assistant's answer to it.
 *
 * Composition only, in the order of apps/web `session-chat.tsx`
 * `SessionTurnImpl` (turn root `space-y-2.5`):
 *
 *   1. user message
 *   (Text shimmer: a running burst's "Working · N steps" always sweeps; any other
 *   segment sweeps only when it is the LAST one, and the inline content only when
 *   there is no segments block; see `LoopMotionContext`. While the working
 *   turn is off screen (`onScreen` false) nothing sweeps and the dot matrix holds.)
 *   2. segments (`space-y-3`) — bursts (`ActivityBurst`: thinking, tool rows,
 *      file chips), standalone tools (`ToolPartRenderer`: deliverables,
 *      sub-agents, calls with a pending permission), and prose between bursts
 *   3. inline content (text + answered questions in natural order), or the
 *      response of a text-only turn (plain, or in a slash-command card)
 *   4. busy slot (`space-y-2`) — `SessionRetryDisplay` + `SessionBusyIndicator`
 *   5. turn error — `TurnErrorDisplay` (an abort renders nothing)
 *   6. action bar — Copy + turn details, whenever the turn is not working
 *
 * A compaction turn is one `CompactionMarker` (running / landed) or one
 * `CompactionFailedRow` — no user message, no body (web `isCompaction`
 * branch). Only the WORKING turn (`resolveWorkingTurn`) reads the session
 * status, so only it can be working or show a retry.
 *
 * Which parts land in which section is decided by `lib/session/turn-body.ts`
 * and the SDK's `segmentTurn`. The rows live beside this file: turn/* and
 * tool/*.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import { LoopMotionContext } from '@/components/kortix/text-shimmer';
import { useColorScheme } from 'nativewind';
import type { AvatarPerson } from '@/lib/session/participants';
import {
  collectTurnParts,
  compactionTurnInfo,
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  getShellModePart,
  getTurnCost,
  getTurnErrorDetails,
  getWorkingState,
  segmentTurn,
  shouldShowToolPart,
  type Part as SdkPart,
  type ToolPart as SdkToolPart,
} from '@kortix/sdk';
import type {
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  Turn,
} from '@/lib/session/types';
import type { Command } from '@/lib/session/runtime-data';
import { detectCommandFromText } from '@/lib/session/detect-command';
import {
  answeredQuestionParts as selectAnsweredQuestionParts,
  busyStatusParts,
  commandPromptText,
  compactionTurnView,
  inlineContentItems,
  lastTextPartId,
  segmentInputParts,
  showTurnActions,
  showTurnBusyIndicator,
  standaloneCallIdsFor,
  toDisplayPath,
  turnErrorIsAbort,
  turnErrorText,
  turnHasSteps,
  turnResponse,
  withoutReasoning,
  type TurnBodyTurn,
} from '@/lib/session/turn-body';
import { BUSY_RETRY_LABEL } from '@/lib/session/busy-status';
import { webSpace, type MessageAttachment, type QueuedPromptState } from '@/lib/session/user-message';
import { SessionBusyIndicator, useTurnBusyStatus } from './session-busy-indicator';
import { SessionRetryDisplay, useRetrySecondsLeft } from './session-retry-display';
import { TurnErrorDisplay } from './SessionErrorBanner';
import { TurnLiveContext } from './tool/shared/infrastructure';
import { ToolPartRenderer, type PermissionReply } from './tool/tool-part-renderer';
import './tool/tools/register';
import { ActivityBurst } from './turn/activity-burst';
import { CommandOutputCard } from './turn/command-output';
import { CompactionFailedRow, CompactionMarker } from './turn/compaction-divider';
import { TextPartBlock } from './turn/text-part';
import { TurnActions } from './turn/turn-actions';
import { UserMessage, type SessionSourceAuthor, type UserMessageUploadStatus } from './turn/user-message';

/** Web turn root `space-y-2.5`. */
const TURN_STACK_GAP = webSpace(2.5);
/** Web segment / inline stacks `space-y-3`. */
const SEGMENT_STACK_GAP = webSpace(3);
/** Web busy slot / answered-question list `space-y-2`. */
const SMALL_STACK_GAP = webSpace(2);

/** One stable reference for every burst (`ActivityBurst` memo compares it). */
const displayPath = (path: string) => toDisplayPath(path);

// ─── SessionTurn ─────────────────────────────────────────────────────────────

interface SessionTurnProps {
  turn: Turn;
  /**
   * True for the session's working turn (`resolveWorkingTurn`). Only it can be
   * working, and only it reads the retry frame (web `isWorkingTurn`).
   */
  isWorkingTurn: boolean;
  /** Only the working turn receives these; other turns get stable defaults. */
  sessionStatus?: SessionStatus;
  isBusy: boolean;
  /**
   * The working turn's answer is complete while prompts wait below it: draw no
   * busy row here (web `suppressBusyIndicator`); the transcript draws it.
   */
  suppressBusyIndicator?: boolean;
  /** The session the turn belongs to — tool rows read its permissions. */
  sessionId?: string;
  /** Pending permissions of the session (one stable store array). */
  permissions?: PermissionRequest[];
  pendingQuestions?: QuestionRequest[];
  agentNames?: string[];
  onFileMention?: (path: string) => void;
  onSessionMention?: (sessionId: string) => void;
  /** Answers a permission prompt under a tool row. Must be stable. */
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
  commands?: Command[];
  /** User-message edit + queue state — see `UserMessage` in ./turn/user-message. */
  editingText?: string | null;
  editPending?: boolean;
  onEditStart?: (messageId: string, text: string) => void;
  onEditCancel?: () => void;
  onEditSend?: (messageId: string, text: string, kept: MessageAttachment[]) => void;
  rewindDisabled?: boolean;
  queueState?: QueuedPromptState | null;
  uploadStatus?: UserMessageUploadStatus;
  /** Who sent this turn's prompt. Set only in a session with two or more people. */
  sender?: AvatarPerson | null;
  /** Another Kortix session sent this prompt — see `UserMessage`. */
  sessionAuthor?: SessionSourceAuthor | null;
  /**
   * False while the working turn is scrolled out of the list's viewport: its
   * shimmer and busy dot matrix hold still (KRTX-1638). Defaults to on screen.
   */
  onScreen?: boolean;
}

const EMPTY_QUESTIONS: QuestionRequest[] = Object.freeze([]) as unknown as QuestionRequest[];
const EMPTY_PERMISSIONS: PermissionRequest[] = Object.freeze([]) as unknown as PermissionRequest[];

function SessionTurnImpl({
  turn,
  isWorkingTurn,
  sessionStatus,
  isBusy,
  suppressBusyIndicator = false,
  sessionId,
  permissions = EMPTY_PERMISSIONS,
  pendingQuestions = EMPTY_QUESTIONS,
  agentNames,
  onFileMention,
  onSessionMention,
  onPermissionReply,
  commands,
  editingText,
  editPending,
  onEditStart,
  onEditCancel,
  onEditSend,
  rewindDisabled,
  queueState,
  uploadStatus,
  sender,
  sessionAuthor,
  onScreen = true,
}: SessionTurnProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const bodyTurn = turn as unknown as TurnBodyTurn;

  // Mobile's wire types are a local copy of the SDK's; the turn rules take SDK parts.
  const rawParts = useMemo(() => collectTurnParts(turn) as unknown as ReadonlyArray<{ part: SdkPart }>, [turn]);
  const allParts = useMemo(() => withoutReasoning(rawParts), [rawParts]);
  const busyParts = useMemo(() => busyStatusParts(rawParts), [rawParts]);

  // Web: `working = isWorkingTurn && sessionWorking`. Any other turn is never working.
  const working = useMemo(
    () => isWorkingTurn && (getWorkingState(sessionStatus, true) || isBusy),
    [sessionStatus, isWorkingTurn, isBusy],
  );

  const hasSteps = useMemo(() => turnHasSteps(allParts), [allParts]);
  const hasAssistantContent = turn.assistantMessages.length > 0;

  const response = useMemo(
    () => turnResponse({ turn: bodyTurn, allParts, working, hasSteps }),
    [bodyTurn, allParts, working, hasSteps],
  );

  // ── Answered questions ──
  const answeredQuestions = useMemo(() => {
    const pendingCallIds = new Set<string>();
    for (const question of pendingQuestions) {
      if (question.tool?.callID && (!sessionId || question.sessionID === sessionId)) {
        pendingCallIds.add(question.tool.callID);
      }
    }
    return selectAnsweredQuestionParts(bodyTurn, pendingCallIds);
  }, [bodyTurn, pendingQuestions, sessionId]);
  const answeredById = useMemo(
    () => new Map(answeredQuestions.map((part) => [part.id, part])),
    [answeredQuestions],
  );
  const inlineItems = useMemo(() => inlineContentItems(allParts, answeredById), [allParts, answeredById]);
  const showInlineContent = !hasSteps && !!inlineItems;

  // ── Segments ──
  // Pending permissions and connector calls that ask the user to connect or
  // approve (COR-158) render as their own transcript rows, not in a burst.
  const standaloneCallIds = useMemo(
    () => standaloneCallIdsFor(permissions, sessionId, allParts),
    [permissions, sessionId, allParts],
  );
  const segments = useMemo(
    () => segmentTurn(segmentInputParts(allParts, answeredById, showInlineContent), { standaloneCallIds }),
    [allParts, answeredById, showInlineContent, standaloneCallIds],
  );
  const streamingTextId = useMemo(() => (working ? lastTextPartId(segments) : undefined), [working, segments]);

  // ── Errors, retry, status ──
  const turnError = useMemo(() => turnErrorText(bodyTurn), [bodyTurn]);
  const errorIsAbort = useMemo(() => turnErrorIsAbort(bodyTurn), [bodyTurn]);
  const errorDetails = useMemo(() => getTurnErrorDetails(turn as never), [turn]);
  // The retry frame belongs to the WORKING turn (web session-chat.tsx).
  const retryInfo = useMemo(
    () => (isWorkingTurn ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );
  const retryMessage = useMemo(
    () => (isWorkingTurn ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );
  const retrySecondsLeft = useRetrySecondsLeft(retryInfo);
  // Throttled status + stall clock; "Thinking" until the turn has an assistant message.
  const { statusText, elapsedLabel } = useTurnBusyStatus({ allParts: busyParts, working, hasAssistantContent });

  // ── Compaction ──
  const compactionInfo = useMemo(() => compactionTurnInfo(turn as never), [turn]);

  const costInfo = useMemo(() => (working ? undefined : getTurnCost(allParts as never)), [working, allParts]);

  // ── Slash command ──
  const commandForTurn = useMemo(() => {
    const prompt = commandPromptText(turn.userMessage.parts as never);
    return prompt ? detectCommandFromText(prompt, commands) : undefined;
  }, [turn.userMessage.parts, commands]);

  /** Copy writes every inline text part when the inline content renders. */
  const copyText = useMemo(() => {
    if (!inlineItems) return response;
    return inlineItems
      .flatMap((item) => (item.type === 'text' && item.part.text?.trim() ? [item.part.text.trim()] : []))
      .join('\n\n');
  }, [inlineItems, response]);

  // A long run whose prompt is not loaded has a stand-in prompt with no parts:
  // render its replies without a prompt bubble.
  const userMessage = turn.partial ? null : (
    <UserMessage
      turn={turn}
      isDark={isDark}
      agentNames={agentNames}
      onFileMention={onFileMention}
      onSessionMention={onSessionMention}
      commands={commands}
      editingText={editingText}
      editPending={editPending}
      onEditStart={onEditStart}
      onEditCancel={onEditCancel}
      onEditSend={onEditSend}
      rewindDisabled={rewindDisabled}
      queueState={queueState}
      uploadStatus={uploadStatus}
      sender={sender}
      sessionAuthor={sessionAuthor}
    />
  );

  // ── Shell mode: the one shell call is the whole answer ──
  const shellModePart = useMemo(() => getShellModePart(turn as never) as SdkToolPart | undefined, [turn]);
  if (shellModePart) {
    return (
      <View style={{ gap: TURN_STACK_GAP }}>
        {userMessage}
        <TurnLiveContext.Provider value={working}>
          <View className="px-4" style={{ gap: webSpace(1) }}>
            <ToolPartRenderer
              part={shellModePart}
              sessionId={sessionId}
              permission={getPermissionForTool(permissions, shellModePart.callID)}
              onPermissionReply={onPermissionReply}
              defaultOpen
            />
            {turnError ? (
              <TurnErrorDisplay
                errorText={turnError}
                errorDetails={errorDetails}
                isAbort={errorIsAbort}
                style={{ marginTop: webSpace(2) }}
              />
            ) : null}
          </View>
        </TurnLiveContext.Provider>
      </View>
    );
  }

  // ── Compaction: the marker, or the failed row, IS the whole turn ──
  if (compactionInfo.isCompaction) {
    const view = compactionTurnView({
      working,
      info: compactionInfo,
      response,
      turnError,
      turnErrorIsAbort: errorIsAbort,
    });
    return (
      <View className="px-4">
        {view.kind === 'marker' ? (
          // Mobile has no side panel, so the summary expands inline.
          <CompactionMarker running={view.running} summary={response} />
        ) : (
          <CompactionFailedRow error={view.error} isAbort={view.isAbort} />
        )}
      </View>
    );
  }

  const body: React.ReactNode[] = [];

  // 2. Segments
  if ((working || hasSteps) && hasAssistantContent && segments.length > 0) {
    body.push(
      <TurnLiveContext.Provider key="segments" value={working}>
        <View style={{ gap: SEGMENT_STACK_GAP }}>
          {segments.map((segment, index) => {
            // Trailing is structural (`burstIsRunning` keeps the trailing burst
            // running between calls); only loop motion follows the viewport.
            // A running burst's "Working · N steps" always sweeps on screen
            // (Jay); any other segment sweeps only when it is the trailing one.
            const trailing = index === segments.length - 1;
            const shimmerSegment = onScreen && trailing;
            if (segment.kind === 'burst') {
              return (
                <LoopMotionContext.Provider key={`burst-${segment.parts[0]?.id ?? 'empty'}`} value={onScreen}>
                  <ActivityBurst
                    segment={segment}
                    turnLive={working}
                    isTrailing={trailing}
                    sessionId={sessionId}
                    onOpenFile={onFileMention}
                    toDisplayPath={displayPath}
                    onPermissionReply={onPermissionReply}
                  />
                </LoopMotionContext.Provider>
              );
            }
            if (segment.kind === 'standalone') {
              if (!shouldShowToolPart(segment.part)) return null;
              return (
                <LoopMotionContext.Provider key={segment.part.id} value={shimmerSegment}>
                  <ToolPartRenderer
                    part={segment.part}
                    sessionId={sessionId}
                    permission={getPermissionForTool(permissions, segment.part.callID)}
                    onPermissionReply={onPermissionReply}
                  />
                </LoopMotionContext.Provider>
              );
            }
            // A text-only turn renders its response below instead.
            if (!hasSteps) return null;
            const text = segment.part.text?.trim();
            if (!text) return null;
            return (
              <TextPartBlock
                key={segment.part.id}
                text={text}
                isDark={isDark}
                isStreaming={segment.part.id === streamingTextId}
              />
            );
          })}
        </View>
      </TurnLiveContext.Provider>,
    );
  }

  // 3. Response / inline content
  // The streaming reply and the finished reply share the key "response" and
  // the same element tree, so the reply keeps its views when the turn ends
  // instead of remounting (a re-parse, re-highlight and image reload). A
  // slash-command reply streams in its card with the chrome off.
  if (working && !hasSteps && !showInlineContent && response) {
    body.push(
      commandForTurn ? (
        <CommandOutputCard key="response" name={commandForTurn.name} chrome={false}>
          <TextPartBlock text={response} isDark={isDark} isStreaming />
        </CommandOutputCard>
      ) : (
        <TextPartBlock key="response" text={response} isDark={isDark} isStreaming />
      ),
    );
  }
  if (showInlineContent && inlineItems) {
    let lastTextIndex = -1;
    if (working) {
      for (let i = inlineItems.length - 1; i >= 0; i--) {
        if (inlineItems[i].type === 'text') {
          lastTextIndex = i;
          break;
        }
      }
    }
    // Inline tools sweep only when no segments block already owns the turn's shimmer.
    const inlineShimmer = onScreen && body.length === 0;
    body.push(
      <LoopMotionContext.Provider key="inline" value={inlineShimmer}>
        <View style={{ gap: SEGMENT_STACK_GAP }}>
          {inlineItems.map((item, index) => {
            if (item.type === 'text') {
              const streaming = index === lastTextIndex;
              const text = streaming ? item.part.text ?? '' : (item.part.text ?? '').trim();
              return <TextPartBlock key={item.id} text={text} isDark={isDark} isStreaming={streaming} />;
            }
            return <ToolPartRenderer key={item.id} part={item.part} sessionId={sessionId} turnLive={working} />;
          })}
        </View>
      </LoopMotionContext.Provider>,
    );
  } else {
    if (!working && !hasSteps && response) {
      body.push(
        commandForTurn ? (
          <CommandOutputCard key="response" name={commandForTurn.name}>
            <TextPartBlock text={response} isDark={isDark} />
          </CommandOutputCard>
        ) : (
          <TextPartBlock key="response" text={response} isDark={isDark} />
        ),
      );
    }
    if (!hasSteps && !working && answeredQuestions.length > 0) {
      body.push(
        <View key="answered" style={{ marginTop: SEGMENT_STACK_GAP, gap: SMALL_STACK_GAP }}>
          {answeredQuestions.map((part) => (
            <ToolPartRenderer key={part.id} part={part} sessionId={sessionId} turnLive={false} />
          ))}
        </View>,
      );
    }
  }

  // 4. Busy slot — retry display, then the working indicator
  if (
    showTurnBusyIndicator({
      working: working && !suppressBusyIndicator,
      hasError: !!turnError,
      isRetrying: !!retryInfo,
    })
  ) {
    body.push(
      <View key="busy" style={{ gap: SMALL_STACK_GAP }}>
        {retryInfo && retryMessage ? (
          <SessionRetryDisplay
            message={retryMessage}
            attempt={retryInfo.attempt}
            secondsLeft={retrySecondsLeft}
            details={retryInfo.details}
          />
        ) : null}
        <LoopMotionContext.Provider value={onScreen}>
          <SessionBusyIndicator
            sessionId={sessionId}
            statusText={statusText}
            elapsedLabel={elapsedLabel}
            retryLabel={retryInfo ? BUSY_RETRY_LABEL : undefined}
          />
        </LoopMotionContext.Provider>
      </View>,
    );
  }

  // 5. Error — not gated on `working`, as on web; an abort renders nothing
  if (turnError) {
    body.push(
      <TurnErrorDisplay key="error" errorText={turnError} errorDetails={errorDetails} isAbort={errorIsAbort} />,
    );
  }

  // 6. Action bar
  if (showTurnActions({ working })) {
    body.push(<TurnActions key="actions" turn={turn} response={copyText} costInfo={costInfo} />);
  }

  return (
    <View style={{ gap: TURN_STACK_GAP }}>
      {userMessage}
      {body.length > 0 ? (
        <View className="px-4" style={{ gap: TURN_STACK_GAP }}>
          {body}
        </View>
      ) : null}
    </View>
  );
}

export const SessionTurn = React.memo(SessionTurnImpl);

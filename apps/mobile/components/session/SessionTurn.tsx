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
 *      sub-agents, calls with a pending permission), and the reply text — for
 *      the whole stream, so the first tool call never remounts it (KRTX-1678)
 *      Settled, the work folds behind one "Worked for" row (`WorkRow`,
 *      KRTX-2113) that opens the activity sheet; the deliverables and the
 *      final text stay below it.
 *   3. inline content (text + answered questions in natural order), or a
 *      slash-command reply in its card
 *   4. busy slot (`space-y-2`) — `SessionRetryDisplay` + `SessionBusyIndicator`
 *   5. turn error — `TurnErrorDisplay` (an abort renders nothing), then
 *      "Stopped by {name}" when another member stopped the turn
 *   6. change requests the turn opened — `SessionChangeRequests`, when not working
 *   7. action bar — Copy + turn details, whenever the turn is not working
 *
 * A compaction turn is one `CompactionMarker` (running / landed) or one
 * `CompactionFailedRow` — no user message, no body (web `isCompaction`
 * branch). Only the live turn (`SessionLogTurn.live`) reads the session
 * status, so only it can be working or show a retry.
 *
 * The turn is the SDK's block turn (`sessionLogTurns`). Which blocks land in
 * which section is decided by `lib/session/turn-body.ts` and the SDK's
 * `sessionLogTurnSegments`. The rows live beside this file: turn/* and tool/*.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { LoopMotionContext } from '@/components/kortix/text-shimmer';
import { useColorScheme } from 'nativewind';
import type { AvatarPerson } from '@/lib/session/participants';
import {
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  shouldShowToolPart,
  type SessionLogTurn,
} from '@kortix/sdk';
import type { PermissionRequest, QuestionRequest, SessionStatus } from '@/lib/session/types';
import type { Command } from '@/lib/session/runtime-data';
import { detectCommandFromText } from '@/lib/session/detect-command';
import {
  answeredQuestionCalls,
  commandPromptText,
  compactionTurnView,
  inlineContentItems,
  isOpenTextBlock,
  liveTextBlockId,
  segmentInputBlocks,
  showTurnActions,
  showTurnBusyIndicator,
  standaloneCallIdsFor,
  toDisplayPath,
  turnBlocks,
  turnErrorIsAbort,
  turnErrorText,
  turnHasSteps,
  turnBodyLayout,
  turnResponse,
  textBlockRevealKey,
  turnSegments,
  turnWorkSplit,
  type TurnSegment,
} from '@/lib/session/turn-body';
import { turnDurationMs } from '@/lib/session/turn-meta';
import type { ChangeItem } from '@/lib/session/session-change-requests';
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
import { TurnStoppedBy } from './turn/turn-stopped-by';
import { SessionChangeRequests } from './SessionChangeRequests';
import { UserMessage, type SessionSourceAuthor, type UserMessageUploadStatus } from './turn/user-message';
import { WorkRow } from './turn/work-row';

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
  /**
   * The SDK's block turn. `turn.live` marks the session's working turn: only
   * it can be working, and only it reads the retry frame (web `isWorkingTurn`).
   */
  turn: SessionLogTurn;
  /** Only the live turn receives it; other turns get a stable default. */
  sessionStatus?: SessionStatus;
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
  /** The member who stopped this turn, when not the viewer (`turnStoppedBy`). */
  stoppedBy?: string | null;
  /**
   * False while the working turn is scrolled out of the list's viewport: its
   * shimmer and busy dot matrix hold still (KRTX-1638). Defaults to on screen.
   */
  onScreen?: boolean;
  /** The change requests this turn opened (`anchorChangeRequests`). One stable array per turn. */
  changeRequests?: readonly ChangeItem[];
  /** Opens the review sheet for one change request. Must be stable. */
  onOpenChangeRequest?: (id: string) => void;
}

const EMPTY_QUESTIONS: QuestionRequest[] = Object.freeze([]) as unknown as QuestionRequest[];
const EMPTY_PERMISSIONS: PermissionRequest[] = Object.freeze([]) as unknown as PermissionRequest[];

function SessionTurnImpl({
  turn,
  sessionStatus,
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
  stoppedBy,
  onScreen = true,
  changeRequests,
  onOpenChangeRequest,
}: SessionTurnProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // Every reply block but reasoning, each call in its open shape.
  const blocks = turnBlocks(turn);

  // Web: `working = isWorkingTurn && sessionWorking`: the SDK's `live`. Any other turn is never working.
  const working = turn.live;

  const hasSteps = useMemo(() => turnHasSteps(blocks), [blocks]);
  const hasAssistantContent = turn.assistant.length > 0;

  const response = useMemo(
    () => turnResponse({ turn, blocks, working, hasSteps }),
    [turn, blocks, working, hasSteps],
  );

  // ── Answered questions ──
  const answeredQuestions = useMemo(() => {
    const pendingCallIds = new Set<string>();
    for (const question of pendingQuestions) {
      if (question.tool?.callID && (!sessionId || question.sessionID === sessionId)) {
        pendingCallIds.add(question.tool.callID);
      }
    }
    return answeredQuestionCalls(turn.assistant, pendingCallIds);
  }, [turn.assistant, pendingQuestions, sessionId]);
  const answeredById = useMemo(
    () => new Map(answeredQuestions.map((call) => [call.id, call])),
    [answeredQuestions],
  );
  const inlineItems = useMemo(() => inlineContentItems(blocks, answeredById), [blocks, answeredById]);
  const showInlineContent = !hasSteps && !!inlineItems;

  // ── Segments ──
  // Pending permissions and connector calls that ask the user to connect or
  // approve (COR-158) render as their own transcript rows, not in a burst.
  const standaloneCallIds = useMemo(
    () => standaloneCallIdsFor(permissions, sessionId, blocks),
    [permissions, sessionId, blocks],
  );
  const segments = useMemo(
    () => turnSegments(segmentInputBlocks(blocks, answeredById, showInlineContent), standaloneCallIds),
    [blocks, answeredById, showInlineContent, standaloneCallIds],
  );
  // KRTX-2933: only the part that can still grow streams. A reply that ended
  // while the session still reads busy renders at once.
  const streamingTextId = useMemo(
    () => (working ? liveTextBlockId(turn.assistant, segments) : undefined),
    [working, turn.assistant, segments],
  );
  // KRTX-2113: settled, the work folds behind one "Worked for" row; `null` while working.
  const workSplit = useMemo(() => turnWorkSplit(segments, working), [segments, working]);
  const durationMs = useMemo(() => (workSplit ? turnDurationMs(turn) : null), [workSplit, turn]);
  // The opened "Worked for" row. Closed on every mount: a history turn paints folded.
  const [workOpen, setWorkOpen] = useState(false);
  const toggleWork = useCallback(() => setWorkOpen((open) => !open), []);

  // ── Errors, retry, status ──
  const turnError = useMemo(() => turnErrorText(turn), [turn]);
  const errorIsAbort = useMemo(() => turnErrorIsAbort(turn), [turn]);
  const errorDetails = turn.error?.details;
  // The retry frame belongs to the WORKING turn (web session-chat.tsx).
  const retryInfo = useMemo(
    () => (working ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, working],
  );
  const retryMessage = useMemo(
    () => (working ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, working],
  );
  const retrySecondsLeft = useRetrySecondsLeft(retryInfo);
  // Throttled status + stall clock; "Thinking" until the turn has an assistant message.
  const { statusText, elapsedLabel } = useTurnBusyStatus({ blocks: turn.blocks, working, hasAssistantContent });

  const costInfo = working ? undefined : (turn.cost ?? undefined);

  // ── Slash command ──
  const commandForTurn = useMemo(() => {
    const prompt = commandPromptText(turn.user.blocks);
    return prompt ? detectCommandFromText(prompt, commands) : undefined;
  }, [turn.user.blocks, commands]);

  /** Copy writes every inline text part when the inline content renders. */
  const copyText = useMemo(() => {
    if (!inlineItems) return response;
    return inlineItems
      .flatMap((item) => (item.type === 'text' && item.block.text.trim() ? [item.block.text.trim()] : []))
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
  const shellCall = turn.shell;
  if (shellCall) {
    return (
      <View style={{ gap: TURN_STACK_GAP }}>
        {userMessage}
        <TurnLiveContext.Provider value={working}>
          <View className="px-4" style={{ gap: webSpace(1) }}>
            <ToolPartRenderer
              call={shellCall}
              sessionId={sessionId}
              permission={getPermissionForTool(permissions, shellCall.call_id)}
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
            {!working && stoppedBy ? <TurnStoppedBy name={stoppedBy} /> : null}
          </View>
        </TurnLiveContext.Provider>
      </View>
    );
  }

  // ── Compaction: the marker, or the failed row, IS the whole turn ──
  if (turn.compaction) {
    // The summary is folded onto the marker: a reply text, else the compaction block's own summary.
    const summary = response || turn.compaction.block?.summary || '';
    const view = compactionTurnView({
      working,
      compaction: turn.compaction,
      response: summary,
      turnError,
      turnErrorIsAbort: errorIsAbort,
    });
    return (
      <View className="px-4">
        {view.kind === 'marker' ? (
          // Mobile has no side panel, so the summary expands inline.
          <CompactionMarker running={view.running} summary={summary} />
        ) : (
          <CompactionFailedRow error={view.error} isAbort={view.isAbort} />
        )}
      </View>
    );
  }

  const body: React.ReactNode[] = [];
  const layout = turnBodyLayout({
    working,
    hasSteps,
    hasAssistantContent,
    showInlineContent,
    isCommand: !!commandForTurn && commandForTurn.source !== 'skill',
  });

  // 2. Segments
  if (layout.segments && segments.length > 0) {
    const renderSegment = (segment: TurnSegment, inFold = false) => {
      // Trailing is structural (`burstIsRunning` keeps the trailing burst
      // running between calls); only loop motion follows the viewport.
      // A running burst's "Working · N steps" always sweeps on screen
      // (Jay); any other segment sweeps only when it is the trailing one.
      const trailing = segment === segments[segments.length - 1];
      const shimmerSegment = onScreen && trailing;
      if (segment.kind === 'burst') {
        return (
          <LoopMotionContext.Provider key={`burst-${segment.blocks[0]?.id ?? 'empty'}`} value={onScreen}>
            <ActivityBurst
              segment={segment}
              turnLive={working}
              isTrailing={trailing}
              sessionId={sessionId}
              onOpenFile={onFileMention}
              toDisplayPath={displayPath}
              onPermissionReply={onPermissionReply}
              inFold={inFold}
            />
          </LoopMotionContext.Provider>
        );
      }
      if (segment.kind === 'standalone') {
        if (!shouldShowToolPart(segment.block)) return null;
        return (
          <LoopMotionContext.Provider key={segment.block.id} value={shimmerSegment}>
            <ToolPartRenderer
              call={segment.block}
              sessionId={sessionId}
              permission={getPermissionForTool(permissions, segment.block.call_id)}
              onPermissionReply={onPermissionReply}
            />
          </LoopMotionContext.Provider>
        );
      }
      // Text renders here for the whole stream (`turnBodyLayout`).
      if (layout.text !== 'segments') return null;
      const text = segment.block.text.trim();
      if (!text) return null;
      return (
        <TextPartBlock
          key={segment.block.id}
          text={text}
          isDark={isDark}
          isStreaming={segment.block.id === streamingTextId}
          revealKey={textBlockRevealKey(turn.assistant, segment.block.id)}
        />
      );
    };
    // Settled with work (KRTX-2113): the row, the work while the row is open,
    // then the hoisted deliverables, then the final text. They stay keyed
    // siblings in this one list, so the final text and the cards keep their
    // instances at settle and on every toggle. The inline and command layouts
    // keep today's render.
    const split = layout.text === 'segments' ? workSplit : null;
    body.push(
      <TurnLiveContext.Provider key="segments" value={working}>
        <View style={{ gap: SEGMENT_STACK_GAP }}>
          {split
            ? [
                <WorkRow key="work" durationMs={durationMs} open={workOpen} onToggle={toggleWork} />,
                ...(workOpen ? split.work.map((segment) => renderSegment(segment, true)) : []),
                ...split.hoisted.map((segment) => renderSegment(segment)),
                ...split.final.map((segment) => renderSegment(segment)),
              ]
            : segments.map((segment) => renderSegment(segment))}
        </View>
      </TurnLiveContext.Provider>,
    );
  }

  // 3. Response / inline content
  // A slash-command reply streams in its card with the chrome off. The
  // streaming and the finished card share the key "response", so the reply
  // keeps its views when the turn ends instead of remounting.
  // A pi skill answers like any chat turn: no command card.
  if (layout.text === 'response' && commandForTurn && commandForTurn.source !== 'skill' && response) {
    body.push(
      <CommandOutputCard key="response" name={commandForTurn.name} chrome={!working}>
        <TextPartBlock text={response} isDark={isDark} isStreaming={working} revealKey={`${turn.id}:response`} />
      </CommandOutputCard>,
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
              const streaming = index === lastTextIndex && isOpenTextBlock(turn.assistant, item.block.id);
              const text = streaming ? item.block.text : item.block.text.trim();
              return (
                <TextPartBlock
                  key={item.id}
                  text={text}
                  isDark={isDark}
                  isStreaming={streaming}
                  revealKey={textBlockRevealKey(turn.assistant, item.block.id)}
                />
              );
            }
            return <ToolPartRenderer key={item.id} call={item.call} sessionId={sessionId} turnLive={working} />;
          })}
        </View>
      </LoopMotionContext.Provider>,
    );
  } else {
    if (!hasSteps && !working && answeredQuestions.length > 0) {
      body.push(
        <View key="answered" style={{ marginTop: SEGMENT_STACK_GAP, gap: SMALL_STACK_GAP }}>
          {answeredQuestions.map((call) => (
            <ToolPartRenderer key={call.id} call={call} sessionId={sessionId} turnLive={false} />
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
  // Who stopped the turn, once it has ended. The viewer's own stop is silent.
  if (!working && stoppedBy) {
    body.push(<TurnStoppedBy key="stopped-by" name={stoppedBy} />);
  }

  // 6. Change requests — what this turn left behind (web `TurnOutcomes`).
  // Gated on `!working` as on web: an outcome is a settled fact.
  if (!working && changeRequests && changeRequests.length > 0 && onOpenChangeRequest) {
    body.push(<SessionChangeRequests key="change-requests" items={changeRequests} onOpen={onOpenChangeRequest} />);
  }

  // 7. Action bar
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

'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import type { Command, Session } from '@/hooks/runtime/use-runtime-sessions';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type { MessageWithParts, QuestionAnswer, Turn } from '@/ui';
import type { AcpChatItem } from '@kortix/sdk';
import type { useSession } from '@kortix/sdk/react';
import { AlertTriangle, ArrowDown, MessageCircle } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AcpChatItemRow } from './acp-chat-item-row';
import { AcpConfigOptionPill, AcpConfigOptionSegment } from './acp-config-option-pills';
import {
  acpTodosFromPlanEntries,
  buildAcpQuestionContent,
  findAcpModelConfigOption,
  otherAcpConfigOptions,
  toQuestionRequest,
} from './acp-composer-adapters';
import { AcpSessionPermissionPrompt } from './acp-session-permission-prompt';
import {
  AcpGroupedReasoningCard,
  AcpSameToolGroup,
  AcpUnknownMethodCard,
} from './acp-transcript-groups';
import {
  acpOrdinalTimestamps,
  acpTurnDurationMs,
  formatAcpContextLabel,
  formatAcpDuration,
  formatAcpSessionCostLabel,
  groupAcpTurnItems,
  groupAcpTurns,
  splitAcpTurn,
  wrapAcpReplyContext,
  type AcpMessageItem,
} from './acp-turn-grouping';
import { ChatMinimap } from './chat-minimap';
import { ComposerChatInput } from './composer-chat-input';
import { SessionSiteHeader } from './header/session-site-header';
import { QuestionPrompt, type QuestionAction, type QuestionPromptHandle } from './question-prompt';
import { isPendingAction, useSessionAudit } from './session-audit-shared';
import { type AttachedFile } from './session-chat-input';
import { SessionContextModal } from './session-context-modal';

const EMPTY_CONVERSATION_COPY = 'Start a conversation with the selected native harness.';

/** Per-turn footer data (`turnFooters`, below) — the turn's duration, the
 *  assistant message the `CopyButton` copies, and (last turn only) the
 *  running session totals: cumulative cost and current context size. The
 *  session totals live HERE, on the transcript's own footer line, rather
 *  than as a detached meta row floating above the composer — one line, one
 *  place, dot-separated via `InlineMeta`. */
interface AcpTurnFooter {
  durationMs: number | null;
  costLabel: string | null;
  contextLabel: string | null;
  lastAssistantText: AcpMessageItem | null;
}

interface QueuedAcpMessage {
  id: string;
  text: string;
  files: AttachedFile[];
}

interface ReplyToContext {
  text: string;
}

export function AcpSessionChat({
  acp,
  onReady,
  sessionId,
  sessionTitle,
  projectId,
  boundAgentName,
}: {
  acp: NonNullable<ReturnType<typeof useSession>['acp']>;
  onReady?: () => void;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  /** The immutable agent this project session is bound to — locks the
   *  composer's agent/harness selectors (agent/harness never change mid-session). */
  boundAgentName?: string | null;
}) {
  const {
    ready,
    busy,
    envelopes,
    // Reference-stable per item (see `useAcpSession`) — an item untouched by
    // the latest snapshot keeps its previous object identity, which is what
    // lets `AcpChatItemRow`'s `memo` actually skip unrelated rows below.
    chatItems: items,
    pendingPrompts,
    usage,
    runtimeSessionId: acpSessionId,
    send: sendPrompt,
    cancel,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    autoApprovePermissions,
    setAutoApprovePermissions,
    configOptions,
    setConfigOption,
    agentInfo,
    connection,
    errorInfo,
    retry,
    availableCommands,
  } = acp;
  // Built straight from `items` (`acp.chatItems`) rather than re-deriving
  // via `projectAcpContext(envelopes)` — `chatItems` is ALREADY the exact
  // same projection (`AcpSession` maintains it incrementally, one
  // `reduceEnvelope` fold per flushed row — see `packages/sdk/src/acp/session.ts`),
  // so re-running a FULL from-scratch `projectAcpContext` fold over the
  // WHOLE envelope log on every commit was pure O(total envelopes) waste
  // that grows without bound over a session's lifetime (Task 19's replay
  // perf test caught this). `items` is reference-stable per untouched item,
  // so this `useMemo` still only does real work when something changed.
  const contextMessages = useMemo<MessageWithParts[]>(() => {
    const created = Date.parse(envelopes[0]?.createdAt ?? '') || Date.now();
    const messages: MessageWithParts[] = [];
    for (const item of items) {
      if (item.kind !== 'message') continue;
      messages.push({
        info: {
          id: item.id,
          role: item.role === 'user' ? ('user' as const) : ('assistant' as const),
          sessionID: sessionId,
          time: { created },
        },
        parts: [
          {
            id: `${item.id}-content`,
            messageID: item.id,
            sessionID: sessionId,
            type: item.role === 'thought' ? ('reasoning' as const) : ('text' as const),
            text: item.text,
          },
        ],
      });
    }
    return messages;
  }, [items, envelopes, sessionId]);
  const contextSession = useMemo<Session>(
    () => ({
      id: sessionId,
      title: sessionTitle,
      time: {
        created: Date.parse(envelopes[0]?.createdAt ?? '') || Date.now(),
        updated: Date.parse(envelopes.at(-1)?.createdAt ?? '') || Date.now(),
      },
    }),
    [envelopes, sessionId, sessionTitle],
  );
  const [contextModalOpen, setContextModalOpen] = useState(false);
  // `groupAcpTurns` (from `acp-turn-grouping.ts`) segments the flat item
  // stream into one array per turn; `groupAcpTurnItems` (below, per turn)
  // then folds each turn's non-user items into same-tool / reasoning
  // groups. The streaming tail is simply the last chat item overall — the
  // assistant message a new chunk lands on.
  const turns = useMemo(() => groupAcpTurns(items), [items]);
  const tailItem = items.at(-1) ?? null;
  // Best-effort per-turn duration, keyed off the envelope `ordinal`s
  // embedded in message item ids (`acpItemOrdinal`) — mirrors THEIRS'
  // `acpOrdinalTimestamps(envelopes)` exactly.
  const ordinalTimestamps = useMemo(() => acpOrdinalTimestamps(envelopes), [envelopes]);
  // Sibling memo over `turns` (never folded into it) — this data feeds a
  // footer rendered directly in the turn wrapper below, never passed as a
  // prop to `AcpChatItemRow`, so it cannot break that row's `memo` bailout.
  // Same footer condition THEIRS uses: only a turn with a completed
  // assistant response (never the streaming tail) shows one, and only the
  // last turn ever carries the session totals — cumulative cost ("$0.42
  // this session") and current context size ("128k ctx"). Both are pure
  // projections off the SAME `usage` snapshot the store already maintains
  // incrementally (`AcpSession`/`projectAcpUsage`, `@kortix/sdk`) — no new
  // query, no envelope re-fold.
  const turnFooters = useMemo<AcpTurnFooter[]>(
    () =>
      turns.map((turn, turnIndex) => {
        const { restItems } = splitAcpTurn(turn);
        const isLastTurn = turnIndex === turns.length - 1;
        const lastAssistantText =
          [...restItems]
            .reverse()
            .find(
              (item): item is AcpMessageItem =>
                item.kind === 'message' && item.role === 'assistant',
            ) ?? null;
        return {
          durationMs: acpTurnDurationMs(turn, ordinalTimestamps),
          costLabel: isLastTurn && !busy ? formatAcpSessionCostLabel(usage?.cost) : null,
          contextLabel: isLastTurn && !busy ? formatAcpContextLabel(usage) : null,
          lastAssistantText,
        };
      }),
    [turns, ordinalTimestamps, usage, busy],
  );
  // Minimap turns mirror the transcript boundaries but over the resolved
  // MessageWithParts projection `ChatMinimap` (grafted from main) expects.
  const minimapTurns = useMemo<Turn[]>(() => {
    const result: Turn[] = [];
    for (const message of contextMessages) {
      if (message.info.role === 'user')
        result.push({ userMessage: message, assistantMessages: [] });
      else if (result.length) result.at(-1)!.assistantMessages.push(message);
    }
    return result;
  }, [contextMessages]);
  const {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToAbsoluteBottom,
    smoothScrollToAbsoluteBottom,
  } = useAutoScroll({ working: busy, hasContent: items.length > 0 });
  const initialScrollSessionRef = useRef<string | null>(null);
  const isSidePanelOpen = useKortixComputerStore((state) => state.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((state) => state.setIsSidePanelOpen);
  const openFileInComputer = useKortixComputerStore((state) => state.openFileInComputer);
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const openFileForMention = useCallback(
    (path: string) => openFileInComputer(path),
    [openFileInComputer],
  );
  // Rows present at the first non-empty snapshot for THIS session are
  // history — they render static (no enter transition). Only a chat item
  // whose key isn't in this frozen set (i.e. one that arrives after that
  // point — a genuinely new turn) animates in. Re-keyed on `sessionId` so
  // switching sessions in the same mounted component re-arms it.
  const mountRef = useRef<{ sessionId: string; captured: boolean; keys: Set<string> }>({
    sessionId,
    captured: false,
    keys: new Set(),
  });
  if (mountRef.current.sessionId !== sessionId)
    mountRef.current = { sessionId, captured: false, keys: new Set() };
  if (!mountRef.current.captured && items.length > 0) {
    mountRef.current.captured = true;
    mountRef.current.keys = new Set(
      turns.flatMap((turn, turnIndex) =>
        turn.map((item, indexInTurn) => chatItemKey(item, turnIndex, indexInTurn)),
      ),
    );
  }
  const mountedItemKeys = mountRef.current.keys;
  useEffect(() => {
    if (ready) onReady?.();
  }, [onReady, ready]);
  useEffect(() => {
    if (!ready || !items.length) return;
    if (initialScrollSessionRef.current === sessionId) return;
    initialScrollSessionRef.current = sessionId;
    const frame = requestAnimationFrame(scrollToAbsoluteBottom);
    return () => cancelAnimationFrame(frame);
  }, [items.length, ready, scrollToAbsoluteBottom, sessionId]);

  // ── Live "what's it doing right now" status for the busy indicator. ──
  const liveStatusText = useMemo(() => {
    if (!busy) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'running'))
        return item.title;
    }
    return undefined;
  }, [items, busy]);

  // ── Todos — projected from the latest ACP plan update, not a stub. ──
  const latestPlanEntries = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === 'plan') return item.entries;
    }
    return undefined;
  }, [items]);
  const todos = useMemo(() => acpTodosFromPlanEntries(latestPlanEntries), [latestPlanEntries]);

  // ── Reply-to state (text selection → reply), grafted from main. ──
  const [replyTo, setReplyTo] = useState<ReplyToContext | null>(null);
  const handleClearReply = useCallback(() => setReplyTo(null), []);
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const handleChatMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const selectedText = sel?.toString().trim();
      if (!selectedText || selectedText.length < 2) {
        setSelectionPopup(null);
        return;
      }
      if (!sel?.rangeCount || !chatAreaRef.current?.contains(sel.anchorNode)) {
        setSelectionPopup(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = chatAreaRef.current.getBoundingClientRect();
      setSelectionPopup({
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top - containerRect.top - 8,
        text: selectedText.slice(0, 500),
      });
    });
  }, []);
  const handleChatMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-reply-popup]')) return;
    setSelectionPopup(null);
  }, []);
  const handleChatScroll = useCallback(() => setSelectionPopup(null), []);
  const handleSelectionReply = useCallback(() => {
    if (!selectionPopup) return;
    setReplyTo({ text: selectionPopup.text });
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionPopup]);

  // ── Message queue while busy — mirrors Claude Code/Codex's "queued turn".
  // `SessionChatInput`'s own `handleSubmit` is what actually routes a
  // busy-time submit to `onQueueMessage` instead of `onSend` (see
  // `session-chat-input.tsx`); this component just owns the queue's state
  // and flushes it once `busy` clears. ──
  const [queuedMessages, setQueuedMessages] = useState<QueuedAcpMessage[]>([]);
  const flushingQueueRef = useRef(false);
  const queueMessage = useCallback((text: string, files: AttachedFile[] = []) => {
    setQueuedMessages((current) => [
      ...current,
      { id: `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`, text, files },
    ]);
  }, []);
  const removeQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const send = useCallback(
    async (text: string, files: AttachedFile[] = []) => {
      if (!acpSessionId || busy) return;
      const outgoing = replyTo ? wrapAcpReplyContext(text, replyTo.text) : text;
      const blocks: Parameters<typeof sendPrompt>[0] = [{ type: 'text', text: outgoing }];
      for (const file of files) {
        if (file.kind === 'remote') {
          blocks.push({
            type: 'resource_link',
            uri: file.url,
            name: file.filename,
            mimeType: file.mime,
          });
          continue;
        }
        const data = bytesToBase64(new Uint8Array(await file.file.arrayBuffer()));
        if (file.isImage)
          blocks.push({
            type: 'image',
            data,
            mimeType: file.file.type || 'application/octet-stream',
          });
        else
          blocks.push({
            type: 'resource',
            resource: {
              uri: `file:///${file.file.name}`,
              mimeType: file.file.type || 'application/octet-stream',
              blob: data,
            },
          });
      }
      const sent = await sendPrompt(blocks);
      if (!sent)
        throw new Error('The ACP prompt failed. Your draft has been restored so you can retry.');
      setReplyTo(null);
    },
    [acpSessionId, busy, replyTo, sendPrompt],
  );

  // ACP-native slash commands (`availableCommands`, folded from
  // `available_commands_update` — see `ComposerChatInput`'s `live.availableCommands`
  // wiring below). ACP has no client-executable template — the harness
  // itself expands `/name args` server-side (this is exactly what the SDK's
  // own `useExecuteRuntimeCommand` sends for the deprecated project-command
  // path), so running one is just a normal prompt through the session
  // already open here. This is the EXECUTION half the audit found already
  // working; the discovery half (the composer's "/" palette) is what
  // `live.availableCommands` fixes.
  const handleCommand = useCallback(
    (command: Command, args?: string) => {
      void send(`/${command.name}${args ? ` ${args}` : ''}`).catch((reason) =>
        errorToast(reason instanceof Error ? reason.message : 'Failed to run the command'),
      );
    },
    [send],
  );

  useEffect(() => {
    if (busy || flushingQueueRef.current || queuedMessages.length === 0) return;
    const [next, ...rest] = queuedMessages;
    if (!next) return;
    flushingQueueRef.current = true;
    setQueuedMessages(rest);
    void send(next.text, next.files)
      .catch((reason) =>
        errorToast(reason instanceof Error ? reason.message : 'Failed to send the queued message'),
      )
      .finally(() => {
        flushingQueueRef.current = false;
      });
  }, [busy, queuedMessages, send]);

  // ── Question prompt: chip UX driven through SessionChatInput's
  // lockForQuestion/onCustomAnswer/questionButtonLabel/onQuestionAction, with
  // the imperative `QuestionPrompt` rendered in the composer's `inputSlot`.
  // Runs alongside the inline `AcpQuestionCard` in the transcript (both stay). ──
  const activeQuestion = pendingPrompts.questions[0] ?? null;
  const activeQuestionRequest = useMemo(
    () => (activeQuestion ? toQuestionRequest(activeQuestion, sessionId) : null),
    [activeQuestion, sessionId],
  );
  const questionPromptRef = useRef<QuestionPromptHandle>(null);
  const [questionAction, setQuestionAction] = useState<{ label: string | null; canAct: boolean }>({
    label: null,
    canAct: true,
  });
  const handleQuestionActionChange = useCallback((action: QuestionAction, canAct: boolean) => {
    const label = action === 'next' ? 'Next' : action === 'submit' ? 'Submit' : null;
    setQuestionAction({ label, canAct });
  }, []);
  const handleQuestionReply = useCallback(
    (_requestId: string, answers: QuestionAnswer[]) => {
      if (!activeQuestion) return;
      void respondQuestion(activeQuestion.id, buildAcpQuestionContent(activeQuestion, answers));
    },
    [activeQuestion, respondQuestion],
  );
  const handleQuestionReject = useCallback(() => {
    if (!activeQuestion) return;
    void rejectQuestion(activeQuestion.id);
  }, [activeQuestion, rejectQuestion]);
  const lockForQuestion = !!activeQuestion && busy;

  // ── Connector approvals (Kortix policy gate, independent of ACP protocol
  // permissions) — the composer locks for these too, mirroring main. ──
  const { data: approvalAudit } = useSessionAudit(projectId, sessionId, { refetchInterval: 5_000 });
  const hasPendingApproval = (approvalAudit?.actions ?? []).some(isPendingAction);
  const lockForApproval = hasPendingApproval || (pendingPrompts.permissions.length > 0 && busy);

  // Same busy/locked signals the composer's other controls key off (see
  // `session-chat-input.tsx`'s `VoiceRecorder`, disabled on `submitDisabled
  // || isBusy`) — no session yet, a terminal error, an in-flight turn, or a
  // pending question/approval all mean "don't let the user change session
  // config right now" just as much as they mean "don't let them send".
  const configOptionsDisabled =
    !acpSessionId || Boolean(errorInfo?.terminal) || busy || lockForQuestion || lockForApproval;

  // ── Config options → composer toolbar controls (per merge policy P1). The
  // model option is owned by the composer's own model selector, so it's
  // excluded here; every other `select`- or `mode`-typed option renders in
  // the toolbar — `select` as a popover pill (`AcpConfigOptionPill`), `mode`
  // as a segmented control (`AcpConfigOptionSegment`, Task 22 — B1 calls for
  // a segmented control over a dropdown for a mode's few, always-visible
  // choices). ──
  const modelConfigOption = useMemo(() => findAcpModelConfigOption(configOptions), [configOptions]);
  // Shared with `composer-chat-input.tsx`'s pre-session equivalent
  // (`use-harness-config-options-store.ts`) — one filter rule for "which
  // options render as pills", so live and pre-session can never drift.
  const otherConfigOptions = useMemo(
    () => otherAcpConfigOptions(configOptions, modelConfigOption),
    [configOptions, modelConfigOption],
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="acp-session-chat">
      <SessionSiteHeader
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={() => setIsSidePanelOpen(!isSidePanelOpen)}
        supportsCompact={false}
        agentName={agentInfo?.name}
      />
      <div ref={chatAreaRef} className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="relative h-full overflow-y-auto px-4 py-6"
          onMouseUp={handleChatMouseUp}
          onMouseDown={handleChatMouseDown}
          onScroll={handleChatScroll}
        >
          <div ref={contentRef} className="mx-auto w-full max-w-3xl space-y-4">
            {errorInfo?.terminal && items.length === 0 ? (
              <ErrorState
                size="sm"
                className="py-16"
                title="Something went wrong"
                description={errorInfo.message}
                action={
                  <Button type="button" variant="outline" size="sm" onClick={retry}>
                    Retry
                  </Button>
                }
              />
            ) : !ready && !errorInfo?.terminal ? (
              // Boot skeleton: message-shaped placeholders (alternating widths,
              // alternating alignment) — not a spinner, so the shell already
              // reads as "a transcript is about to appear" before any content
              // arrives. Also covers a transient (non-terminal) error surfacing
              // mid-bootstrap — the skeleton stays up rather than going blank,
              // and the reconnecting pill near the composer carries the
              // connection feedback.
              <div className="space-y-4" aria-hidden>
                <Skeleton className="h-16 w-3/4 rounded-md" />
                <Skeleton className="ml-auto h-16 w-1/2 rounded-md" />
                <Skeleton className="h-16 w-2/3 rounded-md" />
                <Skeleton className="ml-auto h-16 w-2/5 rounded-md" />
              </div>
            ) : ready && items.length === 0 ? (
              <EmptyState
                size="sm"
                icon={MessageCircle}
                title={EMPTY_CONVERSATION_COPY}
                className="py-16"
              />
            ) : (
              <>
                {turns.map((turn, turnIndex) => {
                  const { userItem, restItems } = splitAcpTurn(turn);
                  const isLastTurn = turnIndex === turns.length - 1;
                  const turnBusy = isLastTurn && busy;
                  const footer = turnFooters[turnIndex];
                  // Grafted grouping pipeline: fold this turn's non-user items
                  // into same-tool / reasoning runs (`groupAcpTurnItems`).
                  // Grouped runs render through their own memoized group cards;
                  // every per-item render item still delegates to the memoized
                  // `AcpChatItemRow`, so the transcript keeps its per-item
                  // memoization + enter-motion discipline. Raw frames render
                  // inline as `AcpUnknownMethodCard` (no more per-turn
                  // "Protocol events" Disclosure).
                  const renderItems = groupAcpTurnItems(restItems);
                  const renderRow = (item: AcpChatItem, indexInTurn: number) => {
                    const key = chatItemKey(item, turnIndex, indexInTurn);
                    return (
                      <AcpChatItemRow
                        key={key}
                        item={item}
                        isTail={item === tailItem}
                        isStreaming={busy && item === tailItem}
                        sessionId={sessionId}
                        pending={pendingPrompts}
                        onRespondQuestion={respondQuestion}
                        onRejectQuestion={rejectQuestion}
                        animateEnter={!mountedItemKeys.has(key)}
                        onFileClick={openFileForMention}
                        onOpenPreview={openPreview}
                      />
                    );
                  };
                  return (
                    <div
                      key={userItem?.id ?? `turn-${turnIndex}`}
                      data-turn-id={userItem?.id ?? `turn-${turnIndex}`}
                      className="group/turn space-y-3"
                    >
                      {userItem ? renderRow(userItem, 0) : null}
                      {(() => {
                        const renderElement = (
                          renderItem: (typeof renderItems)[number],
                          renderIndex: number,
                        ) => {
                          if (renderItem.type === 'reasoning-group') {
                            return (
                              <AcpGroupedReasoningCard
                                key={renderItem.key}
                                items={renderItem.items}
                                isStreaming={turnBusy}
                              />
                            );
                          }
                          if (renderItem.type === 'tool-group') {
                            return (
                              <AcpSameToolGroup
                                key={renderItem.key}
                                groupKind={renderItem.groupKind}
                                items={renderItem.items}
                                sessionId={sessionId}
                              />
                            );
                          }
                          if (renderItem.type === 'raw') {
                            return (
                              <AcpUnknownMethodCard
                                key={`raw-${turnIndex}-${renderIndex}`}
                                method={renderItem.item.method}
                                data={renderItem.item.data}
                              />
                            );
                          }
                          // tool-single | plan | question | message → memoized per-item row.
                          return renderRow(renderItem.item, renderIndex + 1);
                        };
                        // Chain-of-thought packing: consecutive activity items
                        // (reasoning runs, tool piles, single tools, plans,
                        // raw events) collapse into ONE tight `space-y-1`
                        // rail so the agent's work reads as a single stepper,
                        // while assistant prose and interactive question
                        // cards break the rail and keep the turn's full
                        // `space-y-4` breathing room.
                        const segments: ReactNode[] = [];
                        let rail: ReactElement[] = [];
                        const flushRail = () => {
                          if (rail.length === 0) return;
                          segments.push(
                            <div key={`rail-${rail[0]!.key ?? turnIndex}`} className="space-y-2">
                              {rail}
                            </div>,
                          );
                          rail = [];
                        };
                        renderItems.forEach((renderItem, renderIndex) => {
                          const element = renderElement(renderItem, renderIndex);
                          if (renderItem.type === 'message' || renderItem.type === 'question') {
                            flushRail();
                            segments.push(element);
                            return;
                          }
                          rail.push(element);
                        });
                        flushRail();
                        return segments;
                      })()}
                      {!turnBusy && footer?.lastAssistantText ? (
                        // One aligned footer line per completed turn: the copy
                        // action + an `InlineMeta` (turn duration · session
                        // cost · context size — the session totals live here,
                        // never as a detached line floating above the
                        // composer). Last turn: legible, rest-visible.
                        // Historical turns keep the hover-reveal noise control.
                        <div
                          data-testid="acp-turn-footer"
                          className={cn(
                            'text-muted-foreground -mt-2 flex items-center gap-1 text-xs transition-opacity duration-150',
                            isLastTurn ? 'opacity-100' : 'opacity-0 group-hover/turn:opacity-100',
                          )}
                        >
                          <CopyButton code={footer.lastAssistantText.text} />
                          <InlineMeta
                            className={cn(
                              'tabular-nums',
                              isLastTurn ? 'text-muted-foreground' : 'text-muted-foreground/50',
                            )}
                          >
                            {footer.durationMs != null
                              ? formatAcpDuration(footer.durationMs)
                              : null}
                            {footer.costLabel}
                            {footer.contextLabel}
                          </InlineMeta>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {errorInfo?.terminal ? (
                  // Terminal error with a transcript already on screen: the
                  // transcript never blanks — this inline row appends the
                  // failure after the last turn instead of replacing everything
                  // with the full-bleed `ErrorState`.
                  <div className="bg-popover rounded-md border px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="bg-kortix-red/15 flex size-9 shrink-0 items-center justify-center rounded-sm">
                        <AlertTriangle className="text-kortix-red size-5" />
                      </span>
                      <div className="min-w-0 flex-1 text-sm">
                        The connection to the agent failed.
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={retry}>
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
            {busy ? <AcpBusyIndicator statusText={liveStatusText} /> : null}
            <div ref={spacerElRef} />
          </div>
        </div>

        {/* Floats over the scroll area — anchored to the OUTER relative
            wrapper, never inside the scroll container itself (an absolute
            child of a scrolling box scrolls away with the content, which is
            exactly the "stuck on the page" bug this fixes). */}
        <Button
          type="button"
          // variant="outline"
          size="icon"
          className={cn(
            'absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full transition-opacity duration-150',
            showScrollButton ? 'shadow-md' : 'pointer-events-none opacity-0',
          )}
          onClick={smoothScrollToAbsoluteBottom}
        >
          <ArrowDown />
        </Button>

        {selectionPopup && (
          <div
            data-reply-popup
            className="absolute z-50"
            style={{
              left: `${selectionPopup.x}px`,
              top: `${selectionPopup.y}px`,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <Button
              onClick={handleSelectionReply}
              size="xs"
              className="animate-in fade-in-0 zoom-in-95 origin-bottom text-xs duration-150 ease-out"
            >
              Reply
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="24"
                height="24"
                color="currentColor"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="size-4"
              >
                <path d="M3.99219 10H11.9922C13.8521 10 14.7821 10 15.5451 10.2044C17.6157 10.7592 19.2329 12.3765 19.7877 14.4471C19.9922 15.2101 19.9922 16.1401 19.9922 18"></path>
                <path
                  d="M7.99219 6L6.83839 6.87652C4.94092 8.31801 3.99219 9.03875 3.99219 10C3.99219 10.9612 4.94092 11.682 6.83839 13.1235L7.99219 14"
                  strokeLinejoin="round"
                ></path>
              </svg>
            </Button>
          </div>
        )}

        <ChatMinimap
          turns={minimapTurns}
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          contentRef={contentRef as React.RefObject<HTMLDivElement>}
        />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {connection === 'reconnecting' ? (
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loading className="size-3 shrink-0" />
            Reconnecting…
          </span>
        ) : null}
        <ComposerChatInput
          sessionId={sessionId}
          projectId={projectId}
          boundAgentName={boundAgentName}
          onSend={(text, files) => send(text, files ?? [])}
          onCommand={handleCommand}
          isBusy={busy}
          disabled={!acpSessionId || Boolean(errorInfo?.terminal)}
          placeholder="Message the agent"
          live={{
            configOptions,
            onConfigOptionChange: (id, value) => void setConfigOption(id, value),
            availableCommands,
            messages: contextMessages,
            acpUsage: usage,
            onStop: () => void cancel(),
            onContextClick: () => setContextModalOpen(true),
            todos,
            queuedMessages: queuedMessages.map((message) => ({
              id: message.id,
              text: message.text,
            })),
            onQueueMessage: (text, files) => queueMessage(text, files ?? []),
            onRemoveQueuedMessage: removeQueuedMessage,
            replyTo,
            onClearReply: handleClearReply,
            lockForQuestion,
            lockForApproval,
            onCustomAnswer: (text) => questionPromptRef.current?.submitCustomAnswer(text),
            questionButtonLabel: activeQuestion ? questionAction.label : null,
            questionCanAct: questionAction.canAct,
            onQuestionAction: () => questionPromptRef.current?.performAction(),
          }}
          toolbarSlot={
            otherConfigOptions.length ? (
              <div className="flex items-center gap-0.5">
                {otherConfigOptions.map((option) =>
                  option.type === 'mode' ? (
                    <AcpConfigOptionSegment
                      key={option.id}
                      option={option}
                      onChange={(value) => setConfigOption(option.id, value)}
                      disabled={configOptionsDisabled}
                    />
                  ) : (
                    <AcpConfigOptionPill
                      key={option.id}
                      option={option}
                      onChange={(value) => void setConfigOption(option.id, value)}
                      disabled={configOptionsDisabled}
                    />
                  ),
                )}
              </div>
            ) : undefined
          }
          inputSlot={
            <>
              <AcpSessionPermissionPrompt
                projectId={projectId}
                sessionId={sessionId}
                permissions={pendingPrompts.permissions}
                autoApprove={autoApprovePermissions}
                onAutoApproveChange={setAutoApprovePermissions}
                onReply={respondPermission}
              />
              {activeQuestionRequest ? (
                <QuestionPrompt
                  key={activeQuestionRequest.id}
                  ref={questionPromptRef}
                  request={activeQuestionRequest}
                  onReply={handleQuestionReply}
                  onReject={handleQuestionReject}
                  onActionChange={handleQuestionActionChange}
                />
              ) : null}
            </>
          }
        />
      </div>
      <SessionContextModal
        open={contextModalOpen}
        onOpenChange={setContextModalOpen}
        messages={contextMessages}
        session={contextSession}
        providers={undefined}
      />
    </div>
  );
}

/**
 * Stable per-item key, shared between the JSX `key` prop and
 * `mountedItemKeys` (which decides `animateEnter`) — both need the EXACT
 * same identity for a given logical chat item, or a row's enter-animation
 * decision and its React reconciliation identity would disagree.
 *
 * `message`/`tool` items carry their own stable `id`; `permission`/
 * `question` carry the JSON-RPC request id under `id`. `plan` has no id at
 * all, but `reduceEnvelope` (`@kortix/sdk`) keeps at most ONE plan item per
 * turn (updated in place), so the owning `turnIndex` alone is a stable
 * identity for it. `raw` items never reach this function.
 */
function chatItemKey(item: AcpChatItem, turnIndex: number, indexInTurn: number): string {
  switch (item.kind) {
    case 'message':
    case 'tool':
      return `${item.kind}-${item.id}`;
    case 'permission':
    case 'question':
      return `${item.kind}-${String(item.id)}`;
    case 'plan':
      return `plan-${turnIndex}`;
    default:
      return `${item.kind}-${turnIndex}-${indexInTurn}`;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** The pulsing-dot + shimmering status line shown while the agent is actively
 *  working — main's busy treatment (`AnimatedThinkingText` + pulsing dot +
 *  `· Ns` counter), fed by the live tool status derived from the streaming ACP
 *  items. Grafted in to replace the plain "Agent is working" line. */
function AcpBusyIndicator({ statusText }: { statusText?: string }) {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (startRef.current == null) startRef.current = Date.now();
    const update = () =>
      setSeconds(Math.max(0, Math.round((Date.now() - startRef.current!) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="text-muted-foreground mt-2 flex items-center gap-2 py-1 text-xs">
      <span className="relative flex size-3">
        <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
        <span className="bg-muted-foreground/50 relative inline-flex size-3 rounded-full" />
      </span>
      {/* <AnimatedThinkingText statusText={statusText ?? 'Thinking'} className="text-xs" /> */}
      <TextShimmer className="text-xs">{statusText ?? 'Thinking'}</TextShimmer>
      <span className="text-muted-foreground/50">·</span>
      <span className="text-muted-foreground/70 tabular-nums">{seconds}s</span>
    </div>
  );
}


'use client';

import { Button } from '@/components/ui/button';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { cn } from '@/lib/utils';
import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/markdown/copy-button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { errorToast } from '@/components/ui/toast';
import type { useSession } from '@kortix/sdk/react';
import type { AcpChatItem, AcpSessionConfigOption } from '@kortix/sdk';
import { AlertTriangle, Check, ChevronDown, MessageCircle, Reply } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AcpChatItemRow } from './acp-chat-item-row';
import { ChatMinimap } from './chat-minimap';
import { SessionSiteHeader } from './header/session-site-header';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { type AttachedFile } from './session-chat-input';
import { ComposerChatInput } from './composer-chat-input';
import { SessionApprovalPrompt } from './session-approval-prompt';
import { isPendingAction, useSessionAudit } from './session-audit-shared';
import { SessionContextModal } from './session-context-modal';
import { QuestionPrompt, type QuestionAction, type QuestionPromptHandle } from './question-prompt';
import {
  acpTodosFromPlanEntries,
  buildAcpQuestionContent,
  findAcpModelConfigOption,
  toQuestionRequest,
} from './acp-composer-adapters';
import {
  acpOrdinalTimestamps,
  acpTurnDurationMs,
  formatAcpCost,
  formatAcpDuration,
  groupAcpTurns,
  groupAcpTurnItems,
  splitAcpTurn,
  wrapAcpReplyContext,
  type AcpMessageItem,
} from './acp-turn-grouping';
import { AcpGroupedReasoningCard, AcpSameToolGroup, AcpUnknownMethodCard } from './acp-transcript-groups';
import { AcpSessionPermissionPrompt } from './acp-session-permission-prompt';
import type { Command, Session } from '@/hooks/runtime/use-runtime-sessions';
import type { MessageWithParts, QuestionAnswer, Turn } from '@/ui';
import { useAutoScroll } from '@/hooks/use-auto-scroll';

const EMPTY_CONVERSATION_COPY = 'Start a conversation with the selected native harness.';

/** Per-turn footer chip data (`turnFooters`, below) — duration/cost text plus
 *  the assistant message the hover-reveal `CopyButton` copies. Mirrors what
 *  THEIRS derives inline per turn (`acpTurnDurationMs`, `formatAcpCost`). */
interface AcpTurnFooter {
  durationMs: number | null;
  costLabel: string | null;
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
  const contextMessages = useMemo<MessageWithParts[]>(
    () => {
      const created = Date.parse(envelopes[0]?.createdAt ?? '') || Date.now();
      const messages: MessageWithParts[] = [];
      for (const item of items) {
        if (item.kind !== 'message') continue;
        messages.push({
          info: {
            id: item.id,
            role: item.role === 'user' ? 'user' as const : 'assistant' as const,
            sessionID: sessionId,
            time: { created },
          },
          parts: [{
            id: `${item.id}-content`,
            messageID: item.id,
            sessionID: sessionId,
            type: item.role === 'thought' ? 'reasoning' as const : 'text' as const,
            text: item.text,
          }],
        });
      }
      return messages;
    },
    [items, envelopes, sessionId],
  );
  const contextSession = useMemo<Session>(() => ({
    id: sessionId,
    title: sessionTitle,
    time: {
      created: Date.parse(envelopes[0]?.createdAt ?? '') || Date.now(),
      updated: Date.parse(envelopes.at(-1)?.createdAt ?? '') || Date.now(),
    },
  }), [envelopes, sessionId, sessionTitle]);
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
  // last turn ever carries a cost figure (the running session total).
  const turnFooters = useMemo<AcpTurnFooter[]>(
    () =>
      turns.map((turn, turnIndex) => {
        const { restItems } = splitAcpTurn(turn);
        const isLastTurn = turnIndex === turns.length - 1;
        const lastAssistantText =
          [...restItems].reverse().find(
            (item): item is AcpMessageItem => item.kind === 'message' && item.role === 'assistant',
          ) ?? null;
        return {
          durationMs: acpTurnDurationMs(turn, ordinalTimestamps),
          costLabel: isLastTurn && !busy ? formatAcpCost(usage?.cost) : null,
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
      if (message.info.role === 'user') result.push({ userMessage: message, assistantMessages: [] });
      else if (result.length) result.at(-1)!.assistantMessages.push(message);
    }
    return result;
  }, [contextMessages]);
  const { scrollRef, contentRef, spacerElRef, showScrollButton, scrollToAbsoluteBottom, smoothScrollToAbsoluteBottom } = useAutoScroll({ working: busy, hasContent: items.length > 0 });
  const initialScrollSessionRef = useRef<string | null>(null);
  const isSidePanelOpen = useKortixComputerStore((state) => state.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((state) => state.setIsSidePanelOpen);
  const openFileInComputer = useKortixComputerStore((state) => state.openFileInComputer);
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const openFileForMention = useCallback((path: string) => openFileInComputer(path), [openFileInComputer]);
  // Rows present at the first non-empty snapshot for THIS session are
  // history — they render static (no enter transition). Only a chat item
  // whose key isn't in this frozen set (i.e. one that arrives after that
  // point — a genuinely new turn) animates in. Re-keyed on `sessionId` so
  // switching sessions in the same mounted component re-arms it.
  const mountRef = useRef<{ sessionId: string; captured: boolean; keys: Set<string> }>({ sessionId, captured: false, keys: new Set() });
  if (mountRef.current.sessionId !== sessionId) mountRef.current = { sessionId, captured: false, keys: new Set() };
  if (!mountRef.current.captured && items.length > 0) {
    mountRef.current.captured = true;
    mountRef.current.keys = new Set(turns.flatMap((turn, turnIndex) => turn.map((item, indexInTurn) => chatItemKey(item, turnIndex, indexInTurn))));
  }
  const mountedItemKeys = mountRef.current.keys;
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);
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
      if (item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'running')) return item.title;
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
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null);
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

  const send = useCallback(async (text: string, files: AttachedFile[] = []) => {
    if (!acpSessionId || busy) return;
    const outgoing = replyTo ? wrapAcpReplyContext(text, replyTo.text) : text;
    const blocks: Parameters<typeof sendPrompt>[0] = [{ type: 'text', text: outgoing }];
    for (const file of files) {
      if (file.kind === 'remote') {
        blocks.push({ type: 'resource_link', uri: file.url, name: file.filename, mimeType: file.mime });
        continue;
      }
      const data = bytesToBase64(new Uint8Array(await file.file.arrayBuffer()));
      if (file.isImage) blocks.push({ type: 'image', data, mimeType: file.file.type || 'application/octet-stream' });
      else blocks.push({ type: 'resource', resource: { uri: `file:///${file.file.name}`, mimeType: file.file.type || 'application/octet-stream', blob: data } });
    }
    const sent = await sendPrompt(blocks);
    if (!sent) throw new Error('The ACP prompt failed. Your draft has been restored so you can retry.');
    setReplyTo(null);
  }, [acpSessionId, busy, replyTo, sendPrompt]);

  // Project-configured slash commands. ACP has no client-executable template —
  // the harness itself expands `/name args` server-side (this is exactly what
  // the SDK's own `useExecuteRuntimeCommand` sends), so running one is just a
  // normal prompt through the session already open here.
  const handleCommand = useCallback((command: Command, args?: string) => {
    void send(`/${command.name}${args ? ` ${args}` : ''}`).catch((reason) =>
      errorToast(reason instanceof Error ? reason.message : 'Failed to run the command'),
    );
  }, [send]);

  useEffect(() => {
    if (busy || flushingQueueRef.current || queuedMessages.length === 0) return;
    const [next, ...rest] = queuedMessages;
    if (!next) return;
    flushingQueueRef.current = true;
    setQueuedMessages(rest);
    void send(next.text, next.files)
      .catch((reason) => errorToast(reason instanceof Error ? reason.message : 'Failed to send the queued message'))
      .finally(() => { flushingQueueRef.current = false; });
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
  const [questionAction, setQuestionAction] = useState<{ label: string | null; canAct: boolean }>({ label: null, canAct: true });
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

  // ── Config options → composer toolbar pills (per merge policy P1). The
  // model option is owned by the composer's own model selector, so it's
  // excluded here; every other select-typed option renders as a pill. ──
  const modelConfigOption = useMemo(() => findAcpModelConfigOption(configOptions), [configOptions]);
  const otherConfigOptions = useMemo(
    () =>
      configOptions.filter(
        (option) => option !== modelConfigOption && option.type === 'select' && (option.options?.length ?? 0) > 0,
      ),
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
                action={<Button type="button" variant="outline" size="sm" onClick={retry}>Retry</Button>}
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
              <EmptyState size="sm" icon={MessageCircle} title={EMPTY_CONVERSATION_COPY} className="py-16" />
            ) : (
              <>
                {turns.map((turn, turnIndex) => {
                  const { userItem, restItems } = splitAcpTurn(turn);
                  const isLastTurn = turnIndex === turns.length - 1;
                  const turnBusy = isLastTurn && busy;
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
                    <div key={userItem?.id ?? `turn-${turnIndex}`} data-turn-id={userItem?.id ?? `turn-${turnIndex}`} className="group/turn space-y-4">
                      {userItem ? renderRow(userItem, 0) : null}
                      {renderItems.map((renderItem, renderIndex) => {
                        if (renderItem.type === 'reasoning-group') {
                          return <AcpGroupedReasoningCard key={renderItem.key} items={renderItem.items} isStreaming={turnBusy} />;
                        }
                        if (renderItem.type === 'tool-group') {
                          return <AcpSameToolGroup key={renderItem.key} groupKind={renderItem.groupKind} items={renderItem.items} sessionId={sessionId} />;
                        }
                        if (renderItem.type === 'raw') {
                          return <AcpUnknownMethodCard key={`raw-${turnIndex}-${renderIndex}`} method={renderItem.item.method} data={renderItem.item.data} />;
                        }
                        // tool-single | plan | question | message → memoized per-item row.
                        return renderRow(renderItem.item, renderIndex + 1);
                      })}
                      {!turnBusy && turnFooters[turnIndex]?.lastAssistantText ? (
                        <div
                          data-testid="acp-turn-footer"
                          className="text-muted-foreground -mt-2 flex items-center gap-0.5 text-xs opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100"
                        >
                          {(turnFooters[turnIndex]!.durationMs != null || turnFooters[turnIndex]!.costLabel) ? (
                            <span className="text-muted-foreground/50 mr-1 tabular-nums">
                              {turnFooters[turnIndex]!.durationMs != null ? formatAcpDuration(turnFooters[turnIndex]!.durationMs!) : null}
                              {turnFooters[turnIndex]!.costLabel ? <> · {turnFooters[turnIndex]!.costLabel}</> : null}
                            </span>
                          ) : null}
                          <CopyButton code={turnFooters[turnIndex]!.lastAssistantText!.text} />
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
                      <div className="min-w-0 flex-1 text-sm">The connection to the agent failed.</div>
                      <Button type="button" variant="outline" size="sm" onClick={retry}>Retry</Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
            {busy ? <AcpBusyIndicator statusText={liveStatusText} /> : null}
            <div ref={spacerElRef} />
          </div>
          <Button type="button" variant="outline" size="sm" className={showScrollButton ? 'bg-background/90 absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg' : 'pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full opacity-0'} onClick={smoothScrollToAbsoluteBottom}>
            Scroll to latest
          </Button>
        </div>

        {selectionPopup && (
          <div
            data-reply-popup
            className="animate-in fade-in-0 slide-in-from-bottom-1 absolute z-50 duration-150"
            style={{ left: `${selectionPopup.x}px`, top: `${selectionPopup.y}px`, transform: 'translate(-50%, -100%)' }}
          >
            <Button onClick={handleSelectionReply} variant="outline" size="toolbar" className="bg-popover shadow-md">
              <Reply className="size-3.5" />
              Reply
            </Button>
          </div>
        )}

        <ChatMinimap
          turns={minimapTurns}
          scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
          contentRef={contentRef as React.RefObject<HTMLDivElement>}
        />
      </div>
      <div className="border-border border-t px-4 py-3">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {connection === 'reconnecting' ? (
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loading className="size-3 shrink-0" />Reconnecting…
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
              messages: contextMessages,
              acpUsage: usage,
              onStop: () => void cancel(),
              onContextClick: () => setContextModalOpen(true),
              todos,
              queuedMessages: queuedMessages.map((message) => ({ id: message.id, text: message.text })),
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
                  {otherConfigOptions.map((option) => (
                    <AcpConfigOptionPill
                      key={option.id}
                      option={option}
                      onChange={(value) => void setConfigOption(option.id, value)}
                    />
                  ))}
                </div>
              ) : undefined
            }
            inputSlot={
              <>
                <SessionApprovalPrompt />
                <AcpSessionPermissionPrompt
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
    const update = () => setSeconds(Math.max(0, Math.round((Date.now() - startRef.current!) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mt-2 flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="relative flex size-3">
        <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
        <span className="bg-muted-foreground/50 relative inline-flex size-3 rounded-full" />
      </span>
      <AnimatedThinkingText statusText={statusText ?? 'Thinking'} className="text-xs" />
      <span className="text-muted-foreground/50">·</span>
      <span className="text-muted-foreground/70 tabular-nums">{seconds}s</span>
    </div>
  );
}

/** A single non-model ACP session config option, rendered in the composer's
 *  bottom toolbar with the same pill affordance as the model/agent selectors
 *  (rounded-full trigger, popover select). Grafted from main (merge policy P1). */
function AcpConfigOptionPill({
  option,
  onChange,
}: {
  option: AcpSessionConfigOption;
  onChange: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = option.options ?? [];
  if (choices.length === 0) return null;
  const currentRaw = option.currentValue;
  const currentChoice = choices.find((choice, index) => choiceValue(choice, index) === String(currentRaw ?? ''));
  const currentLabel = currentChoice ? choiceLabel(currentChoice) : (currentRaw != null ? String(currentRaw) : null);

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <CommandPopoverTrigger>
        <button
          type="button"
          data-testid="acp-config-option-pill"
          data-option-id={option.id}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.96]"
        >
          <span className="max-w-[140px] truncate">
            {option.name ?? option.id}
            {currentLabel ? <span className="text-muted-foreground/70">: {currentLabel}</span> : null}
          </span>
          <ChevronDown className={cn('size-3 shrink-0 opacity-50 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </CommandPopoverTrigger>
      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[260px]">
        <CommandList className="max-h-[280px]">
          <CommandGroup heading={option.name ?? option.id} forceMount>
            {choices.map((choice, index) => {
              const value = choiceValue(choice, index);
              const label = choiceLabel(choice);
              const selected = value === String(currentRaw ?? '');
              return (
                <CommandItem
                  key={value}
                  value={label}
                  className={selected ? 'bg-primary/[0.06]' : undefined}
                  onSelect={() => {
                    onChange(value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  {selected ? <Check className="text-foreground size-4 shrink-0" /> : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

function choiceValue(choice: Record<string, unknown>, index: number): string {
  return String(choice.value ?? choice.id ?? index);
}

function choiceLabel(choice: Record<string, unknown>): string {
  return String(choice.name ?? choice.label ?? choice.value ?? choice.id ?? '');
}

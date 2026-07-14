'use client';

import { Button } from '@/components/ui/button';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { CopyButton } from '@/components/markdown/copy-button';
import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { errorToast } from '@/components/ui/toast';
import { UnifiedMarkdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import type { useSession } from '@kortix/sdk/react';
import {
  projectAcpChatItems,
  projectAcpContext,
  projectAcpPendingPrompts,
  type AcpMessageAttachment,
  type AcpSessionConfigOption,
} from '@kortix/sdk';
import { ArrowDown, Check, ChevronDown, File, ImageIcon, Reply } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  groupAcpTurnItems,
  groupAcpTurns,
  parseAcpReplyContext,
  splitAcpTurn,
  wrapAcpReplyContext,
  type AcpMessageItem,
} from './acp-turn-grouping';
import { AcpGroupedReasoningCard, AcpSameToolGroup, AcpUnknownMethodCard } from './acp-transcript-groups';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';
import { AcpSessionPermissionPrompt } from './acp-session-permission-prompt';
import { type AttachedFile } from './session-chat-input';
import { ComposerChatInput } from './composer-chat-input';
import { SessionSiteHeader } from './header/session-site-header';
import { GridFileCard } from './grid-file-card';
import { SessionWelcome } from './session-welcome';
import { useSessionWallpaperLayer } from './session-wallpaper-layer';
import { ChatMinimap } from './chat-minimap';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { QuestionPrompt, type QuestionAction, type QuestionPromptHandle } from './question-prompt';
import { SessionApprovalPrompt } from './session-approval-prompt';
import { SessionContextModal } from './session-context-modal';
import { isPendingAction, useSessionAudit } from './session-audit-shared';
import type { Command, Session } from '@/hooks/runtime/use-runtime-sessions';
import type { MessageWithParts, QuestionAnswer, Turn } from '@/ui';
import { useAutoScroll } from '@/hooks/use-auto-scroll';

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
    error,
    envelopes,
    runtimeSessionId: acpSessionId,
    send: sendPrompt,
    cancel,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    configOptions,
    setConfigOption,
    autoApprovePermissions,
    setAutoApprovePermissions,
  } = acp;
  const items = useMemo(() => projectAcpChatItems(envelopes), [envelopes]);
  const context = useMemo(() => projectAcpContext(envelopes), [envelopes]);
  const contextMessages = useMemo<MessageWithParts[]>(
    () => {
      const created = Date.parse(envelopes[0]?.createdAt ?? '') || Date.now();
      return context.messages.map((message) => ({
        info: {
          id: message.id,
          role: message.role === 'user' ? 'user' as const : 'assistant' as const,
          sessionID: sessionId,
          time: { created },
        },
        parts: [{
          id: `${message.id}-content`,
          messageID: message.id,
          sessionID: sessionId,
          type: message.role === 'thought' ? 'reasoning' as const : 'text' as const,
          text: message.text,
        }],
      }));
    },
    [context.messages, envelopes, sessionId],
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
  const pendingPrompts = useMemo(() => projectAcpPendingPrompts(envelopes), [envelopes]);
  const pendingPermissions = pendingPrompts.permissions;
  const pendingQuestions = pendingPrompts.questions;
  const activeQuestion = pendingQuestions[0] ?? null;
  const activeQuestionRequest = useMemo(
    () => (activeQuestion ? toQuestionRequest(activeQuestion, sessionId) : null),
    [activeQuestion, sessionId],
  );
  const turns = useMemo(() => groupAcpTurns(items), [items]);
  // Minimap turns mirror `turns` boundaries but over the resolved
  // MessageWithParts projection ChatMinimap (ported from main) expects.
  const minimapTurns = useMemo<Turn[]>(() => {
    const result: Turn[] = [];
    for (const message of contextMessages) {
      if (message.info.role === 'user') result.push({ userMessage: message, assistantMessages: [] });
      else if (result.length) result.at(-1)!.assistantMessages.push(message);
    }
    return result;
  }, [contextMessages]);
  const ordinalTimestamps = useMemo(() => acpOrdinalTimestamps(envelopes), [envelopes]);
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
  const wallpaperLayer = useSessionWallpaperLayer();
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);
  useEffect(() => {
    if (!ready || !items.length) return;
    if (initialScrollSessionRef.current === sessionId) return;
    initialScrollSessionRef.current = sessionId;
    const frame = requestAnimationFrame(scrollToAbsoluteBottom);
    return () => cancelAnimationFrame(frame);
  }, [items.length, ready, scrollToAbsoluteBottom, sessionId]);

  // ── Connector approvals (Kortix policy gate, independent of ACP protocol
  // permissions) — the composer locks for these too, mirroring main. ──
  const { data: approvalAudit } = useSessionAudit(projectId, sessionId, { refetchInterval: 5_000 });
  const hasPendingApproval = (approvalAudit?.actions ?? []).some(isPendingAction);
  const lockForApproval = hasPendingApproval || (pendingPermissions.length > 0 && busy);

  // ── Question prompt: chip UX driven through SessionChatInput's
  // lockForQuestion/onCustomAnswer/questionButtonLabel/onQuestionAction. ──
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

  // ── Live-session model pill / other config options → composer toolbar. ──
  const modelConfigOption = useMemo(() => findAcpModelConfigOption(configOptions), [configOptions]);
  const otherConfigOptions = useMemo(
    () =>
      configOptions.filter(
        (option) => option !== modelConfigOption && option.type === 'select' && (option.options?.length ?? 0) > 0,
      ),
    [configOptions, modelConfigOption],
  );

  // ── Message queue while busy — mirrors Claude Code/Codex's "queued turn". ──
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

  // ── Reply-to state (text selection → reply), mirrors main exactly. ──
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

  // ── Todos — projected from the latest ACP plan update, not a stub. ──
  const latestPlanEntries = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === 'plan') return item.entries;
    }
    return undefined;
  }, [items]);
  const todos = useMemo(() => acpTodosFromPlanEntries(latestPlanEntries), [latestPlanEntries]);

  // ── Live "what's it doing right now" status for the busy indicator. ──
  const liveStatusText = useMemo(() => {
    if (!busy) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'running')) return item.title;
    }
    return undefined;
  }, [items, busy]);

  const hasContent = items.length > 0;
  const showWelcome = !hasContent;
  // A persistent connection error while the ACP session never became ready is
  // terminal — never a loading guess — so it gets its own centered state
  // instead of a stray red line in an otherwise-empty transcript.
  const isUnavailable = !ready && !!error;

  const openFileForMention = useCallback((path: string) => openFileInComputer(path), [openFileInComputer]);

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col pt-10', showWelcome ? 'bg-transparent' : 'bg-background')}
      data-testid="acp-session-chat"
    >
      {showWelcome ? (
        wallpaperLayer ? (
          createPortal(
            <div className="pointer-events-none absolute inset-0 z-0">
              <SessionWelcome />
            </div>,
            wallpaperLayer,
          )
        ) : (
          <div className="pointer-events-none absolute inset-0 z-0">
            <SessionWelcome />
          </div>
        )
      ) : null}

      <SessionSiteHeader
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={() => setIsSidePanelOpen(!isSidePanelOpen)}
        supportsCompact={false}
      />

      {isUnavailable ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-muted-foreground text-sm">This session is not accessible right now.</div>
          <button
            type="button"
            onClick={() => { if (typeof window !== 'undefined') window.location.assign('/'); }}
            className="text-primary text-sm hover:underline"
          >
            Go to home
          </button>
        </div>
      ) : (
        <div ref={chatAreaRef} className="relative z-10 min-h-0 flex-1">
          <div
            ref={scrollRef}
            className={cn(
              'scrollbar-hide relative z-10 h-full flex-1 overflow-y-auto [scroll-behavior:auto] px-4 py-4',
              showWelcome ? 'bg-transparent' : 'bg-background',
            )}
            onMouseUp={handleChatMouseUp}
            onMouseDown={handleChatMouseDown}
            onScroll={handleChatScroll}
          >
            <div ref={contentRef} role="log" className="mx-auto w-full max-w-3xl min-w-0 px-3 sm:px-6">
              <div className="flex min-w-0 flex-col">
                {turns.map((turn, turnIndex) => {
                  const { userItem, restItems } = splitAcpTurn(turn);
                  const isLastTurn = turnIndex === turns.length - 1;
                  const turnBusy = isLastTurn && busy;
                  const hasAssistantContent = restItems.length > 0 || turnBusy;
                  const durationMs = acpTurnDurationMs(turn, ordinalTimestamps);
                  const lastAssistantText = [...restItems].reverse().find(
                    (i): i is AcpMessageItem => i.kind === 'message' && i.role === 'assistant',
                  );
                  const costLabel = isLastTurn && !busy ? formatAcpCost(context.usage?.cost) : null;

                  return (
                    <div
                      key={userItem?.id ?? `turn-${turnIndex}`}
                      data-turn-id={userItem?.id ?? `turn-${turnIndex}`}
                      className={cn('group/turn', turnIndex === 0 ? '' : 'mt-12')}
                    >
                      {userItem ? <AcpUserMessage item={userItem} onFileClick={openFileForMention} onOpenPreview={openPreview} /> : null}

                      {hasAssistantContent ? (
                        <div className="mt-3 flex items-center gap-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src="/kortix-logomark-white.svg"
                            alt="Kortix"
                            className="h-[14px] w-auto flex-shrink-0 invert dark:invert-0"
                          />
                        </div>
                      ) : null}

                      {restItems.length > 0 ? (
                        <div className="space-y-2">
                          {groupAcpTurnItems(restItems).map((renderItem) => {
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
                            if (renderItem.type === 'tool-single') {
                              return <AcpToolCallCard key={renderItem.item.id} tool={renderItem.item} sessionId={sessionId} />;
                            }
                            if (renderItem.type === 'plan') {
                              return <AcpPlanCard key="plan" plan={renderItem.item} />;
                            }
                            if (renderItem.type === 'raw') {
                              return <AcpUnknownMethodCard key={`raw-${renderItem.item.method}`} method={renderItem.item.method} data={renderItem.item.data} />;
                            }
                            // Assistant/thought-with-no-group text message.
                            const { item } = renderItem;
                            if (!item.text.trim()) return null;
                            return (
                              <div key={item.id} className="min-w-0 text-sm">
                                <UnifiedMarkdown content={item.text} isStreaming={turnBusy && item === items.at(-1)} />
                                {item.attachments?.length ? <AcpMessageAttachments attachments={item.attachments} /> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {turnBusy ? (
                        <AcpBusyIndicator statusText={liveStatusText} />
                      ) : lastAssistantText ? (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
                          {(durationMs != null || costLabel) && (
                            <span className="text-muted-foreground/50 mr-1 text-xs">
                              {durationMs != null ? formatAcpDuration(durationMs) : null}
                              {costLabel ? <> · {costLabel}</> : null}
                            </span>
                          )}
                          <CopyButton code={lastAssistantText.text} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {/* The very first send: busy flips true before the echoed user
                    prompt has landed in `envelopes`, so `turns` is still
                    empty — show the busy row standalone instead of losing it. */}
                {turns.length === 0 && busy ? <AcpBusyIndicator statusText={liveStatusText} /> : null}
                {error && !isUnavailable ? <div className="text-kortix-red mt-3 text-sm">{error}</div> : null}
              </div>
              <div ref={spacerElRef} />
            </div>
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
            messages={contextMessages}
          />

          <div
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 transition-colors duration-300 ease-out',
              showScrollButton ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none translate-y-4 scale-95 opacity-0',
            )}
          >
            <Button
              variant="outline"
              size="sm"
              className="bg-background/90 border-border/60 h-7 rounded-full text-xs shadow-lg"
              onClick={smoothScrollToAbsoluteBottom}
            >
              <ArrowDown className="mr-1 size-3" />
              Scroll to Bottom
            </Button>
          </div>
        </div>
      )}

      <div className="border-border border-t px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <ComposerChatInput
            sessionId={sessionId}
            projectId={projectId}
            boundAgentName={boundAgentName}
            onSend={(text, files) => send(text, files ?? [])}
            onCommand={handleCommand}
            isBusy={busy}
            disabled={!acpSessionId}
            placeholder="Message the agent"
            live={{
              configOptions,
              onConfigOptionChange: (id, value) => void setConfigOption(id, value),
              messages: contextMessages,
              acpUsage: context.usage,
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
                  permissions={pendingPermissions}
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

/** A single non-model ACP session config option, rendered in the composer's
 *  bottom toolbar with the same pill affordance as `HarnessModelSelector` /
 *  `AgentSelector` (rounded-full trigger, popover select). */
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** The pulsing-dot + shimmering status line shown while the agent is
 *  actively working — main's busy treatment (`AnimatedThinkingText` +
 *  pulsing dot + `· Ns` counter), fed by the live tool status derived from
 *  the streaming ACP items. ACP exposes no retry signal today, so unlike
 *  main there is no retry sub-state here. */
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

/** User-turn bubble — bg-card rounded-3xl rounded-br-lg border tail, reply
 *  context strip, file-attachment cards, @mention highlighting, and a
 *  hover-reveal copy button. Mirrors main's `UserMessageRow` shape closely
 *  enough that the instant-shell → live-chat crossfade never jumps. */
function AcpUserMessage({
  item,
  onFileClick,
  onOpenPreview,
}: {
  item: AcpMessageItem;
  onFileClick: (path: string) => void;
  onOpenPreview: (path: string) => void;
}) {
  const { cleanText, replyContext } = useMemo(() => parseAcpReplyContext(item.text), [item.text]);

  return (
    <div>
      <div className="flex justify-end">
        <div className="bg-card flex max-w-[90%] flex-col overflow-hidden rounded-3xl rounded-br-lg border">
          {replyContext && (
            <div className="bg-primary/5 border-primary/10 mx-3 mt-3 mb-0 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
              <Reply className="text-primary/60 size-3 flex-shrink-0" />
              <span className="text-muted-foreground truncate text-xs">
                {replyContext.length > 150 ? `${replyContext.slice(0, 150)}...` : replyContext}
              </span>
            </div>
          )}
          {item.attachments?.length ? (
            <div className="flex flex-wrap gap-2 p-3 pb-0">
              {item.attachments.map((attachment, index) => (
                <div key={`${attachment.name ?? index}`} onClick={(e) => e.stopPropagation()}>
                  <AcpAttachmentCard attachment={attachment} onOpenPreview={onOpenPreview} />
                </div>
              ))}
            </div>
          ) : null}
          {cleanText && (
            <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
              <AcpHighlightMentions text={cleanText} onFileClick={onFileClick} />
            </p>
          )}
        </div>
      </div>
      {cleanText && (
        <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100">
          <CopyButton code={cleanText} />
        </div>
      )}
    </div>
  );
}

/** A sandbox-file attachment renders as a `GridFileCard`; anything else
 *  (an inline image blob, a remote resource) falls back to the compact
 *  chip/thumbnail treatment ACP attachments used before this pass. */
function AcpAttachmentCard({
  attachment,
  onOpenPreview,
}: {
  attachment: AcpMessageAttachment;
  onOpenPreview: (path: string) => void;
}) {
  const label = attachment.name ?? (attachment.kind === 'image' ? 'Image' : attachment.kind === 'audio' ? 'Audio' : 'Resource');
  const sandboxPath = attachment.uri?.startsWith('file://') ? attachment.uri.replace(/^file:\/\//, '') : null;
  if (sandboxPath) {
    return (
      <GridFileCard
        filePath={sandboxPath}
        fileName={label}
        onClick={() => onOpenPreview(sandboxPath)}
        className="w-[120px]"
      />
    );
  }
  const imageSource = attachment.kind === 'image'
    ? attachment.uri ?? (attachment.data && attachment.mimeType ? `data:${attachment.mimeType};base64,${attachment.data}` : null)
    : null;
  if (imageSource) {
    return (
      <a href={imageSource} target="_blank" rel="noopener noreferrer" className="bg-popover block overflow-hidden rounded-md border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageSource} alt={label} className="h-24 w-32 object-cover" />
        <span className="text-muted-foreground flex max-w-32 items-center gap-1 px-2 py-1 text-xs">
          <ImageIcon className="size-3 shrink-0" /><span className="truncate">{label}</span>
        </span>
      </a>
    );
  }
  const content = (
    <span className="bg-popover text-muted-foreground inline-flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs">
      <File className="size-3.5 shrink-0" /><span className="truncate">{label}</span>
    </span>
  );
  return attachment.uri?.startsWith('http') ? (
    <a href={attachment.uri} target="_blank" rel="noopener noreferrer">{content}</a>
  ) : content;
}

function AcpMessageAttachments({ attachments }: { attachments: AcpMessageAttachment[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <AcpAttachmentCard key={`${attachment.name ?? index}`} attachment={attachment} onOpenPreview={() => {}} />
      ))}
    </div>
  );
}

/** @-mention highlighting for user bubbles. ACP has no structured
 *  file/agent/session-ref XML like main's OpenCode pipeline emits — it only
 *  ever sees plain typed `@token`s — so every mention renders with the same
 *  monochrome underline chip and, when it looks like a path, opens the file
 *  preview; there is no session/agent list wired in here to distinguish the
 *  other two kinds (follow-up once ACP carries structured mention refs). */
function AcpHighlightMentions({ text, onFileClick }: { text: string; onFileClick?: (path: string) => void }) {
  const segments = useMemo(() => {
    const mentionRegex = /@([\w.\-/]+)/g;
    const result: { text: string; isMention: boolean }[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
      if (match.index > lastIndex) result.push({ text: text.slice(lastIndex, match.index), isMention: false });
      result.push({ text: match[0], isMention: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result.push({ text: text.slice(lastIndex), isMention: false });
    return result;
  }, [text]);

  const mentionClass =
    'font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground/70 cursor-pointer';

  return (
    <>
      {segments.map((segment, index) =>
        segment.isMention && onFileClick ? (
          <span
            key={index}
            className={mentionClass}
            onClick={(e) => {
              e.stopPropagation();
              onFileClick(segment.text.replace(/^@/, ''));
            }}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

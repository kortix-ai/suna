'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { detectCommandFromText } from '@/features/session/detect-command';
import { SessionApprovalPrompt } from '@/features/session/session-approval-prompt';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionPermissionPrompt } from '@/features/session/session-permission-prompt';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import {
  WarningIcon as AlertTriangle,
  ArrowBendUpLeftIcon,
  CaretDownIcon,
  CheckCircleIcon as CheckCircle,
  CheckIcon,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  StackIcon as Layers,
  ArrowCounterClockwiseIcon as RotateCcw,
  TerminalWindowIcon as Terminal,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SystemNotificationCard,
  parseSystemNotifications,
  stripSystemPtyText,
} from './message-parsing';
import { ActivityBurst } from './turn/activity-burst';
import { planAnchorMessageId } from './turn/plan-anchor';
import { segmentTurn } from './turn/segment-turn';
import { ThrottledMarkdown } from './turn/throttled-markdown';
import { UserMessage } from './turn/user-message';

import { ConnectorRequiredNotice } from '@/features/session/connector-required-notice';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { NO_MODEL_AVAILABLE_MESSAGE } from '@/features/session/model-availability';
import {
  ConnectProviderDialog,
  type ModelDefaultControls,
} from '@/features/session/model-selector';
import {
  type QuestionAction,
  QuestionPrompt,
  type QuestionPromptHandle,
} from '@/features/session/question-prompt';
import { SessionScopeToolbar } from '@/features/session/scope/session-scope-toolbar';
import { SessionActionPanelColumn } from '@/features/session/session-action-panel-column';
import {
  type AttachedFile,
  SessionChatInput,
  type TrackedMention,
} from '@/features/session/session-chat-input';
import { SessionContextModal } from '@/features/session/session-context-modal';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SessionWelcome } from '@/features/session/session-welcome';
import { SessionBusyIndicator } from './session-busy-indicator';
import { SessionTurnMeta } from './session-turn-meta';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnSpan,
} from './session-turn-meta-rows';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { searchWorkspaceFiles } from '@/features/files';
import { uploadFile } from '@/features/files/api/runtime-files';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
// billingApi / invalidateAccountState / useQueryClient removed — billing is handled server-side by the router
import { ChatMinimap } from '@/features/session/chat-minimap';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolActivateContext, ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import {
  buildOptimisticPromptTextWithUploads,
  buildPromptPartsWithUploads,
} from '@/features/session/uploaded-file-refs';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useModelPricingLookup } from '@/lib/model-pricing';
import {
  type AgentRefLike,
  type FileRefLike,
  buildAgentRefsBlock,
  buildFileRefsBlock,
} from '@/lib/project-preamble';
import { playSound } from '@/lib/sounds';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '@/lib/utils/kortix-system-tags';
import { useChatSendStore } from '@/stores/chat-send-store';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import {
  usePendingFilesStore,
  usePendingQueueStore,
} from '@/stores/session-composer-handoff-store';
import {
  useSessionComposerPrefillStore,
  useSessionPrefill,
} from '@/stores/session-composer-prefill-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import {
  type Command,
  type MessageWithParts,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type TextPart,
  type ToolPart,
  type Turn,
  collectTurnParts,
  findLastTextPart,
  formatDuration,
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  getShellModePart,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  getTurnStatus,
  getWorkingState,
  groupMessagesIntoTurns,
  isAgentPart,
  isAttachment,
  isLastUserMessage,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
} from '@/ui';
import { updateProjectSession } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import {
  type KortixSendError,
  type ModelKey,
  type UseSessionResult,
  abandonOptimisticSend,
  applyOptimisticAbort,
  ascendingId,
  beginOptimisticSend,
  classifySendError,
  clearStartStash,
  formatModelString,
  formatPromptModel,
  parseModelKey,
  readStartStash,
  recoverFromSendFailure,
  rejectQuestion,
  replayStartStash,
  replyToPermission,
  replyToQuestion,
  sendAndRecover,
  useAbortRuntimeSession,
  useExecuteRuntimeCommand,
  usePermissionSelfHeal,
  useProjectConfig,
  useQuestionSelfHeal,
  useRuntimeAgents,
  useRuntimeCommands,
  useRuntimeConfig,
  useRuntimePendingStore,
  useRuntimeProviders,
  useRuntimeReady,
  useRuntimeSession,
  useRuntimeSessions,
  useSessionModelSelection,
  useSessionStateStore,
  useSessionSync,
} from '@kortix/sdk/react';
import { Icon } from '../icon/icon';
import { SandboxUrlDetector } from './sandbox-url-detector';
import { sessionComposerReadiness } from './session-composer-readiness';
import { captureTurnScrollAnchor, restoreTurnScrollAnchor } from './session-history-scroll';
import { resolveSessionContentState } from './session-load-state';
import { shouldLoadOlderHistory } from './session-older-autoload';

// ============================================================================
// Reply-to context (select & reply feature)
// ============================================================================

/** Selected text the user wants to reference in their next message. */
export interface ReplyToContext {
  text: string;
}

// ============================================================================
// Sub-Session Breadcrumb
// ============================================================================

// SubSessionBar removed — subsessions now use SessionSiteHeader + chat input indicator

// ============================================================================
// Optimistic answers cache
// ============================================================================
// When a user answers a question, we save the answers here immediately.
// This survives SSE `message.part.updated` events that may overwrite the
// tool part's state before the server has merged the answers.  The cache
// is keyed by the question tool part's `id` (stable across updates).
// Entries are cleaned up once the server's authoritative part arrives with
// real `metadata.answers`.

const optimisticAnswersCache = new Map<
  string,
  { answers: string[][]; input: Record<string, unknown> }
>();

// ============================================================================
// Parse answers from the question tool's output string
// ============================================================================
// When metadata.answers is missing (e.g. after page reload, or the server
// never finalized the tool part), we can try to extract answers from the
// output string. The server formats it as:
//   "User has answered your questions: \"Q1\"=\"A1\". You can now continue..."
// This is a best-effort parser; if it can't match, returns null.

function parseAnswersFromOutput(
  output: string,
  input?: { questions?: Array<{ question: string }> },
): string[][] | null {
  if (!output) return null;

  const questions = input?.questions;
  if (!questions || questions.length === 0) return null;

  // Try to extract "question"="answer" pairs from the output
  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const pairs: { question: string; answer: string }[] = [];
  let match;
  while ((match = pairRegex.exec(output)) !== null) {
    pairs.push({ question: match[1], answer: match[2] });
  }

  if (pairs.length > 0) {
    // Match pairs to input questions by order (they correspond 1:1)
    return questions.map((_, i) => {
      const pair = pairs[i];
      return pair ? [pair.answer] : [];
    });
  }

  // Fallback: if we can't parse pairs but the output mentions "answered",
  // return a placeholder to indicate the question was answered
  if (output.toLowerCase().includes('answered')) {
    return questions.map(() => ['Answered']);
  }

  return null;
}

function formatCommandError(errorLike: unknown): string {
  const err = errorLike as any;
  const root = err?.data ?? err;
  const data = root?.data;
  const directMessage =
    root?.message ||
    err?.message ||
    root?.error ||
    err?.error ||
    (typeof err === 'string' ? err : '');

  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage.trim();
  }

  if (root?.name === 'ProviderModelNotFoundError') {
    const providerID =
      typeof data?.providerID === 'string' && data.providerID
        ? data.providerID
        : 'selected provider';
    const modelID =
      typeof data?.modelID === 'string' && data.modelID ? data.modelID : 'selected model';
    if (providerID === '[object Object]') {
      return 'Invalid model selection was sent to the command endpoint. Please reselect a model and try again.';
    }
    return `Model ${modelID} was not found for provider ${providerID}.`;
  }

  if (typeof root?.name === 'string' && root.name) {
    return root.name;
  }

  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return 'Command failed';
    }
  }

  return 'Command failed';
}

/**
 * Classify a send/command failure onto the SDK's typed `KortixSendError`
 * layer (billing vs runtime-not-ready vs runtime-error) so the banner can key
 * off `.kind` instead of regexing the message — while keeping this file's
 * richer message formatting (`formatCommandError` special-cases things like
 * `ProviderModelNotFoundError` that the SDK's generic formatter doesn't know
 * about).
 */
function classifySessionError(err: unknown): KortixSendError {
  return { ...classifySendError(err), message: formatCommandError(err) };
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

// ============================================================================
// Answered question card — collapsible summary of completed Q&A
// ============================================================================

function AnsweredQuestionCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const input = (part.state as any)?.input ?? {};
  const metadata = (part.state as any)?.metadata ?? {};
  const questions: Array<{ question: string; options?: { label: string }[] }> = Array.isArray(
    input.questions,
  )
    ? input.questions
    : [];
  const answers: string[][] = Array.isArray(metadata.answers) ? metadata.answers : [];
  if (questions.length === 0 || answers.length === 0) return null;

  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <Disclosure
      variant="outline"
      className="bg-card overflow-hidden"
      open={expanded}
      onOpenChange={setExpanded}
    >
      <DisclosureTrigger variant="outline">
        <Button
          type="button"
          variant="popover"
          className="bg-card flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-4 py-2.5 text-left"
        >
          <span className="text-foreground text-xs font-medium">Questions</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {answeredCount} answered
          </span>
          <ChevronDown
            className={cn(
              'text-muted-foreground ml-auto shrink-0 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-4 px-4 py-2.5">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || 'No answer';
            return (
              <div key={i} className="space-y-1">
                <div className="[&_*]:!text-muted-foreground [&_strong]:!text-muted-foreground [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_p]:!text-pretty [&_ul]:!my-0">
                  <UnifiedMarkdown content={q.question} />
                </div>
                <p className="text-foreground text-sm font-medium text-pretty">{answerText}</p>
              </div>
            );
          })}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

// ============================================================================
// Message parsing exported to message-parsing.tsx
// ============================================================================

/** A message typed while the agent was busy, held client-side until a safe boundary. */
interface QueuedMessage {
  id: string;
  text: string;
  files?: AttachedFile[];
  mentions?: TrackedMention[];
}

// ============================================================================
// Notification-only turn detection
// ============================================================================

/** True when a turn's user message contains only system notification XML
 *  with no real user-authored text. */
function isNotificationOnlyMessage(parts: Part[]): boolean {
  if (parts.length === 0) return false;
  const textParts = parts.filter(
    (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
  ) as TextPart[];
  if (textParts.length === 0) return false;
  const raw = textParts.map((p) => p.text || '').join('\n');
  const { cleanText, notifications } = parseSystemNotifications(stripKortixSystemTags(raw));
  return notifications.length > 0 && !cleanText.trim();
}

// ============================================================================
// NotificationTurn — lightweight turn for system notification messages
// ============================================================================

/** Renders notification-only turns (PTY exits, agent completions, etc.)
 *  inline with the conversation flow, styled like tool-call cards. */
function NotificationTurn({ turn }: { turn: Turn }) {
  const rawText = useMemo(() => {
    return turn.userMessage.parts
      .filter((p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored)
      .map((p) => (p as TextPart).text || '')
      .join('\n');
  }, [turn.userMessage.parts]);

  const { notifications } = useMemo(
    () => parseSystemNotifications(stripKortixSystemTags(rawText)),
    [rawText],
  );

  if (notifications.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {notifications.map((n, i) => (
        <SystemNotificationCard key={`${n.tag}-${i}`} notification={n} />
      ))}
    </div>
  );
}

// ============================================================================
// Session Turn — core turn component
// ============================================================================

interface SessionTurnProps {
  turn: Turn;
  allMessages: MessageWithParts[];
  sessionId: string;
  sessionStatus: import('@/ui').SessionStatus | undefined;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  agentNames?: string[];
  /** Whether this is the first turn in the session */
  isFirstTurn: boolean;
  /** Whether the session is busy */
  isBusy: boolean;
  /** Whether this turn contains a compaction */
  isCompaction?: boolean;
  /** Providers data for the Connect Provider dialog */
  providers?: ProviderListResponse;
  /** Map of user message IDs to command info for rendering command pills */
  commandMessages?: Map<string, { name: string; args?: string }>;
  /** Available commands for template prefix matching (page refresh detection) */
  commands?: Command[];
  /** Disable redirect-style tool navigation (used during onboarding) */
  disableToolNavigation?: boolean;
  /** Permission reply handler */
  onPermissionReply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
  /** Stage an in-place session rewind and restore this prompt in the composer. */
  onRewind: (messageId: string, text: string) => void;
  /** Disable history changes while the session is busy or read-only. */
  rewindDisabled: boolean;
}

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

function SessionTurn({
  turn,
  allMessages,
  sessionId,
  sessionStatus,
  permissions,
  questions,
  agentNames,
  isFirstTurn,
  isBusy,
  isCompaction,
  providers,
  commandMessages,
  commands,
  disableToolNavigation,
  onPermissionReply,
  onRewind,
  rewindDisabled,
}: SessionTurnProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);

  // Derived state from shared helpers
  const allParts = useMemo(() => collectTurnParts(turn), [turn]);
  // Check if there are visible steps that actually render inside the
  // collapsible steps section. Tool parts that are rendered elsewhere
  // (todowrite, task, question) don't count as "steps".
  const hasSteps = useMemo(() => {
    return allParts.some(({ part }) => {
      if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch')
        return true;
      if (isToolPart(part)) {
        if (part.tool === 'todowrite' || part.tool === 'task' || part.tool === 'question')
          return false;
        return shouldShowToolPart(part);
      }
      return false;
    });
  }, [allParts]);
  const hasReasoning = useMemo(
    () => allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim()),
    [allParts],
  );
  const isLast = useMemo(
    () => isLastUserMessage(turn.userMessage.info.id, allMessages),
    [turn.userMessage.info.id, allMessages],
  );
  // The plan belongs to the turn that WROTE it, not to whichever turn happens
  // to be last — see turn/plan-anchor.ts.
  const ownsPlan = useMemo(
    () => planAnchorMessageId(allMessages) === turn.userMessage.info.id,
    [turn.userMessage.info.id, allMessages],
  );
  // A turn is "working" when:
  // 1. The session status says busy/retry (via getWorkingState), OR
  // 2. This is the last turn AND the parent component says isBusy (e.g. we
  //    just sent a message but sessionStatus hasn't updated to busy yet).
  //    This covers the race between sending and the server acknowledging.
  const working = useMemo(
    () => getWorkingState(sessionStatus, isLast) || (isLast && isBusy),
    [sessionStatus, isLast, isBusy],
  );
  const activeAssistantMessage = useMemo(() => {
    if (turn.assistantMessages.length === 0) return undefined;
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as any)?.time?.completed) return msg;
    }
    return turn.assistantMessages[turn.assistantMessages.length - 1];
  }, [turn.assistantMessages]);
  const streamingResponseRaw = useMemo(() => {
    if (!activeAssistantMessage) return '';
    return activeAssistantMessage.parts
      .filter(isTextPart)
      .map((p) => p.text ?? '')
      .join('');
  }, [activeAssistantMessage]);
  const lastTextPart = useMemo(() => findLastTextPart(allParts), [allParts]);
  const responseRaw = lastTextPart?.text ?? '';
  // Fallback: when aborted, collect ALL non-empty text parts if the
  // primary response is empty.  The last text part may have been lost
  // (timing between text-start and first text-delta) but earlier parts
  // might still have content.
  const abortedTextFallback = useMemo(() => {
    if (responseRaw) return ''; // primary response exists — no fallback needed
    // Only activate for aborted/errored turns
    const hasError = turn.assistantMessages.some((m) => (m.info as any).error);
    if (!hasError) return '';
    const texts: string[] = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n').trim();
  }, [responseRaw, allParts, turn.assistantMessages]);
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
      : responseRaw.trim() || abortedTextFallback;
  // Retry info (only on last turn)
  const retryInfo = useMemo(
    () => (isLast ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );
  const retryMessage = useMemo(
    () => (isLast ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );

  // Cost info (only when not working)
  const costInfo = useMemo(
    () => (!working ? getTurnCost(allParts, pricingLookup) : undefined),
    [allParts, working, pricingLookup],
  );

  // Turn error — derived directly from message data (same approach as SolidJS reference).
  // Falls back to checking for dismissed question tool errors when no message-level error exists.
  const turnError = useMemo(() => {
    const msgError = getTurnError(turn);
    if (msgError) return msgError;
    // Check for dismissed question tool errors
    for (const msg of turn.assistantMessages) {
      for (const part of msg.parts) {
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool === 'question' && tool.state.status === 'error' && 'error' in tool.state) {
          return (tool.state as { error: string }).error.replace(/^Error:\s*/, '');
        }
      }
    }
    return undefined;
  }, [turn]);

  // The gateway's structured fields (provider/suggestion/request_id) for
  // `turnError`, when recoverable — lets TurnErrorDisplay render WHICH
  // provider failed and WHAT to do about it instead of only the raw message.
  const turnErrorDetails = useMemo(() => getTurnErrorDetails(turn), [turn]);

  // Shell mode detection
  const shellModePart = useMemo(() => getShellModePart(turn), [turn]);

  // Permission matching for this session (used for tool-level permission overlays)
  const nextPermission = useMemo(
    () => permissions.filter((p) => p.sessionID === sessionId)[0],
    [permissions, sessionId],
  );

  // Answered question parts — shown inline alongside streamed text.
  // Uses the optimisticAnswersCache as a fallback: when the user answers a
  // question we cache {answers, input} immediately. SSE message.part.updated
  // events can overwrite the tool part's state (wiping metadata.answers)
  // before the server has merged them. By checking the cache we guarantee
  // the answered card stays visible regardless of SSE timing.
  // Only skip tool parts whose callID matches a currently-pending question.
  const answeredQuestionParts = useMemo(() => {
    const pendingCallIds = new Set(
      questions
        .filter((q) => q.sessionID === sessionId)
        .map((q) => q.tool?.callID)
        .filter(Boolean),
    );

    // Collect ALL question tool parts first so we can determine which ones
    // were implicitly answered (i.e. the assistant continued past them).
    const questionInfos: {
      tool: ToolPart;
      msgId: string;
      msgIndex: number;
      partIndex: number;
    }[] = [];
    for (let mi = 0; mi < turn.assistantMessages.length; mi++) {
      const msg = turn.assistantMessages[mi];
      for (let pi = 0; pi < msg.parts.length; pi++) {
        const part = msg.parts[pi];
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool !== 'question') continue;
        questionInfos.push({
          tool,
          msgId: msg.info.id,
          msgIndex: mi,
          partIndex: pi,
        });
      }
    }

    const result: { part: ToolPart; messageId: string }[] = [];
    for (const qInfo of questionInfos) {
      const { tool, msgId, msgIndex, partIndex } = qInfo;

      // Check if there are subsequent parts/messages AFTER this question
      // in the turn. If the assistant continued, this question was answered.
      const hasSubsequentContent = (() => {
        // Check for later parts in the same message
        const msg = turn.assistantMessages[msgIndex];
        for (let pi = partIndex + 1; pi < msg.parts.length; pi++) {
          const p = msg.parts[pi];
          if (p.type === 'step-finish' || p.type === 'step-start') continue;
          return true;
        }
        // Check for later messages in the turn
        return msgIndex < turn.assistantMessages.length - 1;
      })();

      const isPending = pendingCallIds.has(tool.callID);

      // Skip only if it IS the currently-pending question AND there's no
      // evidence it was already answered (no subsequent content).
      if (isPending && !hasSubsequentContent) continue;

      const serverAnswers = (tool.state as any)?.metadata?.answers;
      const cached = optimisticAnswersCache.get(tool.id);
      const toolOutput = (tool.state as any)?.output as string | undefined;

      if (serverAnswers && serverAnswers.length > 0) {
        // Server has real answers — clean up cache if present
        if (cached) optimisticAnswersCache.delete(tool.id);
        result.push({ part: tool, messageId: msgId });
      } else if (cached) {
        // Server hasn't confirmed yet — use cached answers.
        // Build a synthetic tool part with the cached data so
        // AnsweredQuestionCard can render.
        const syntheticPart = {
          ...tool,
          state: {
            ...(tool.state as any),
            status: 'completed',
            input: cached.input,
            metadata: {
              ...((tool.state as any)?.metadata ?? {}),
              answers: cached.answers,
            },
          },
        } as unknown as ToolPart;
        result.push({ part: syntheticPart, messageId: msgId });
      } else if (toolOutput && hasSubsequentContent) {
        // Question was answered (output exists and assistant continued)
        // but metadata.answers was never set (e.g. after page reload).
        // Parse answers from the output string as a fallback.
        const parsed = parseAnswersFromOutput(toolOutput, (tool.state as any)?.input);
        if (parsed) {
          const syntheticPart = {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: {
                ...((tool.state as any)?.metadata ?? {}),
                answers: parsed,
              },
            },
          } as unknown as ToolPart;
          result.push({ part: syntheticPart, messageId: msgId });
        }
      } else if (!toolOutput && hasSubsequentContent) {
        // Question was implicitly answered (assistant continued past it)
        // but neither metadata.answers nor output is available.
        // Show a minimal answered card using the input questions
        // with placeholder answers extracted from context.
        const input = (tool.state as any)?.input;
        const questionsList: { question: string }[] = Array.isArray(input?.questions)
          ? input.questions
          : [];
        if (questionsList.length > 0) {
          const placeholderAnswers = questionsList.map(() => ['Answered']);
          const syntheticPart = {
            ...tool,
            state: {
              ...(tool.state as any),
              status: 'completed',
              metadata: {
                ...((tool.state as any)?.metadata ?? {}),
                answers: placeholderAnswers,
              },
            },
          } as unknown as ToolPart;
          result.push({ part: syntheticPart, messageId: msgId });
        }
      }
    }
    return result;
  }, [questions, sessionId, turn.assistantMessages]);
  const answeredQuestionIds = useMemo(
    () => new Set(answeredQuestionParts.map(({ part }) => part.id)),
    [answeredQuestionParts],
  );

  // Inline content parts — interleaves text and answered question parts in natural order.
  // When a turn contains answered questions, we need to render text and questions
  // in their original order rather than extracting the last text as a separate "response".
  // This works both during streaming and after completion so that answered questions
  // stay in the correct position while the AI continues responding.
  // Important: for question parts we use the (possibly synthetic) part from
  // answeredQuestionParts — NOT the raw store part — so that optimistic
  // answers from the cache are included even if the server hasn't confirmed yet.
  const answeredQuestionPartsById = useMemo(
    () => new Map(answeredQuestionParts.map(({ part }) => [part.id, part])),
    [answeredQuestionParts],
  );
  const inlineContentParts = useMemo(() => {
    if (answeredQuestionParts.length === 0) return null;
    const items: Array<
      | { type: 'text'; part: TextPart; id: string }
      | { type: 'question'; part: ToolPart; id: string }
    > = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        items.push({ type: 'text', part, id: part.id });
      } else if (
        isToolPart(part) &&
        part.tool === 'question' &&
        answeredQuestionPartsById.has(part.id)
      ) {
        // Use the answered part (may be synthetic with cached answers)
        items.push({
          type: 'question',
          part: answeredQuestionPartsById.get(part.id)!,
          id: part.id,
        });
      }
    }
    // Only use inline rendering if there are both text and question items
    const hasText = items.some((i) => i.type === 'text');
    const hasQuestion = items.some((i) => i.type === 'question');
    if (!hasText || !hasQuestion) return null;
    return items;
  }, [allParts, answeredQuestionPartsById, answeredQuestionParts.length]);
  const shouldUseInlineContent = !hasSteps && !!inlineContentParts;

  // Whether the user message has any visible content (non-synthetic, non-ignored
  // text, or attachments). Background task notifications inject synthetic-only
  // user messages that should not render a user bubble.
  // Extract session report from user message (if present)
  const sessionReport = useMemo<SessionReport | null>(() => {
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p)) {
        const report = extractSessionReport((p as TextPart).text || '');
        if (report) return report;
      }
    }
    return null;
  }, [turn.userMessage.parts]);
  const [sessionReportModalOpen, setSessionReportModalOpen] = useState(false);

  // Extract kortix_system messages for inline rendering (goal continuations, etc.)
  const systemMessages = useMemo<KortixSystemMessage[]>(() => {
    const msgs: KortixSystemMessage[] = [];
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p) && (p as TextPart).text) {
        msgs.push(...extractKortixSystemMessages((p as TextPart).text!));
      }
    }
    return msgs;
  }, [turn.userMessage.parts]);

  const hasVisibleUserContent = useMemo(() => {
    // Session reports render as their own card — don't show as user bubble
    if (sessionReport) return false;
    const parts = turn.userMessage.parts;
    // Parts not loaded yet (bridging / transient state) — assume visible
    // to prevent a flash where the bubble disappears momentarily.
    if (parts.length === 0) return true;
    // Has any non-synthetic, non-ignored text (including notification XML)?
    const hasVisibleText = parts.some(
      (p) =>
        isTextPart(p) &&
        !(p as TextPart).synthetic &&
        !(p as any).ignored &&
        !!stripKortixSystemTags((p as TextPart).text || '').trim(),
    );
    if (hasVisibleText) return true;
    // Has any attachment (image/PDF)?
    if (parts.some(isAttachment)) return true;
    // Has any agent part?
    if (parts.some(isAgentPart)) return true;
    return false;
  }, [turn.userMessage.parts, sessionReport]);

  // User message text — for copy action
  const userMessageText = useMemo(() => {
    const textParts = turn.userMessage.parts.filter(
      (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
    ) as TextPart[];
    return textParts
      .map((p) => stripSystemPtyText(p.text))
      .filter((t) => t.trim())
      .join('\n')
      .trim();
  }, [turn.userMessage.parts]);

  const commandForTurn = useMemo(() => {
    const mapped = commandMessages?.get(turn.userMessage.info.id);
    if (mapped) return mapped;
    if (!userMessageText) return undefined;
    return detectCommandFromText(userMessageText, commands);
  }, [commandMessages, turn.userMessage.info.id, userMessageText, commands]);

  // ---- Status throttling (2.5s) ----
  const lastStatusChangeRef = useRef(Date.now());
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
  const rawStatus = useMemo(
    () => getTurnStatus(allParts, childMessages),
    [allParts, childMessages],
  );
  const [throttledStatus, setThrottledStatus] = useState('');

  useEffect(() => {
    const newStatus = rawStatus;
    if (newStatus === throttledStatus || !newStatus) return;
    const elapsed = Date.now() - lastStatusChangeRef.current;
    if (elapsed >= 2500) {
      setThrottledStatus(newStatus);
      lastStatusChangeRef.current = Date.now();
    } else {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => {
        setThrottledStatus(getTurnStatus(allParts, childMessages));
        lastStatusChangeRef.current = Date.now();
      }, 2500 - elapsed);
    }
    return () => clearTimeout(statusTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParts, rawStatus, throttledStatus]);

  // ---- Retry countdown ----
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setRetrySecondsLeft(0);
      return;
    }
    const update = () =>
      setRetrySecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryInfo]);

  // ---- Duration ticking ----
  // Only a LIVE turn needs a clock. The old effect also ran for settled turns,
  // where it called setDuration on mount and forced every completed turn in the
  // transcript through a second render for a number that never changes. The
  // early return below is what removes that pass. A settled turn's duration is
  // now SessionTurnMeta's job, from turnDurationMs.
  const turnEndedAt = useMemo(() => sessionTurnEndedAt(turn), [turn]);
  const turnDurationMs = useMemo(() => sessionTurnDurationMs(turn), [turn]);
  const [liveDuration, setLiveDuration] = useState('');
  useEffect(() => {
    if (!working) return;
    const { startedAt } = sessionTurnSpan(turn);
    if (startedAt == null) return;
    const update = () => setLiveDuration(formatDuration(Date.now() - startedAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [working, turn]);

  // ---- Copy response ----
  const handleCopy = async () => {
    // When inline content is active, copy all text parts (not just the last one)
    const textToCopy = inlineContentParts
      ? inlineContentParts
          .filter((item) => item.type === 'text')
          .map((item) => (item.part as TextPart).text?.trim())
          .filter(Boolean)
          .join('\n\n')
      : response;
    if (!textToCopy) return;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Parts with a pending permission need a visible, actionable surface — they
  // must never fold into a collapsed burst. Answered questions get the same
  // standalone treatment for a different reason: they record a decision the
  // USER made, not agent activity, so the "collapse the agent's work into one
  // row" goal doesn't apply to them (they render via AnsweredQuestionCard, not
  // ToolPartRenderer — see the standalone branch below). Pending/dismissed
  // questions are deliberately NOT standalone: the real, actionable prompt for
  // a pending question lives in the composer (SessionChatInput's questionSlot),
  // which has the answer-reply plumbing this component doesn't; surfacing an
  // inert, answer-less card here would only be a confusing duplicate. Those
  // are filtered out of the turn body entirely below, matching the old
  // behaviour of rendering nothing for them in the steps list.
  // Computed before the early-return branches below so this hook always
  // runs in the same order, regardless of which branch this render takes.
  const standaloneCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const permission of permissions) {
      if (permission.sessionID === sessionId && permission.tool?.callID) {
        ids.add(permission.tool.callID);
      }
    }
    for (const { part } of answeredQuestionParts) {
      ids.add(part.callID);
    }
    return ids;
  }, [permissions, answeredQuestionParts, sessionId]);

  // ============================================================================
  // Shell mode — short-circuit rendering
  // ============================================================================

  if (shellModePart) {
    return (
      <div className="space-y-1">
        <ToolPartRenderer
          part={shellModePart}
          sessionId={sessionId}
          disableNavigation={disableToolNavigation}
          permission={nextPermission?.tool ? nextPermission : undefined}
          onPermissionReply={onPermissionReply}
          defaultOpen
        />
        {turnError && (
          <TurnErrorDisplay
            errorText={turnError}
            errorDetails={turnErrorDetails}
            className="mt-2"
          />
        )}
        <ConnectProviderDialog
          open={connectProviderOpen}
          onOpenChange={setConnectProviderOpen}
          providers={providers}
        />
      </div>
    );
  }

  // ============================================================================
  // Compaction mode — render as a distinct card, no user bubble / logo / steps
  // ============================================================================

  if (isCompaction && !working && response) {
    return (
      <div className="group/turn">
        <div className="border-border/60 bg-card/50 overflow-hidden rounded-2xl border">
          <div className="border-border/40 bg-muted/40 flex items-center gap-2 border-b px-4 py-2.5">
            <Layers className="text-muted-foreground/70 size-3.5" />
            <span className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
              Compaction
            </span>
          </div>
          <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 px-4 py-3 text-sm">
            <SandboxUrlDetector content={response} isStreaming={false} />
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Normal mode rendering — 1:1 port of SolidJS session-turn.tsx
  //
  // Structure:
  //   1. User message + actions
  //   2. Kortix logo
  //   3. Steps trigger (spinner/chevron + status + duration) — if working || hasSteps
  //   4. Collapsible steps (if expanded): all parts EXCEPT response part
  //   5. Answered question parts (if collapsed + has answered questions)
  //   6. Response section (ONLY when NOT working) — the extracted last text part
  //   7. Error (when steps collapsed)
  //   8. Question prompt
  //   9. Action bar (copy)
  //
  // The response (last text part) is NEVER rendered twice:
  //   - While working: it renders INSIDE steps as a regular text part (hideResponsePart=false)
  //   - When done: it's HIDDEN from steps (hideResponsePart=true) and shown below as Response
  // ============================================================================

  return (
    <div className="group/turn space-y-2.5">
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
            ownsPlan={ownsPlan}
            onRewind={onRewind}
            rewindDisabled={rewindDisabled}
          />
        </div>
      )}

      {/* ── Assistant parts content ──
			  Segments the turn into bursts (collapsed activity), standalone
			  parts (deliverables, sub-agents, and any part with a pending
			  permission or an active question), and text (prose between
			  bursts). Replaces the old same-tool / reasoning grouping — see
			  features/session/turn/segment-turn.ts.
			  Two part kinds are filtered out before segmentation:
			    - `todowrite` — the plan card beneath the user message is now
			      the single canonical todo surface; showing the same checklist
			      again inside a burst would just duplicate it.
			    - `question`: only answered questions are kept. Pending and
			      dismissed questions are dropped entirely. Additionally,
			      answered questions are dropped when rendering inline content
			      (below), since that mode shows them already, in natural order. */}
      {(working || hasSteps || hasReasoning) && turn.assistantMessages.length > 0 && (
        <div className="space-y-2">
          {segmentTurn(
            allParts
              .map(({ part }) => part)
              .filter((part) => {
                if (isToolPart(part) && part.tool === 'todowrite') return false;
                if (isToolPart(part) && part.tool === 'question') {
                  // Keep only answered questions, and only if not rendering inline
                  return answeredQuestionPartsById.has(part.id) && !shouldUseInlineContent;
                }
                return true;
              }),
            { standaloneCallIds },
          ).map((segment, index) => {
            if (segment.kind === 'burst') {
              return (
                <ActivityBurst
                  key={`burst-${segment.parts[0]?.id ?? index}`}
                  parts={segment.parts}
                  sessionId={sessionId}
                  working={working}
                  disableNavigation={disableToolNavigation}
                />
              );
            }

            if (segment.kind === 'standalone') {
              if (!shouldShowToolPart(segment.part)) return null;
              // Render answered questions via AnsweredQuestionCard instead of
              // ToolPartRenderer to avoid the "Question(s)" label and badge
              // from QuestionTool; answered cards show "Questions · N answered" instead.
              // Use the part from the map (may contain optimistically-cached answers).
              if (answeredQuestionPartsById.has(segment.part.id)) {
                const part = answeredQuestionPartsById.get(segment.part.id)!;
                return <AnsweredQuestionCard key={segment.part.id} part={part} />;
              }
              return (
                <ToolPartRenderer
                  key={segment.part.id}
                  part={segment.part}
                  sessionId={sessionId}
                  disableNavigation={disableToolNavigation}
                  permission={getPermissionForTool(permissions, segment.part.callID)}
                  onPermissionReply={onPermissionReply}
                />
              );
            }

            // Text segments render as prose between bursts. Text rendering
            // for no-step turns is handled below in the dedicated response
            // section, to avoid duplicate output.
            if (!hasSteps) return null;
            const text = segment.part.text?.trim();
            if (!text) return null;
            return (
              <div key={segment.part.id} className="min-w-0 text-sm">
                <ThrottledMarkdown content={text} isStreaming={working} />
              </div>
            );
          })}
        </div>
      )}

      {/* ── Screen reader ── */}
      <div className="sr-only" aria-live="polite">
        {!working && response ? response : ''}
      </div>

      {/* Inline content: text and answered questions rendered in natural order.
			    Works both during streaming and after completion. */}
      {working && !hasSteps && !shouldUseInlineContent && response && (
        <div className="min-w-0 text-sm">
          <ThrottledMarkdown content={response} isStreaming />
        </div>
      )}
      {shouldUseInlineContent ? (
        <div className="space-y-3">
          {(() => {
            // Find the last text item index — it might still be streaming
            let lastTextIdx = -1;
            if (working) {
              for (let i = inlineContentParts!.length - 1; i >= 0; i--) {
                if (inlineContentParts![i].type === 'text') {
                  lastTextIdx = i;
                  break;
                }
              }
            }
            return inlineContentParts!.map((item, idx) => {
              if (item.type === 'text') {
                const isStreaming = idx === lastTextIdx;
                const text = isStreaming ? item.part.text! : item.part.text!.trim();
                return (
                  <div key={item.id} className="min-w-0 text-sm">
                    {isStreaming ? (
                      <ThrottledMarkdown content={text} isStreaming />
                    ) : (
                      <SandboxUrlDetector content={text} isStreaming={false} />
                    )}
                  </div>
                );
              }
              return <AnsweredQuestionCard key={item.id} part={item.part} />;
            });
          })()}
        </div>
      ) : (
        <>
          {/* Response section for text-only turns (no tools/steps content) */}
          {!working &&
            !hasSteps &&
            response &&
            (commandForTurn ? (
              <div className="border-border/60 from-muted/15 to-background overflow-hidden rounded-2xl border bg-gradient-to-b">
                <div className="border-border/50 bg-muted/25 flex items-center gap-2 border-b px-3 py-2">
                  <Terminal className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-foreground font-mono text-xs">/{commandForTurn.name}</span>
                  {commandForTurn.args && (
                    <span className="text-muted-foreground truncate text-xs">
                      {commandForTurn.args}
                    </span>
                  )}
                </div>
                <div className="px-3 py-2.5 text-sm">
                  <SandboxUrlDetector content={response} isStreaming={false} />
                </div>
              </div>
            ) : (
              <div className="text-sm">
                <SandboxUrlDetector content={response} isStreaming={false} />
              </div>
            ))}

          {/* Answered question parts — shown after the response text only when
				    NONE of the upstream renderers fire. The steps section above is
				    gated by `working || hasSteps || hasReasoning`; if any of those
				    is true, the question parts have already been rendered inline
				    there as AnsweredQuestionCards. Mirroring that guard's inverse
				    here is the only way to avoid the double-render that showed up
				    on interrupted sessions that contained reasoning but no tool
				    steps (e.g. "Planning a process for questions" → user answers
				    → interrupt; hasSteps=false, working=false, hasReasoning=true,
				    and without the !hasReasoning check the card rendered twice). */}
          {!hasSteps && !working && !hasReasoning && answeredQuestionParts.length > 0 && (
            <div className="mt-3 space-y-2">
              {answeredQuestionParts.map(({ part }) => (
                <AnsweredQuestionCard key={part.id} part={part as ToolPart} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Working status indicator (always at the end while working) ── */}
      {working && (
        <div className="space-y-2">
          {retryInfo && retryMessage && (
            <SessionRetryDisplay
              message={retryMessage}
              attempt={retryInfo.attempt}
              secondsLeft={retrySecondsLeft}
            />
          )}
          <SessionBusyIndicator
            statusText={throttledStatus || undefined}
            retryLabel={
              retryInfo
                ? String(
                    tHardcodedUi.raw('componentsSessionSessionChat.line3820JsxTextWaitingToRetry'),
                  )
                : undefined
            }
          />
        </div>
      )}

      {/* ── Error (abort / failure banner) ── */}
      {turnError && <TurnErrorDisplay errorText={turnError} errorDetails={turnErrorDetails} />}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Action bar (copy + turn meta) ── */}
      {!working && response && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy response'}
          >
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? 'check' : 'copy'}
                  initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                  exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="absolute inset-0 inline-flex items-center justify-center"
                >
                  {copied ? (
                    <CheckIcon className="text-foreground size-4" />
                  ) : (
                    <Icon.Copy className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </Button>
          <SessionTurnMeta
            endedAt={turnEndedAt}
            durationMs={turnDurationMs}
            cost={costInfo}
            className="flex items-center justify-center"
          />
        </div>
      )}

      <ConnectProviderDialog
        open={connectProviderOpen}
        onOpenChange={setConnectProviderOpen}
        providers={providers}
      />
    </div>
  );
}

// ============================================================================
// Main SessionChat Component
// ============================================================================

interface SessionChatProps {
  sessionId: string;
  /** Durable Kortix project session id used by project-session APIs. */
  projectSessionId?: string;
  /** Complete SDK state for the root session. Omit for a read-only child session. */
  sessionState?: UseSessionResult;
  /** Project id lets agent pickers use the server-side project manifest/catalog. */
  projectId?: string;
  /** Immutable project-session agent. When set, prompts are locked to this agent. */
  boundAgentName?: string | null;
  /** Optional element rendered at the leading (left) edge of the session header */
  headerLeadingAction?: React.ReactNode;
  /** Hide the session site header entirely */
  hideHeader?: boolean;
  /** Read-only mode — hides the chat input bar (used for sub-session modal viewer) */
  readOnly?: boolean;
  /** Start scrolled to the top instead of the bottom (e.g. sub-session modal viewer) */
  initialScrollTop?: boolean;
}

export function SessionChat({
  sessionId,
  projectSessionId,
  sessionState,
  projectId,
  boundAgentName,
  headerLeadingAction,
  hideHeader,
  readOnly,
  initialScrollTop,
}: SessionChatProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const onboardingActive = useOnboardingModeStore((s) => s.active);
  const onboardingSessionId = useOnboardingModeStore((s) => s.sessionId);
  const disableToolNavigation = onboardingActive && onboardingSessionId === sessionId;
  // Every open session tab is pre-mounted at once (see layout-content.tsx), so
  // only the visible tab may be treated as "active" — otherwise every busy
  // session would react to global shortcuts (ESC-to-stop, auto question
  // handling) at the same time. The standalone project session route
  // (/projects/[id]/sessions/[sessionId]) mounts a single SessionChat whose id
  // is never registered in this tab store; there it's the only chat mounted, so
  // it's always active.
  //
  // Subscribe to the BOOLEAN result rather than the raw activeTabId value: a
  // tab switch then only re-renders the two sessions whose active state flips,
  // not every mounted SessionChat. This is what keeps tab switching 0-latency.
  const isActiveSessionTab = useTabStore((s) =>
    s.tabs[sessionId] ? s.activeTabId === sessionId : true,
  );

  // Clicking a tool call in the chat opens the side panel (Actions view)
  // focused on that tool's large preview — instead of expanding inline.
  const focusToolCall = useKortixComputerStore((s) => s.focusToolCall);
  const setSidePanelView = useSessionBrowserStore((s) => s.setView);
  const handleToolActivate = useCallback(
    (callID: string) => {
      // Telemetry honesty (MINOR SWEEP c): the panel's own chat-focus effect
      // (`easy-panel.tsx`) can't tell whether this open was fresh — by the
      // time that effect runs, `focusToolCall` has already flipped
      // `isSidePanelOpen` to true, so reading the store there always reports
      // "already open". This callback is the only point in the flow where
      // the PRE-open state is still observable, so the `panel_opened` event
      // is tracked here instead, gated on that read.
      const wasOpen = useKortixComputerStore.getState().isSidePanelOpen;
      setSidePanelView(sessionId, 'actions');
      focusToolCall(callID);
      if (!wasOpen) track('panel_opened', { source: 'chat_tool' });
    },
    [sessionId, setSidePanelView, focusToolCall],
  );
  const toolActivate = readOnly || disableToolNavigation ? null : handleToolActivate;

  // ---- Context modal ----
  const [contextModalOpen, setContextModalOpen] = useState(false);

  // ---- Question prompt ref + action state (for unified send button) ----
  const questionPromptRef = useRef<QuestionPromptHandle>(null);
  const [questionAction, setQuestionAction] = useState<{
    label: string | null;
    canAct: boolean;
  }>({ label: null, canAct: true });
  const handleQuestionActionChange = useCallback((action: QuestionAction, canAct: boolean) => {
    const label = action === 'next' ? 'Next' : action === 'submit' ? 'Submit' : null;
    setQuestionAction({ label, canAct });
  }, []);

  // ---- Reply-to state (text selection → reply) ----
  const [replyTo, setReplyTo] = useState<ReplyToContext | null>(null);
  const handleClearReply = useCallback(() => setReplyTo(null), []);

  // Floating "Reply" popup — shown near selected text in the chat area
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);

  // On mouseup inside the chat area, check for text selection
  const handleChatMouseUp = useCallback(() => {
    // Small delay so the selection is finalized
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const selectedText = sel?.toString().trim();
      if (!selectedText || selectedText.length < 2) {
        setSelectionPopup(null);
        return;
      }
      // Make sure the selection is inside the chat area
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

  // Dismiss popup on mousedown (new click) unless clicking the popup itself
  const handleChatMouseDown = useCallback((e: React.MouseEvent) => {
    // If clicking inside the popup, don't dismiss
    const target = e.target as HTMLElement;
    if (target.closest('[data-reply-popup]')) return;
    setSelectionPopup(null);
  }, []);

  // Dismiss popup on scroll
  const handleChatScroll = useCallback(() => {
    setSelectionPopup(null);
  }, []);

  // When user clicks "Reply" in the popup
  const handleSelectionReply = useCallback(() => {
    if (!selectionPopup) return;
    setReplyTo({ text: selectionPopup.text });
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionPopup]);

  // ---- KortixComputer side panel ----
  // No `isSidePanelOpen` subscription here any more. The header's toggle was
  // the only thing that needed it, and the chat was re-rendering in full on
  // every open and close of a panel beside it for a value it no longer reads.
  // The action panel column owns its own flag and subscribes to it itself.
  const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
  const openPreview = useFilePreviewStore((s) => s.openPreview);

  // ---- Hooks ----
  // runtimeReady gates the session query (it's disabled until the sandbox
  // runtime is connected + healthy). We need it here too so the render logic
  // can tell "still booting" apart from "genuinely gone".
  const runtimeReady = useRuntimeReady();
  const { data: session, isFetched: sessionFetched } = useRuntimeSession(sessionId);
  // useSessionSync is the SINGLE source of truth for messages (matches OpenCode SolidJS).
  // It fetches on first access, then SSE events keep it up to date.
  // No React Query fallback — prevents stale refetches from overwriting live data.
  const localSync = useSessionSync(sessionState ? '' : sessionId);
  const {
    messages: syncMessages,
    isLoading: syncMessagesLoading,
    hasOlder,
    isLoadingOlder,
    loadOlder,
  } = sessionState ?? localSync;
  const messages = syncMessages.length > 0 ? syncMessages : undefined;
  const messagesLoading = syncMessagesLoading;
  // Project sessions use the server-side project agent roster. Non-project
  // sessions fall back to OpenCode's directory-scoped runtime discovery.
  const { data: agents } = useRuntimeAgents({ directory: session?.directory, projectId });
  // Pending connector-approvals for this session pause the run — lock the
  // composer (like a question) until they're resolved. Shares the query key with
  // SessionApprovalPrompt, so it's one request.
  const approvalRouteParams = useParams<{ id?: string; sessionId?: string }>();
  const { data: approvalAudit } = useSessionAudit(
    projectId ?? approvalRouteParams.id,
    approvalRouteParams.sessionId,
    { refetchInterval: 5_000 },
  );
  const hasPendingApproval = (approvalAudit?.actions ?? []).some(isPendingAction);
  const { data: commands } = useRuntimeCommands();
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: allSessions } = useRuntimeSessions();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const abortSession = useAbortRuntimeSession();
  const executeCommand = useExecuteRuntimeCommand();

  // ---- Unified model/agent/variant state (1:1 port of SolidJS local.tsx) ----
  const local = useSessionModelSelection({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.open_code_default_agent,
  });
  // Session agent-lock is DISABLED (mirrors the backend KORTIX_ENFORCE_SESSION_AGENT_LOCK,
  // default off): the picker still defaults to the session's agent (seeded via
  // useRuntimeLocal's boundAgentName) but stays switchable — sends use the current
  // pick, not a forced lock. Flip to true to restore the hard lock once per-agent
  // executor-token scoping lands (see docs/specs/2026-06-28-agent-defaults-todo.md).
  const SESSION_AGENT_LOCK_ENABLED: boolean = false;
  const lockedAgentName = SESSION_AGENT_LOCK_ENABLED ? boundAgentName?.trim() || null : null;
  const localAgentSet = local.agent.set;
  const localModelCurrentKey = local.model.currentKey;
  // Wire model to SEND: `auto` when on the default (gateway resolves it), else
  // the explicit pick. Always send this — not currentKey, which is for display.
  const localModelSendKey = local.model.sendKey;
  const localModelList = local.model.list;
  const localModelSet = local.model.set;
  const localModelVisible = local.model.visible;
  const localVariantSet = local.model.variant.set;

  // Default the agent picker to whichever agent owns the latest assistant
  // turn in this session. Catches PM onboarding sessions (first turn was PM),
  // "Ask PM" sessions, team-agent ticket sessions, etc. — without relying on
  // title patterns. Falls through if there's no assistant msg yet.
  const defaultedAgentRef = useRef(false);
  useEffect(() => {
    if (defaultedAgentRef.current) return;
    if (!messages || messages.length === 0) return;
    let lastAgent: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info as any;
      if (info?.role === 'assistant' && info?.agent) {
        lastAgent = info.agent as string;
        break;
      }
    }
    if (!lastAgent) return;
    const agentEntry = local.agent.list.find((a: any) => a?.name === lastAgent);
    if (!agentEntry) return;
    if (local.agent.current?.name !== lastAgent) {
      local.agent.set(lastAgent);
    }
    defaultedAgentRef.current = true;
  }, [messages, local.agent]);

  const pendingPromptHandled = useRef(false);

  // ---- Polling fallback & optimistic send ----
  const [pollingActive, setPollingActive] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<{
    name: string;
    description?: string;
  } | null>(null);
  const [commandError, setCommandError] = useState<KortixSendError | null>(null);
  // The last prompt handed to the runtime, verbatim. Only read by the
  // connector-refusal card, to re-send exactly what was refused.
  const lastSubmittedRef = useRef<{ parts: unknown[]; options: Record<string, unknown> } | null>(
    null,
  );
  const [failedStartDraft, setFailedStartDraft] = useState<{
    text: string;
    files: AttachedFile[];
    id: number;
  } | null>(null);
  const [rewindTarget, setRewindTarget] = useState<{
    messageId: string;
    text: string;
  } | null>(null);
  const [rewindDraft, setRewindDraft] = useState<{
    text: string;
    id: number;
  } | null>(null);
  const rewindPrefillId = useRef(0);
  // "Ask for changes" (W12) — a deliverable's toolbar can hand the composer a
  // starter line. Held (not one-shot) in the store; the composer's own
  // `prefill.id` effect below is what makes application happen exactly once.
  const sessionPrefill = useSessionPrefill(sessionId);
  // Held (not consumed) by the store so a fresh id always reaches the
  // composer's own id-keyed effect — but held forever ghosts stale text back
  // in on a later remount (tab switch, panel toggle): SessionChatInput's
  // prefill effect runs before this one in the same commit (child before
  // parent), so the text has already landed by the time we clear it here.
  useEffect(() => {
    if (sessionPrefill) useSessionComposerPrefillStore.getState().clearPrefill(sessionId);
  }, [sessionPrefill, sessionId]);
  // Map of user message IDs → command info, so UserMessage can render
  // a compact command pill instead of the raw expanded template text.
  const commandMessagesRef = useRef<Map<string, { name: string; args?: string }>>(new Map());
  // Stash the pending command info so we can associate it with the user message
  // even if the busy signal arrives before the message list updates.
  const pendingCommandStashRef = useRef<{ name: string; args?: string } | null>(null);
  // Track whether a pending prompt send is in flight (dashboard→session flow).
  // Keeps isBusy true until the server acknowledges with a busy status.
  const [pendingSendInFlight, setPendingSendInFlight] = useState(false);
  const [pendingSendMessageId, setPendingSendMessageId] = useState<string | null>(null);
  // Grace period: don't stop polling immediately on idle after a recent send
  const lastSendTimeRef = useRef<number>(0);
  // ---- Optimistic prompt (from dashboard/project page) ----
  // Backed by the SDK's start-stash (`readStartStash`/`clearStartStash`), which
  // understands both the modern `kortix:start:<id>` shape and every legacy
  // producer's bare `opencode_pending_prompt:<id>` + `opencode_pending_options:<id>`
  // pair — so pushState navigation still works with no `?new=true` dependency,
  // and no web code needs to know the storage key names directly.
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return readStartStash(sessionId)?.prompt ?? null;
    }
    return null;
  });

  // Hydrate options from the SDK's start-stash and send the pending prompt for
  // new sessions. The dashboard/project page (or the instant session shell)
  // stashes the prompt and navigates here. We send the message from here (not
  // the producer) so that SSE listeners and polling are already active when the
  // response starts streaming back.
  //
  // The write-race retry (stash read), readiness poll (agent/model), and
  // failure-recovery (stash restore + classify + idle + rehydrate-or-remove)
  // mechanics are all owned by the SDK's `replayStartStash` — this effect only
  // supplies the web-specific pieces: resolving agent/model/variant readiness
  // against this session's own local model/agent stores, building the
  // optimistic text + outgoing parts (file uploads), and restoring pending
  // files on failure.
  useEffect(() => {
    if (pendingPromptHandled.current) return;

    // Set by `prepare` below (once, before any failure can occur) so
    // `onFailure` can restore the same files it consumed.
    let filesToRestoreOnFailure: AttachedFile[] = [];

    const handle = replayStartStash<{ options: Record<string, unknown> }>({
      sessionId,
      classify: classifySessionError,
      checkReadiness: (stash) => {
        // Restore agent/model/variant selections from the producer.
        const options: Record<string, unknown> = {};
        let selectedModelForSend: ModelKey | undefined;
        const isSelectableModel = (model: ModelKey): boolean =>
          localModelList.some(
            (m) => m.providerID === model.providerID && m.modelID === model.modelID,
          ) && localModelVisible(model);
        if (stash.agent) {
          if (!lockedAgentName || stash.agent === lockedAgentName) {
            options.agent = stash.agent;
            localAgentSet(stash.agent);
          }
        }
        if (stash.model && isSelectableModel(stash.model as ModelKey)) {
          options.model = stash.model;
          selectedModelForSend = stash.model as ModelKey;
          localModelSet(stash.model as ModelKey);
        }
        if (stash.variant) {
          options.variant = stash.variant;
          localVariantSet(stash.variant);
        }
        if (lockedAgentName) {
          options.agent = lockedAgentName;
        }
        if (!selectedModelForSend && localModelSendKey) {
          options.model = localModelSendKey;
          selectedModelForSend = localModelSendKey;
        }
        if (!selectedModelForSend) return null;
        return { options };
      },
      onReadinessTimeout: () => {
        setCommandError({
          kind: 'runtime-error',
          message: NO_MODEL_AVAILABLE_MESSAGE,
          cause: null,
        });
      },
      prepare: (stash, ready) => {
        pendingPromptHandled.current = true;
        setPollingActive(true);
        setPendingSendInFlight(true);
        clearStartStash(sessionId);

        const sendOpts = ready.options as {
          agent?: string;
          model?: ModelKey;
          variant?: string;
        };
        const messageID = ascendingId('msg');
        const textPartId = ascendingId('prt');
        // Consume pending files before rendering the optimistic message so
        // uploaded file cards are visible while the sandbox is still starting.
        const pendingFiles = usePendingFilesStore.getState().consumePendingFiles();
        filesToRestoreOnFailure = pendingFiles;
        const optimisticPendingPrompt = buildOptimisticPromptTextWithUploads(
          stash.prompt,
          pendingFiles,
        );
        setOptimisticPrompt(optimisticPendingPrompt);
        setPendingSendMessageId(messageID);
        lastSendTimeRef.current = Date.now();

        return {
          messageId: messageID,
          optimisticText: optimisticPendingPrompt,
          partIds: [textPartId],
          sendOptions: {
            ...(session?.directory ? { directory: session.directory } : {}),
            ...(sendOpts?.agent && { agent: sendOpts.agent }),
            ...(sendOpts?.model && { model: formatPromptModel(sendOpts.model) }),
            ...(sendOpts?.variant && { variant: sendOpts.variant }),
          },
          // Upload local files and build the parts array (text + file refs).
          buildParts: async () => {
            const built = await buildPromptPartsWithUploads(stash.prompt, pendingFiles, uploadFile);
            return [{ type: 'text' as const, text: built.text }, ...built.remoteParts];
          },
        };
      },
      onFailure: (stash, _err, classified) => {
        setPendingSendInFlight(false);
        setPendingSendMessageId(null);
        setOptimisticPrompt(null);
        setPollingActive(false);
        setCommandError(classified);
        usePendingFilesStore.getState().setPendingFiles(filesToRestoreOnFailure);
        // replayStartStash restores durable sessionStorage itself. Rehydrate the
        // visible composer too, so the user can retry immediately without a
        // reload and without losing either the prompt or local File objects.
        setFailedStartDraft({
          text: stash.prompt,
          files: filesToRestoreOnFailure,
          id: Date.now(),
        });
      },
      onSuccess: () => {
        if (!projectId || !projectSessionId) return;
        void updateProjectSession(projectId, projectSessionId, {
          metadata: { pending_prompt: null },
        }).catch((error) => {
          console.warn('[session-chat] failed to clear the acknowledged pending prompt', error);
        });
      },
    });

    return () => handle.cancel();
  }, [
    sessionId,
    localAgentSet,
    localModelCurrentKey,
    localModelSendKey,
    localModelList,
    localModelSet,
    localModelVisible,
    localVariantSet,
    lockedAgentName,
    projectId,
    projectSessionId,
    session?.directory,
  ]);

  // Clear optimistic prompt once real messages arrive
  useEffect(() => {
    if (optimisticPrompt && messages && messages.length > 0) {
      setOptimisticPrompt(null);
    }
  }, [optimisticPrompt, messages]);

  const agentNames = useMemo(() => local.agent.list.map((a) => a.name), [local.agent.list]);

  // ---- Check if any messages have tool calls ----
  // ---- Restore model/agent from last user message ----
  // Seeds agent/model from the last user message ONLY if there's no per-session
  // selection yet. This handles opening a session for the first time. If the user
  // already changed the model in this session (persisted per-session in localStorage),
  // we don't overwrite it — the per-session selection takes priority via the
  // resolution chain in useRuntimeLocal.
  const lastUserMessage = useMemo(
    () => (messages ? [...messages].reverse().find((m) => m.info.role === 'user') : undefined),
    [messages],
  );
  const lastUserMsgIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!lastUserMessage) return;
    if (lastUserMsgIdRef.current === lastUserMessage.info.id) return;
    lastUserMsgIdRef.current = lastUserMessage.info.id;
    const msg = lastUserMessage.info as any;
    if (msg.agent) local.agent.set(msg.agent);
    // Only seed model from message if the user hasn't already made a per-session
    // selection (e.g. changed the model after the last message, then reloaded).
    // The per-session model is checked first in the resolution chain, so we only
    // need to seed it here when it's empty (first open of this session).
    if (!local.model.hasSessionModel) {
      const parsedModel = parseModelKey(msg.model);
      if (parsedModel) local.model.set(parsedModel, { autoSeed: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserMessage?.info.id]);

  // ---- Session status ----
  // Use sync store as primary (matches OpenCode), fall back to status store
  const syncStatus = useSessionStateStore((s) => s.sessionStatus[sessionId]);
  const isOptimisticCompacting = sessionState?.isCompacting ?? false;
  const sessionStatus = sessionState?.status ?? syncStatus;
  const isServerBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  // Pending: last assistant message has no time.completed.
  // Used as a SECONDARY signal — only contributes to busy when the
  // server also says busy. Prevents the event-ordering race where
  // session.idle arrives before message.updated sets time.completed.
  const hasIncompleteAssistant = useMemo(() => {
    if (!messages || messages.length === 0) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'assistant') {
        return !(messages[i].info as any).time?.completed;
      }
    }
    return false;
  }, [messages]);

  const hasPendingUserReply = useMemo(() => {
    if (!messages || messages.length === 0) return false;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return false;
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      if (messages[i].info.role === 'assistant') return false;
    }
    return true;
  }, [messages]);

  // Matching the reference: session status is the PRIMARY source of truth.
  // hasIncompleteAssistant only matters while the server also says busy
  // (prevents the idle→incomplete race). pendingSendInFlight covers the
  // gap between user send and server ack.
  const effectiveBusy = isServerBusy || pendingSendInFlight || isOptimisticCompacting;

  // Short visual fade (300ms) — matches the reference's 260ms delay-hide.
  // Goes true immediately, stays visible briefly after going idle so the
  // UI doesn't flicker between agentic steps. NOT a 2s debounce.
  const [isBusy, setIsBusy] = useState(effectiveBusy);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (effectiveBusy) {
      clearTimeout(busyTimerRef.current);
      setIsBusy(true);
    } else {
      busyTimerRef.current = setTimeout(() => setIsBusy(false), 300);
    }
    return () => clearTimeout(busyTimerRef.current);
  }, [effectiveBusy]);

  const expectAssistantResponse =
    isServerBusy ||
    hasPendingUserReply ||
    (isServerBusy && hasIncompleteAssistant) ||
    pendingSendInFlight;

  const shouldRecoveryPoll = expectAssistantResponse;

  const streamCacheKey = `opencode_stream_cache:${sessionId}`;
  const streamCacheRestoredRef = useRef<string | null>(null);

  // Restore cached streaming prefix after refresh when SSE resumes from the
  // current point but backend hydrate has not yet returned the in-progress text.
  // Runs at most once per cache key to prevent re-triggering when the store
  // update causes `messages` to change (which would re-fire this effect).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!shouldRecoveryPoll) return;
    if (!messages || messages.length === 0) return;

    let cached: {
      messageID: string;
      parentID?: string;
      partID: string;
      text: string;
      updatedAt: number;
    } | null = null;
    try {
      const raw = sessionStorage.getItem(streamCacheKey);
      cached = raw ? JSON.parse(raw) : null;
    } catch {
      cached = null;
    }
    if (!cached || !cached.messageID || !cached.partID || !cached.text) return;
    // Ignore stale cache entries.
    if (Date.now() - (cached.updatedAt || 0) > 30 * 60 * 1000) return;
    // Prevent re-running after a successful restore for this exact cache entry.
    const cacheFingerprint = `${cached.messageID}:${cached.partID}:${cached.text.length}`;
    if (streamCacheRestoredRef.current === cacheFingerprint) return;

    const store = useSessionStateStore.getState();
    const currentMsgs = store.getMessages(sessionId);
    let latestUserId: string | undefined;
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      if (currentMsgs[i].info.role === 'user') {
        latestUserId = currentMsgs[i].info.id;
        break;
      }
    }
    if (hasPendingUserReply) {
      // For a fresh pending turn we must have an exact parent match.
      // If cached parentID is missing or mismatched, the cache likely
      // belongs to an older turn and would prepend stale mid-stream text.
      if (!cached.parentID || !latestUserId || cached.parentID !== latestUserId) {
        return;
      }
    }
    const hasMsg = currentMsgs.some((m) => m.info.id === cached!.messageID);
    const hasAnyUser = currentMsgs.some((m) => m.info.role === 'user');

    if (!hasMsg) {
      // Only create a synthetic assistant message if we can safely attach
      // it to an existing user turn.
      if (!hasAnyUser) return;
      const parentID = cached.parentID ?? latestUserId;
      if (hasPendingUserReply && !parentID) return;
      if (parentID) {
        const parentExists = currentMsgs.some((m) => m.info.id === parentID);
        if (!parentExists) return;
      }
      store.upsertMessage(sessionId, {
        id: cached.messageID,
        sessionID: sessionId,
        role: 'assistant',
        parentID,
      } as any);
    }

    const currentParts = store.parts[cached.messageID] ?? [];
    const existing = currentParts.find((p) => p.id === cached!.partID) as any;
    const existingText = typeof existing?.text === 'string' ? existing.text : '';
    if (cached.text.length <= existingText.length) {
      // Already restored or surpassed — mark as done.
      streamCacheRestoredRef.current = cacheFingerprint;
      return;
    }

    streamCacheRestoredRef.current = cacheFingerprint;
    store.upsertPart(cached.messageID, {
      ...(existing ?? {}),
      id: cached.partID,
      messageID: cached.messageID,
      sessionID: sessionId,
      type: 'text',
      text: cached.text,
    } as any);
  }, [messages, sessionId, shouldRecoveryPoll, streamCacheKey, hasPendingUserReply]);

  // Client-side message queue — mirrors Claude Code / Codex: a message typed
  // while the agent is mid-turn is held here instead of being sent straight
  // through (the OpenCode server would happily accept it immediately, but
  // interleaving it into a live turn reads badly). It's flushed one at a time
  // at the next safe boundary: either a tool call finishing, or the turn
  // going idle. See SessionChatInput.handleSubmit → onQueueMessage, and the
  // drain effect below.
  // Seeded with anything queued in the instant shell while the computer was
  // still booting (same handoff lifecycle as pending-files-store) — the drain
  // effect below flushes it once the auto-sent first prompt hits a boundary.
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  useEffect(() => {
    const pendingMessages = usePendingQueueStore.getState().consumePendingQueue();
    if (pendingMessages.length === 0) return;

    // The instant-shell messages predate messages queued after this component
    // commits, so retain their position at the front of the queue.
    setQueuedMessages((currentMessages) => [...pendingMessages, ...currentMessages]);
  }, []);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);
  // Local, never-sent-to-server counter — separate from `ascendingId`, whose
  // prefix union ('msg' | 'prt') is meaningful for server-compatible message
  // ordering and shouldn't grow a prefix for a purely client-side draft id.
  const queuedIdCounterRef = useRef(0);

  const handleQueueMessage = useCallback(
    (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => {
      const id = `queued-${++queuedIdCounterRef.current}`;
      setQueuedMessages((prev) => [...prev, { id, text, files, mentions }]);
    },
    [],
  );

  const handleRemoveQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Stop polling when session goes idle (via SSE or polling fallback).
  // Grace period: if we sent a message recently (within 5s), don't stop polling
  // on the first idle status — the server may not have started processing yet.
  useEffect(() => {
    if (pollingActive && sessionStatus?.type === 'idle') {
      const timeSinceSend = Date.now() - lastSendTimeRef.current;
      if (timeSinceSend < 5000) {
        // Still within grace period — check again shortly
        const remaining = 5000 - timeSinceSend;
        const timer = setTimeout(() => {
          // Re-check: if still idle after grace period, stop polling
          const currentStatus = useSessionStateStore.getState().sessionStatus[sessionId];
          if (currentStatus?.type === 'idle') {
            setPollingActive(false);
          }
        }, remaining);
        return () => clearTimeout(timer);
      }
      setPollingActive(false);
    }
  }, [pollingActive, sessionStatus?.type, sessionId]);

  // Clear pendingSendInFlight once the server acknowledges it's working,
  // or when new messages arrive (fallback for command sends).
  // This bridges the gap between the optimistic prompt clearing and the
  // server status updating — keeps isBusy true so the turn shows a loader.
  useEffect(() => {
    if (!pendingSendInFlight) return;
    if (isServerBusy) {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
      return;
    }
    // If we got an assistant reply for the pending user message, the server
    // already accepted and processed this send even if status events were missed.
    const hasAssistantReply = pendingSendMessageId
      ? !!messages?.some(
          (m) => m.info.role === 'assistant' && (m.info as any).parentID === pendingSendMessageId,
        )
      : false;
    if (hasAssistantReply) {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
    }
  }, [pendingSendInFlight, isServerBusy, messages, pendingSendMessageId]);

  // Safety timeout: clear pendingSendInFlight after 30s even if the server
  // never acknowledged. Prevents the UI from being stuck forever in "busy"
  // when the send succeeded (HTTP 204) but the server never started processing.
  useEffect(() => {
    if (!pendingSendInFlight) return;
    const timer = setTimeout(() => {
      setPendingSendInFlight(false);
      setPendingSendMessageId(null);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [pendingSendInFlight]);

  // SSE + heartbeat timeout is the source of truth for streaming state.
  // No watchdogs, no polling, no reconcilers — matching the reference.

  // Clear pending user message when we can confirm the message is in cache
  // (by ID), or when new messages arrive (fallback for command sends).
  // When a command was pending, associate the newest user message with the
  // command info so UserMessage can render a nice pill instead of raw template text.
  const prevMsgLenRef = useRef(messages?.length || 0);
  useEffect(() => {
    if (!pendingUserMessage) return;
    const hasPendingMessage = pendingUserMessageId
      ? !!messages?.some((m) => m.info.id === pendingUserMessageId)
      : false;
    if (hasPendingMessage) {
      setPendingUserMessage(null);
      setPendingUserMessageId(null);
      setPendingCommand(null);
      return;
    }
    const len = messages?.length || 0;
    if (len > prevMsgLenRef.current) {
      setPendingUserMessage(null);
      setPendingUserMessageId(null);
      setPendingCommand(null);
    }
  }, [messages, messages?.length, pendingUserMessage, pendingUserMessageId]);

  // Associate stashed command info with the newest user message when messages arrive.
  // Runs separately so it captures the mapping even if busy fires before messages update.
  useEffect(() => {
    const stash = pendingCommandStashRef.current;
    if (!stash || !messages) return;
    const len = messages.length;
    if (len <= prevMsgLenRef.current) return;
    // Find the last user message — the one just created by the command
    for (let i = len - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') {
        commandMessagesRef.current.set(messages[i].info.id, stash);
        pendingCommandStashRef.current = null;
        break;
      }
    }
  }, [messages]);

  useEffect(() => {
    prevMsgLenRef.current = messages?.length || 0;
  }, [messages?.length]);

  // ---- Auto-scroll (replaces inline scroll logic) ----
  const hasActiveQuestion = useRuntimePendingStore((s) =>
    Object.values(s.questions).some((q) => q.sessionID === sessionId),
  );
  const messageCount = messages?.length ?? 0;
  const {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToBottom,
    scrollToLastTurn,
    scrollToEnd,
    scrollToAbsoluteBottom,
    smoothScrollToAbsoluteBottom,
  } = useAutoScroll({
    working: isBusy && !hasActiveQuestion,
    hasContent: messageCount > 0,
  });
  // Older history loads by scrolling, not by clicking: a sentinel above the
  // first turn pulls the previous page as it nears the top of the viewport.
  // A pull always prepends content above the reader, so every one is wrapped
  // in the turn anchor — capture where the topmost visible turn sits, restore
  // it after the prepended turns render, and the viewport never jumps.
  const [olderPullFailed, setOlderPullFailed] = useState(false);
  useEffect(() => {
    setOlderPullFailed(false);
  }, [sessionId]);
  const handleLoadOlder = useCallback(async () => {
    const node = scrollRef.current;
    const anchor = node ? captureTurnScrollAnchor(node) : null;
    try {
      await loadOlder();
      setOlderPullFailed(false);
    } catch {
      // Surface a retry instead of letting the sentinel re-arm into a loop.
      setOlderPullFailed(true);
    }
    if (!node) return;
    requestAnimationFrame(() => {
      restoreTurnScrollAnchor(node, anchor);
    });
  }, [loadOlder, scrollRef]);
  const olderSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = olderSentinelRef.current;
    if (!node || !hasOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          shouldLoadOlderHistory({
            isIntersecting: !!entry?.isIntersecting,
            hasOlder,
            isLoadingOlder,
            lastPullFailed: olderPullFailed,
          })
        ) {
          void handleLoadOlder();
        }
      },
      // Pull before the reader reaches the top so history is already there.
      { root: scrollRef.current, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // sessionId is a dep because switching sessions swaps the scroll
    // container the observer is rooted in.
  }, [hasOlder, isLoadingOlder, olderPullFailed, handleLoadOlder, scrollRef, sessionId]);

  // Scroll to the bottom on initial load / session change.
  // Uses a callback ref on the scroll container to guarantee it's mounted.
  // Strategy: start scrolled to ~90% instantly (no flash at top), then
  // smooth-scroll the last bit once content has rendered for a nice effect.
  const initialScrollDoneRef = useRef<string | null>(null);
  const scrollContainerCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Always keep scrollRef updated
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (!node) return;
      if (initialScrollDoneRef.current === sessionId) return;
      initialScrollDoneRef.current = sessionId;

      // When viewing a sub-session from the top, don't scroll to bottom
      if (initialScrollTop) {
        node.scrollTop = 0;
        return;
      }

      // Instant scroll to near-bottom so user doesn't see top-of-page flash.
      // Position slightly above the bottom so the smooth scroll has room to animate.
      const scrollNearBottom = () => {
        const max = node.scrollHeight - node.clientHeight;
        node.scrollTop = Math.max(0, max - 300);
      };
      scrollNearBottom();

      // After content settles, smooth scroll the final stretch to the bottom.
      setTimeout(() => {
        node.scrollTo({
          top: node.scrollHeight - node.clientHeight,
          behavior: 'smooth',
        });
      }, 150);
      // Follow-up in case async content changed scrollHeight
      setTimeout(() => {
        node.scrollTo({
          top: node.scrollHeight - node.clientHeight,
          behavior: 'smooth',
        });
      }, 600);
    },
    [sessionId, scrollRef, initialScrollTop],
  );

  // Tab switch: the DOM stays mounted (hidden class), so the browser
  // preserves scroll position automatically. No action needed here.

  // ---- Pending permissions & questions ----
  const allPermissions = useRuntimePendingStore((s) => s.permissions);
  const allQuestions = useRuntimePendingStore((s) => s.questions);
  const pendingPermissions = useMemo(
    () =>
      sessionState?.permissions ??
      Object.values(allPermissions).filter((p) => p.sessionID === sessionId),
    [sessionState?.permissions, allPermissions, sessionId],
  );
  const suppressedQuestionIdsRef = useRef<Map<string, number>>(new Map());
  const suppressQuestionFor = useCallback((requestId: string, ms = 15000) => {
    suppressedQuestionIdsRef.current.set(requestId, Date.now() + ms);
  }, []);
  const isQuestionSuppressed = useCallback((requestId: string) => {
    const expiresAt = suppressedQuestionIdsRef.current.get(requestId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      suppressedQuestionIdsRef.current.delete(requestId);
      return false;
    }
    return true;
  }, []);
  const pendingQuestions = useMemo(
    () =>
      (
        sessionState?.questions ??
        Object.values(allQuestions).filter((q) => q.sessionID === sessionId)
      ).filter((q) => !isQuestionSuppressed(q.id)),
    [sessionState?.questions, allQuestions, sessionId, isQuestionSuppressed],
  );
  const QUESTION_PROMPT_ANIMATION_MS = 320;
  const activePendingQuestion = pendingQuestions[0] ?? null;
  const [renderedQuestion, setRenderedQuestion] = useState<QuestionRequest | null>(null);
  const [questionPromptVisible, setQuestionPromptVisible] = useState(false);
  const questionPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const nextQuestion = activePendingQuestion;

    if (questionPromptTimerRef.current) {
      clearTimeout(questionPromptTimerRef.current);
      questionPromptTimerRef.current = null;
    }

    if (nextQuestion) {
      setRenderedQuestion(nextQuestion);
      requestAnimationFrame(() => setQuestionPromptVisible(true));
      return;
    }

    setQuestionPromptVisible(false);
    questionPromptTimerRef.current = setTimeout(() => {
      setRenderedQuestion(null);
      questionPromptTimerRef.current = null;
    }, QUESTION_PROMPT_ANIMATION_MS);
  }, [activePendingQuestion]);

  useEffect(() => {
    return () => {
      if (questionPromptTimerRef.current) {
        clearTimeout(questionPromptTimerRef.current);
      }
    };
  }, []);
  const turns = useMemo(() => (messages ? groupMessagesIntoTurns(messages) : []), [messages]);
  const hasAnyMessages = turns.length > 0;
  const hasChatContent = hasAnyMessages || (!!optimisticPrompt && !hasAnyMessages);
  // Full-bleed wallpaper layer mounted by SessionLayout (null on mobile /
  // standalone). When present, the welcome wallpaper is portaled into it so it
  // spans the entire session width instead of shrinking with the chat panel.
  const wallpaperLayer = useSessionWallpaperLayer();
  const WELCOME_FADE_MS = 900;
  const [welcomeFadeActive, setWelcomeFadeActive] = useState(false);
  const welcomeFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevHasChatContentRef = useRef(hasChatContent);
  useEffect(() => {
    const hadContent = prevHasChatContentRef.current;
    if (!hadContent && hasChatContent) {
      setWelcomeFadeActive(true);
      if (welcomeFadeTimerRef.current) {
        clearTimeout(welcomeFadeTimerRef.current);
      }
      welcomeFadeTimerRef.current = setTimeout(() => {
        setWelcomeFadeActive(false);
        welcomeFadeTimerRef.current = null;
      }, WELCOME_FADE_MS + 120);
    }
    if (!hasChatContent) {
      setWelcomeFadeActive(false);
    }
    prevHasChatContentRef.current = hasChatContent;
  }, [hasChatContent]);

  useEffect(() => {
    return () => {
      if (welcomeFadeTimerRef.current) {
        clearTimeout(welcomeFadeTimerRef.current);
      }
    };
  }, []);
  // Self-heal a missed `question.asked` SSE event (a `question` tool part
  // rendering as running with nothing in the pending store for this session) —
  // see the SDK's `useQuestionSelfHeal` for why this poll is distinct from
  // `useRuntimeEventStream`'s reconnect-gap hydration.
  useQuestionSelfHeal(sessionId, messages, {
    enabled: !sessionState && isActiveSessionTab,
    isSuppressed: isQuestionSuppressed,
  });
  // The permission twin — a missed `permission.asked` frame otherwise leaves
  // the agent silently blocked with no card to answer (the "have to type
  // `continue`" wedge).
  usePermissionSelfHeal(sessionId, messages, {
    enabled: !sessionState && isActiveSessionTab,
  });

  // ---- Permission/question reply handlers ----
  const removePermission = useRuntimePendingStore((s) => s.removePermission);
  const removeQuestion = useRuntimePendingStore((s) => s.removeQuestion);

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject') => {
      // No optimistic remove: only drop the card once the runtime accepted the
      // reply — a failed reply must stay answerable. Rethrow so callers
      // (prompt buttons) reset their busy state and surface the error.
      if (sessionState) {
        await sessionState.answerPermission(requestId, reply);
      } else {
        await replyToPermission(requestId, reply);
        removePermission(requestId);
      }
    },
    [sessionState, removePermission],
  );

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      // Snapshot the question BEFORE removing it so we can cache the
      // answer against the tool part's ID.
      const questionReq =
        sessionState?.questions.find((question) => question.id === requestId) ??
        useRuntimePendingStore.getState().questions[requestId];

      suppressQuestionFor(requestId);
      // Optimistically remove the question so the textarea shows immediately
      removeQuestion(requestId);

      // Save the answers in the optimistic cache keyed by the tool part ID.
      // This cache survives SSE message.part.updated events that may
      // overwrite the tool part before the server includes metadata.answers.
      // answeredQuestionParts reads from this cache as a fallback.
      if (questionReq?.tool?.messageID) {
        const { messageID } = questionReq.tool;
        const parts = useSessionStateStore.getState().parts[messageID];
        if (parts) {
          const match = parts.find(
            (p) =>
              p.type === 'tool' &&
              (p as ToolPart).tool === 'question' &&
              (p as ToolPart).callID === questionReq.tool!.callID,
          );
          if (match) {
            optimisticAnswersCache.set(match.id, {
              answers,
              input: ((match as ToolPart).state?.input as Record<string, unknown>) ?? {},
            });
          }
        }
      }

      try {
        if (sessionState) await sessionState.answerQuestion(requestId, answers);
        else await replyToQuestion(requestId, answers);
      } catch {
        // ignore — SSE "question.replied" event will also remove it
      }
    },
    [sessionState, removeQuestion, suppressQuestionFor],
  );

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      suppressQuestionFor(requestId);
      // Optimistically remove the question so the textarea shows immediately
      removeQuestion(requestId);
      try {
        if (sessionState) await sessionState.rejectQuestion(requestId);
        else await rejectQuestion(requestId);
      } catch {
        // ignore — SSE "question.rejected" event will also remove it
      }
      // Also abort the session so the "The operation was aborted." banner appears
      if (sessionState) {
        sessionState.cancel();
      } else if (!abortSession.isPending) {
        abortSession.mutate(sessionId);
      }
    },
    [sessionState, removeQuestion, abortSession, sessionId, suppressQuestionFor],
  );
  const hasCompactionTurn = useMemo(
    () =>
      turns.some(
        (turn) =>
          turn.assistantMessages.some((msg) => (msg.info as any).summary === true) ||
          turn.assistantMessages.some((msg) => msg.parts.some((p) => p.type === 'compaction')),
      ),
    [turns],
  );

  // ---- Jump-to-message (from CMD+K or minimap) ----
  const targetMessageId = useMessageJumpStore((s) => s.targetMessageId);
  const clearJumpTarget = useMessageJumpStore((s) => s.clearTarget);
  useEffect(() => {
    if (!targetMessageId) return;
    const contentEl = contentRef.current;
    const scrollEl = scrollRef.current;
    if (!contentEl || !scrollEl) return;

    const target = contentEl.querySelector<HTMLElement>(`[data-turn-id="${targetMessageId}"]`);
    if (!target) {
      clearJumpTarget();
      return;
    }

    const scrollRect = scrollEl.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 24;
    scrollEl.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    clearJumpTarget();
  }, [targetMessageId, clearJumpTarget, contentRef, scrollRef]);

  // Reset on session change
  useEffect(() => {
    setPollingActive(false);
    setPendingUserMessage(null);
    setPendingUserMessageId(null);
    setPendingCommand(null);
    setPendingSendInFlight(false);
    setPendingSendMessageId(null);
    setRewindTarget(null);
    setRewindDraft(null);
    lastSendTimeRef.current = 0;
  }, [sessionId]);

  // ============================================================================
  // Billing: DISABLED — billing is handled server-side by the router
  // (POST /v1/router/chat/completions deducts credits per LLM call).
  // This frontend useEffect was causing double-billing once opencode.jsonc
  // got cost config and step-finish.cost became non-zero.
  // ============================================================================

  const handleConfirmRewind = useCallback(async () => {
    if (!sessionState || !rewindTarget) return;
    try {
      const { messageId, text } = rewindTarget;
      await sessionState.rewind(messageId);
      setRewindDraft({ text, id: ++rewindPrefillId.current });
      setRewindTarget(null);
    } catch (error) {
      errorToast('Session rewind failed', {
        description: formatCommandError(error),
      });
    }
  }, [rewindTarget, sessionState]);

  const handleRestoreRewind = useCallback(async () => {
    if (!sessionState?.rewindMessageId) return;
    try {
      await sessionState.restoreRewind();
      setRewindDraft({ text: '', id: ++rewindPrefillId.current });
    } catch (error) {
      errorToast('Session restore failed', {
        description: formatCommandError(error),
      });
    }
  }, [sessionState]);

  // ============================================================================
  // Send / Stop / Command handlers
  // ============================================================================

  const handleSend = useCallback(
    async (
      rawText: string,
      files?: AttachedFile[],
      mentions?: TrackedMention[],
      /**
       * Optional per-call overrides — used by the message queue drain so a
       * queued message uses the agent/model/variant captured at enqueue time
       * rather than whatever is currently active in the local store
       * (matches OpenCode FollowupDraft semantics).
       */
      overrides?: {
        agent?: string | null;
        model?: { providerID: string; modelID: string } | null;
        variant?: string | null;
      },
    ) => {
      setCommandError(null);

      // Wrap reply context in XML if present, then clear it
      let text = rawText;
      if (replyTo) {
        text = `<reply_context>${replyTo.text}</reply_context>\n\n${rawText}`;
        setReplyTo(null);
      }

      // Structured @-mention refs — emitted as <file_ref /> / <agent_ref />
      // blocks appended to the outgoing text. Same shape as
      // the existing <session_ref /> handling, so the agent gets uniform
      // metadata and the frontend can strip them back out on render.
      // File and agent refs from tracked @ mentions. File uploads still use
      // the separate <file path="..." mime="..." ...>…</file> block below —
      // these are only for plain @ references to existing files/agents.
      const fileMentionRefs: FileRefLike[] = (mentions ?? [])
        .filter((m) => m.kind === 'file' && m.label)
        .map((m) => ({ path: m.label, name: m.label }));
      const agentMentionRefs: AgentRefLike[] = (mentions ?? [])
        .filter((m) => m.kind === 'agent' && m.label)
        .map((m) => ({ name: m.label }));

      // Play send sound
      playSound('send');
      const messageID = ascendingId('msg');

      // Generate part IDs upfront so the optimistic message and the server
      // request use the SAME IDs. When the server echoes parts via
      // message.part.updated, the sync store's upsertPart will UPDATE
      // (not duplicate) the optimistic parts. This matches OpenCode's
      // SolidJS approach where part IDs are sent with the prompt request.
      const textPartId = ascendingId('prt');
      const attachedFiles = files ?? [];

      // Build optimistic text that includes session ref XML so that
      // HighlightMentions / UserMessage can detect multi-word session
      // mentions (e.g. "@Intro message") before the server echoes back.
      const sessionMentionsForOptimistic =
        mentions?.filter((m) => m.kind === 'session' && m.value) ?? [];

      // Also detect raw @ses_<id> patterns typed directly
      const rawOptimisticSessionIds: typeof sessionMentionsForOptimistic = [];
      const rawOptimisticRegex = /@(ses_[A-Za-z0-9]+)/g;
      let rawOptimisticMatch: RegExpExecArray | null;
      while ((rawOptimisticMatch = rawOptimisticRegex.exec(text)) !== null) {
        const rawId = rawOptimisticMatch[1];
        if (sessionMentionsForOptimistic.some((m) => m.value === rawId)) continue;
        const found = allSessions?.find((s: any) => s.id === rawId);
        rawOptimisticSessionIds.push({
          kind: 'session',
          label: found?.title || rawId,
          value: rawId,
        });
      }

      const allOptimisticSessionMentions = [
        ...sessionMentionsForOptimistic,
        ...rawOptimisticSessionIds,
      ];
      let optimisticText = text;
      optimisticText = buildOptimisticPromptTextWithUploads(optimisticText, attachedFiles);
      if (allOptimisticSessionMentions.length > 0) {
        const refs = allOptimisticSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        optimisticText = `${optimisticText}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }

      // Optimistic: show message immediately in sync store + set busy
      // Matches OpenCode: sync.set("session_status", session.id, { type: "busy" })
      beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);

      // Scroll so the new user message appears at the top of the viewport.
      // MutationObserver recalcs spacer automatically when the new turn renders.
      // Fire twice: early (before DOM update) to reset scroll state so the RAF
      // auto-scroll loop is unblocked, and again after the turn likely rendered.
      scrollToBottom();
      setTimeout(() => scrollToBottom(), 100);

      const options: Record<string, unknown> = {};
      const overrideAgent = overrides?.agent;
      const overrideModel = overrides?.model;
      const overrideVariant = overrides?.variant;
      if (lockedAgentName) {
        options.agent = lockedAgentName;
      } else if (overrideAgent !== undefined) {
        if (overrideAgent) options.agent = overrideAgent;
      } else if (local.agent.current) {
        options.agent = local.agent.current.name;
      }
      if (overrideModel !== undefined) {
        if (overrideModel) options.model = overrideModel;
      } else if (local.model.sendKey) {
        options.model = local.model.sendKey;
      }
      if (overrideVariant !== undefined) {
        if (overrideVariant) options.variant = overrideVariant;
      } else if (local.model.variant.current) {
        options.variant = local.model.variant.current;
      }

      // Build parts: text first, then upload attached files to /workspace/uploads/
      // and send as XML text references (agent reads from disk on demand, not loaded into context)
      const textPrompt = { id: textPartId, type: 'text' as const, text };
      const parts: Array<
        typeof textPrompt | { type: 'file'; mime: string; url: string; filename: string }
      > = [textPrompt];
      let built: Awaited<ReturnType<typeof buildPromptPartsWithUploads>>;
      try {
        built = await buildPromptPartsWithUploads(textPrompt.text, attachedFiles, uploadFile);
      } catch (err) {
        // Never reached the network — nothing to rehydrate from the server,
        // so just clear busy and drop the optimistic message outright.
        abandonOptimisticSend(sessionId, messageID);
        const classified = classifySessionError(err);
        setCommandError(classified);
        throw err instanceof Error ? err : new Error(classified.message);
      }
      textPrompt.text = built.text;
      parts.push(...built.remoteParts);

      // Append session reference hints for @session mentions.
      // Merge tracked mentions with any raw @ses_<id> tags typed directly.
      const trackedSessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value) ?? [];

      // Detect raw @ses_<id> patterns in the text (e.g. @ses_2ec118d4...)
      const rawSessionIdMentions: TrackedMention[] = [];
      const rawSessionIdRegex = /@(ses_[A-Za-z0-9]+)/g;
      let rawMatch: RegExpExecArray | null;
      while ((rawMatch = rawSessionIdRegex.exec(textPrompt.text)) !== null) {
        const rawId = rawMatch[1];
        // Skip if already covered by a tracked mention
        if (trackedSessionMentions.some((m) => m.value === rawId)) continue;
        // Look up session by ID
        const found = allSessions?.find((s: any) => s.id === rawId);
        if (found) {
          rawSessionIdMentions.push({
            kind: 'session',
            label: found.title || rawId,
            value: rawId,
          });
        } else {
          // Unknown session ID — still include it so the agent can attempt to fetch it
          rawSessionIdMentions.push({
            kind: 'session',
            label: rawId,
            value: rawId,
          });
        }
      }

      const allSessionMentions = [...trackedSessionMentions, ...rawSessionIdMentions];
      if (allSessionMentions.length > 0) {
        const refs = allSessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        textPrompt.text = `${textPrompt.text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) textPrompt.text = `${textPrompt.text}\n\n${block}`;
      }

      // Send via the SDK's promptRuntimeMessage — the server accepts the
      // prompt (204) and streams the response over SSE; we await the ACK so
      // callers (queue drain, input box) can handle send failures, but the
      // actual response body still arrives via the sync store.
      //
      // Don't send part IDs or messageID — let the server generate them with
      // its own clock. Client-generated IDs can sort before server IDs due to
      // clock skew (browser vs Docker container), causing the server's loop to
      // exit immediately thinking the prompt was already answered.
      const mappedParts = parts.map((p: any) => {
        if (p.type === 'file')
          return {
            type: 'file' as const,
            mime: p.mime,
            url: p.url,
            filename: p.filename,
          };
        return { type: 'text' as const, text: p.text };
      });
      const sendOpts = Object.keys(options).length > 0 ? options : undefined;
      // Kept so a turn refused for a missing connector can be re-sent verbatim
      // once the account is connected. Without it the user connects, the card
      // retries, and re-sends nothing — losing the message they typed, which is
      // a worse outcome than the refusal they started with.
      lastSubmittedRef.current = { parts: mappedParts, options };
      const selectedAgent = typeof sendOpts?.agent === 'string' ? sendOpts.agent : null;
      const selectedVariant = typeof sendOpts?.variant === 'string' ? sendOpts.variant : null;
      const selectedModel = sendOpts?.model ? (sendOpts.model as ModelKey) : null;

      // Sending to the sandbox's OpenCode server can transiently fail — the
      // container may be waking from auto-stop, restarting, or the tunnel
      // blips. `promptRuntimeMessage` (packages/sdk) owns retrying transient
      // failures with backoff so a flaky send self-heals; only a real 4xx (bad
      // request / auth / missing model key), or exhausting the retry window,
      // surfaces here. The optimistic user message + busy status stay up the
      // whole time, so the UI shows the send in progress throughout. On
      // failure, `sendAndRecover` runs the shared recovery routine: clear
      // busy, then either rehydrate real messages from the server (some error
      // paths — e.g. missing API key — never emit a `session.error` SSE
      // event) or drop the optimistic message if the server has no record.
      const result = sessionState
        ? await (async () => {
            try {
              await sessionState.sendParts(mappedParts, {
                ...(session?.directory ? { directory: session.directory } : {}),
                ...(selectedAgent ? { agent: selectedAgent } : {}),
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(selectedVariant ? { variant: selectedVariant } : {}),
              });
              return { ok: true } as const;
            } catch (cause) {
              const error = recoverFromSendFailure(sessionId, messageID, cause, {
                classify: classifySessionError,
              });
              return { ok: false, error, cause } as const;
            }
          })()
        : await sendAndRecover({
            sessionId,
            messageId: messageID,
            parts: mappedParts,
            options: {
              // Pass the session's directory so opencode resolves project-scoped
              // agents (.opencode/agent/*.md under the project) and applies them
              // when the user picked a project agent from the picker.
              ...(session?.directory ? { directory: session.directory } : {}),
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedModel ? { model: formatPromptModel(selectedModel) } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
            } as any,
            classify: classifySessionError,
          });
      if (!result.ok) {
        setCommandError(result.error);
        throw result.cause instanceof Error ? result.cause : new Error(result.error.message);
      }

      return messageID;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      lockedAgentName,
      local.agent.current,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
      scrollToBottom,
      replyTo,
      messages,
      sessionState,
    ],
  );

  // Expose this session's canonical sender so sibling surfaces (e.g. the
  // "Changes" side panel's "Ask agent to open a change request" button) can
  // drive the agent through the SAME robust path the input uses — optimistic
  // message, SSE wiring, error propagation — instead of copying a prompt to the
  // clipboard. Keyed by the OpenCode chat session id (`sessionId`).
  const registerSender = useChatSendStore((s) => s.registerSender);
  const unregisterSender = useChatSendStore((s) => s.unregisterSender);
  useEffect(() => {
    registerSender(sessionId, (text: string) => handleSend(text));
    return () => unregisterSender(sessionId);
  }, [sessionId, handleSend, registerSender, unregisterSender]);

  // Drain the ENTIRE queue at once at the next safe boundary — a tool call
  // finishing (status flips to 'completed' or 'error'), or the turn going
  // idle (covers the case where a message was queued during what turns out
  // to be the LAST tool call, with nothing after it to hit). Everything
  // queued goes out together as soon as one boundary is hit; it does NOT
  // trickle out one message per subsequent boundary. Tracks tool completions
  // it's already reacted to in a ref so re-renders don't re-fire.
  const seenCompletedToolIdsRef = useRef<Set<string>>(new Set());
  const wasBusyForDrainRef = useRef(isBusy);
  useEffect(() => {
    let hitToolBoundary = false;
    if (messages) {
      const seen = seenCompletedToolIdsRef.current;
      for (const m of messages) {
        if (m.info.role !== 'assistant') continue;
        for (const part of m.parts) {
          if (part.type !== 'tool') continue;
          const status = (part as ToolPart).state?.status;
          if ((status === 'completed' || status === 'error') && !seen.has(part.id)) {
            seen.add(part.id);
            hitToolBoundary = true;
          }
        }
      }
    }

    const wasBusy = wasBusyForDrainRef.current;
    wasBusyForDrainRef.current = isBusy;
    const hitIdleBoundary = wasBusy && !isBusy;

    if (!hitToolBoundary && !hitIdleBoundary) return;

    const queue = queuedMessagesRef.current;
    if (queue.length === 0) return;

    setQueuedMessages([]);
    void (async () => {
      const failed: QueuedMessage[] = [];
      for (const item of queue) {
        try {
          await handleSend(item.text, item.files, item.mentions);
        } catch {
          failed.push(item);
        }
      }
      // Send failures are already surfaced via commandError — put any back
      // so the user doesn't silently lose the queued draft.
      if (failed.length > 0) setQueuedMessages((cur) => [...failed, ...cur]);
    })();
  }, [messages, isBusy, handleSend]);

  // NOTE: no client-side "auto-continue after approval" here — resuming the
  // agent when nobody was holding the gated call is the RESOLVE ENDPOINT's job
  // (server-side continueSession delivery in r7.ts), so it works with zero
  // browsers open. A web-side nudge would just double-send.

  const handleStop = useCallback(() => {
    // Guard against rapid clicks — ignore if an abort is already in flight
    if (abortSession.isPending) {
      console.log(`[handleStop] Ignoring - abort already in flight for session ${sessionId}`);
      return;
    }
    console.log(`[handleStop] Stopping session ${sessionId}`);
    // Optimistically mark the session idle + patch an abort error onto the
    // last assistant message (so the "Interrupted" label appears instantly —
    // no waiting for the SSE session.error round-trip). Also clear the busy
    // debounce timer to bypass the 2s delay.
    applyOptimisticAbort(sessionId);
    clearTimeout(busyTimerRef.current);
    setIsBusy(false);

    if (sessionState) sessionState.cancel();
    else abortSession.mutate(sessionId);
  }, [sessionId, sessionState, abortSession]);

  // ---- Triple-ESC to stop ----
  // ESC 1 → show hint (2 more). ESC 2 → show hint (1 more). ESC 3 → stop.
  // 4s cooloff window — resets if you wait too long between presses.
  const [escCount, setEscCount] = useState(0); // 0 = idle, 1 = first press, 2 = second press
  const escDeadlineRef = useRef(0);
  const escFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEscHint = useCallback(() => {
    escDeadlineRef.current = 0;
    setEscCount(0);
    if (escFadeTimerRef.current) {
      clearTimeout(escFadeTimerRef.current);
      escFadeTimerRef.current = null;
    }
  }, []);

  // When this SessionChat is not the active tab, make sure any lingering
  // ESC-counter state is cleared. Prevents stale "2 more to stop" hints from
  // being carried over when the user switches tabs.
  useEffect(() => {
    if (!isActiveSessionTab) clearEscHint();
  }, [isActiveSessionTab, clearEscHint]);

  useEffect(() => {
    // CRITICAL: all open session tabs are pre-mounted simultaneously by
    // SessionTabsContainer (see layout-content.tsx), so every mounted
    // SessionChat would otherwise receive the same window keydown event and
    // each busy session would independently advance its ESC counter and
    // abort itself on triple-ESC. Only the visible (active) session tab may
    // handle ESC — and never in read-only viewers (e.g. the sub-session
    // modal), which must not issue stop commands.
    if (!isActiveSessionTab || readOnly) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isBusy) return;

      // ESC was already consumed by something else — e.g. the composer's own
      // slash/mention popover (which calls preventDefault) or another focused
      // control that handled it — so it must never advance the stop counter.
      if (e.defaultPrevented) return;

      // ESC-to-stop is a page-wide shortcut: it must fire whether or not the
      // composer is focused, because users watch the agent run with focus
      // elsewhere (chat body, a tool view, or nothing at all). The only presses
      // we ignore are those meant for an open overlay the user is interacting
      // with — when focus sits inside a dialog/menu/popover/select, that ESC is
      // for dismissing it, not for stopping. (A hovered tooltip never takes
      // focus, so the stop button's own tooltip can't suppress the shortcut.)
      const active = document.activeElement;
      const focusInOverlay = active?.closest(
        '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]',
      );
      if (focusInOverlay) return;

      e.preventDefault();

      const now = Date.now();
      const withinWindow = now < escDeadlineRef.current;

      if (withinWindow) {
        const currentCount = escDeadlineRef.current ? Math.max(1, escCount) : 0;
        if (currentCount >= 2) {
          // Third ESC → stop
          clearEscHint();
          handleStop();
        } else {
          // Second ESC → advance count, refresh cooloff
          setEscCount(2);
          escDeadlineRef.current = now + 4000;
          if (escFadeTimerRef.current) clearTimeout(escFadeTimerRef.current);
          escFadeTimerRef.current = setTimeout(() => {
            escDeadlineRef.current = 0;
            setEscCount(0);
          }, 4000);
        }
      } else {
        // First ESC (or cooloff expired) → start fresh
        setEscCount(1);
        escDeadlineRef.current = now + 4000;
        if (escFadeTimerRef.current) clearTimeout(escFadeTimerRef.current);
        escFadeTimerRef.current = setTimeout(() => {
          escDeadlineRef.current = 0;
          setEscCount(0);
        }, 4000);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActiveSessionTab, readOnly, isBusy, handleStop, clearEscHint, escCount]);

  // Reset when session goes idle
  useEffect(() => {
    if (!isBusy) clearEscHint();
  }, [isBusy, clearEscHint]);

  // Ref-based guard against rapid double-fire of commands (replaces
  // the old executeCommand.isPending check from the TQ mutation).
  const commandInFlightRef = useRef(false);

  const handleCommand = useCallback(
    (cmd: Command, args?: string) => {
      if (commandInFlightRef.current) return;
      setCommandError(null);

      playSound('send');
      const label = args ? `/${cmd.name} ${args}` : `/${cmd.name}`;
      const selectedModel = local.model.sendKey ?? undefined;
      const handleCommandError = (err?: unknown) => {
        setPendingCommand(null);
        setPendingUserMessage(null);
        setPendingUserMessageId(null);
        setPollingActive(false);
        pendingCommandStashRef.current = null;
        useSessionStateStore.getState().setStatus(sessionId, { type: 'idle' });
        setCommandError(classifySessionError(err));
      };

      setPendingCommand({
        name: cmd.name,
        description: args || cmd.description,
      });
      pendingCommandStashRef.current = {
        name: cmd.name,
        args: args || cmd.description,
      };
      setPendingUserMessage(label);
      setPendingUserMessageId(null);
      setPollingActive(true);
      lastSendTimeRef.current = Date.now();

      // Match SolidJS reference (submit.ts:259-289): fire command
      // directly via SDK — no TanStack Query, no mutation retry, no
      // optimistic message. The server creates the user message and
      // SSE delivers it. Commands use the blocking /command endpoint
      // which can take minutes; using TQ would cause retry on timeout.
      commandInFlightRef.current = true;
      const agent = lockedAgentName || local.agent.current?.name;
      const variant = local.model.variant.current;
      void (
        sessionState?.runCommand(cmd.name, args || '', {
          agent,
          model: selectedModel,
          variant,
        }) ??
        executeCommand.mutateAsync({
          sessionId,
          command: cmd.name,
          args: args || '',
          ...(agent ? { agent } : {}),
          ...(selectedModel ? { model: formatModelString(selectedModel) } : {}),
          ...(variant ? { variant } : {}),
        })
      )
        .then((res: any) => {
          if (res?.error) {
            handleCommandError(res.error);
          }
        })
        .catch(handleCommandError)
        .finally(() => {
          commandInFlightRef.current = false;
        });
      setTimeout(() => scrollToBottom(), 50);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      scrollToBottom,
      lockedAgentName,
      sessionState,
      executeCommand,
      local.agent.current,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
    ],
  );

  const handleFileSearch = useCallback(async (query: string): Promise<string[]> => {
    try {
      return await searchWorkspaceFiles(query);
    } catch {
      return [];
    }
  }, []);

  const pathname = usePathname();
  const router = useRouter();

  // Thread context for subsessions only (real parentID).
  const { data: parentSessionData } = useRuntimeSession(session?.parentID || '');
  const threadContext = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return undefined;
    const projectRoute = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
    return {
      parentTitle: parentSessionData.title || 'Parent session',
      onBackToParent: () => {
        if (projectRoute) {
          const [, projectId, projectSessionId] = projectRoute;
          const href = parentSessionData.parentID
            ? `/projects/${projectId}/sessions/${projectSessionId}?oc=${encodeURIComponent(parentSessionData.id)}`
            : `/projects/${projectId}/sessions/${projectSessionId}`;
          router.push(href);
          return;
        }
        openTabAndNavigate({
          id: parentSessionData.id,
          title: parentSessionData.title || 'Parent session',
          type: 'session',
          href: `/sessions/${parentSessionData.id}`,
        });
      },
    };
  }, [session?.parentID, parentSessionData, pathname, router]);

  // ---- Stable props for <SessionChatInput> (it's React.memo-wrapped, so every
  // prop below must keep referential identity across renders that don't
  // actually change it — otherwise the memo is defeated on every streaming
  // token). Bodies are verbatim copies of what used to be inlined in the JSX. ----
  const handleSendWithDraftClear = useCallback(
    async (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => {
      await handleSend(text, files, mentions);
      if (failedStartDraft) {
        clearStartStash(sessionId);
        usePendingFilesStore.getState().consumePendingFiles();
        setFailedStartDraft(null);
      }
    },
    [handleSend, failedStartDraft, sessionId],
  );

  const chatPrefill = useMemo(
    () =>
      failedStartDraft
        ? {
            text: failedStartDraft.text,
            files: failedStartDraft.files,
            id: failedStartDraft.id,
            mode: 'merge' as const,
          }
        : null,
    [failedStartDraft],
  );

  const handleAgentChange = useCallback(
    (name: string | null | undefined) => local.agent.set(name ?? undefined),
    [local.agent],
  );

  const handleModelChange = useCallback(
    (m: ModelKey | null) => local.model.set(m ?? undefined, { recent: true }),
    [local.model],
  );

  const chatModelDefaultControls: ModelDefaultControls = useMemo(
    () => ({
      agentName: lockedAgentName ?? local.agent.current?.name,
      onSetAccountDefault: (m) => {
        void local.model.defaults.setAccountDefault(m);
      },
      onSetAgentDefault:
        lockedAgentName || local.agent.current
          ? (m) => {
              const name = lockedAgentName ?? local.agent.current?.name;
              if (name) void local.model.defaults.setAgentDefault(name, m);
            }
          : undefined,
      onSetProjectDefault: (m) => {
        void local.model.defaults.setProjectDefault(m);
      },
    }),
    [lockedAgentName, local.agent, local.model.defaults],
  );

  const handleVariantChange = useCallback(
    (v: string | null | undefined) => local.model.variant.set(v ?? undefined),
    [local.model.variant],
  );

  const handleContextClick = useCallback(() => setContextModalOpen(true), []);

  const handleCustomAnswer = useCallback((text: string) => {
    questionPromptRef.current?.submitCustomAnswer(text);
  }, []);

  const handleQuestionAction = useCallback(() => {
    questionPromptRef.current?.performAction();
  }, []);

  const chatCommands = useMemo(() => commands || [], [commands]);
  const sessionScopeAgentName = lockedAgentName ?? local.agent.current?.name;

  const chatToolbarSlot = useMemo(
    () =>
      projectId && projectSessionId ? (
        <SessionScopeToolbar
          projectId={projectId}
          sessionId={projectSessionId}
          agentName={sessionScopeAgentName}
        />
      ) : undefined,
    [projectId, projectSessionId, sessionScopeAgentName],
  );

  const chatInputSlot = useMemo(
    () => (
      <>
        {sessionState?.rewindMessageId ? (
          <div className="border-border/60 bg-muted/40 flex items-center gap-2 rounded-md border px-3 py-2">
            <RotateCcw className="text-muted-foreground size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-xs font-medium">Session rewound</p>
              <p className="text-muted-foreground text-xs">
                Sending a new prompt commits this path. Restore keeps the removed messages and file
                changes.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={sessionState.rewindPending}
              onClick={() => void handleRestoreRewind()}
            >
              {sessionState.rewindPending ? <Loading /> : 'Restore'}
            </Button>
          </div>
        ) : null}
        {/* Connector actions a policy gated for approval — pauses the run
            until the human decides. Self-hides when nothing's pending. */}
        <SessionApprovalPrompt />
        {/* Opencode tool permissions (bash/edit/…) awaiting a decision —
            the turn is blocked inside the runtime and resumes the moment
            a reply lands. Self-hides when nothing's pending. */}
        <SessionPermissionPrompt
          sessionId={sessionId}
          permissions={pendingPermissions}
          onReply={handlePermissionReply}
        />
        {renderedQuestion ? (
          <div
            className={cn(
              'overflow-hidden transition-[max-height,opacity,transform] ease-in-out',
              questionPromptVisible
                ? 'max-h-[520px] translate-y-0 opacity-100 duration-300'
                : 'pointer-events-none max-h-0 -translate-y-1 opacity-0 duration-320',
            )}
          >
            <QuestionPrompt
              key={renderedQuestion.id}
              ref={questionPromptRef}
              request={renderedQuestion}
              onReply={handleQuestionReply}
              onReject={handleQuestionReject}
              onActionChange={handleQuestionActionChange}
            />
          </div>
        ) : null}
      </>
    ),
    [
      sessionId,
      sessionState?.rewindMessageId,
      sessionState?.rewindPending,
      handleRestoreRewind,
      pendingPermissions,
      handlePermissionReply,
      renderedQuestion,
      questionPromptVisible,
      handleQuestionReply,
      handleQuestionReject,
      handleQuestionActionChange,
    ],
  );

  // ============================================================================
  // Loading / Not-found states
  // ============================================================================
  //
  // IMPORTANT: Do NOT use early returns here. Returning a different component
  // tree unmounts the textarea, losing user input, focus, and all local state.
  // Instead, the loading/not-found states are rendered inline in the content
  // area while the header and input remain mounted.

  // Show loader ONLY when we have zero knowledge about this session.
  // Once session metadata is available (from cache, placeholderData, or
  // fetch), skip the loader and show the content area immediately — the
  // welcome screen for empty sessions, cached messages for non-empty ones.
  // This eliminates the loader for empty sessions entirely: instead of
  // spinning while we wait to confirm "0 messages", we show the welcome
  // screen right away.
  const hasMessages = Boolean(messages?.length);
  // "Not found" is a TERMINAL answer, never a loading guess. It's only true once
  // the runtime is connected AND the session lookup has actually run and come
  // back empty. While the runtime is still connecting (the query is disabled and
  // therefore reports isLoading=false) or the lookup is in flight, we know
  // nothing yet — so we must show the loading state, not the error. This is what
  // stops the "This session is not accessible right now." flash on boot.
  const composerReadiness = sessionComposerReadiness({ runtimeReady });
  const { isNotFound, isDataLoading } = resolveSessionContentState({
    runtimeReady,
    sessionFetched,
    hasRuntimeSession: Boolean(session),
    hasMessages,
    hasOptimisticPrompt: Boolean(optimisticPrompt),
  });
  // Everything that isn't "we have content" and isn't the terminal not-found
  // state is loading — including the boot window where the query is still
  // disabled (isLoading=false) waiting on the runtime.
  const showOptimistic = !!optimisticPrompt && !hasMessages;
  const isTransitioningFromWelcome = !prevHasChatContentRef.current && hasChatContent;
  // The welcome wallpaper is the EMPTY-STATE backdrop for a *resolved* session.
  // The loading/connecting phase never reaches here (it early-returns the loader
  // below), so this only needs to exclude the not-found screen.
  const shouldShowWelcomeOverlay =
    !isNotFound && (!hasChatContent || welcomeFadeActive || isTransitioningFromWelcome);

  // The welcome wallpaper. When SessionLayout provides a root-level wallpaper
  // layer we portal it in there so it spans the FULL session width (never
  // squished into the chat panel when the side panel is open); otherwise it
  // renders inline (mobile / standalone, where the chat panel is full width).
  const welcomeWallpaper = shouldShowWelcomeOverlay ? (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-0 transition-opacity ease-out',
        hasChatContent ? 'opacity-0' : 'opacity-100',
      )}
      style={{ transitionDuration: `${WELCOME_FADE_MS}ms` }}
    >
      <SessionWelcome />
    </div>
  ) : null;

  // While the session is still connecting / loading its content, render ONLY the
  // staged loader — never the session shell (header + input) at the same time.
  // Showing both reads as "loaded and loading at once" (the very contradiction
  // the loader exists to avoid). The connection keeps running in the parent
  // ProjectSessionRuntimeConnection, so as soon as the runtime is ready
  // isDataLoading flips and the full shell renders in one shot.
  if (isDataLoading) {
    return (
      <div className="bg-background relative flex h-full flex-col" data-testid="session-chat">
        <SessionStartingLoader stage="ready" variant="compact" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex h-full flex-col',
        // Transparent in the welcome state so the root-level full-bleed wallpaper
        // (portaled into SessionLayout) reads through; solid once real content
        // takes over. Same base color either way, so non-welcome is unchanged.
        shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
      )}
      data-testid="session-chat"
    >
      {/* Full-bleed welcome wallpaper — spans the entire session (behind header,
          messages, project selector, and chat input). Input renders as frosted
          glass so the wallpaper reads through uninterrupted. Portaled into
          SessionLayout's root layer when present so it stays full width even
          with the side panel open; falls back to inline otherwise. */}
      {wallpaperLayer
        ? welcomeWallpaper && createPortal(welcomeWallpaper, wallpaperLayer)
        : welcomeWallpaper}

      {/* Session header — always mounted */}
      {!hideHeader && (
        <SessionSiteHeader
          sessionId={sessionId}
          sessionTitle={session?.title || 'Untitled'}
          leadingAction={headerLeadingAction}
        />
      )}

      {/* Context modal — triple-click the session title area to open */}
      <SessionContextModal
        open={contextModalOpen}
        onOpenChange={setContextModalOpen}
        messages={messages}
        session={session}
        providers={providers}
        allSessions={allSessions}
      />

      {/* Chat and the action panel share one row. The panel is a real column,
          not an overlay: opening it takes width from this row, and the chat
          column below re-centers its own content in what is left. That is the
          whole reason for this wrapper — an absolutely positioned panel
          floated over the transcript instead of moving it. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Content area — loading, not-found, or actual messages. The single
              session loader (SessionStartingLoader) carries through here on its
              "Connecting" phase so there's never a second, different loader. */}
          {isNotFound ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="text-muted-foreground text-sm">
                {tHardcodedUi.raw(
                  'componentsSessionSessionChat.line5821JsxTextThisSessionIsNotAccessibleRightNow',
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  try {
                    if (sessionId) useTabStore.getState().closeTab?.(sessionId);
                  } catch {}
                  if (typeof window !== 'undefined') window.location.assign('/');
                }}
                className="text-primary text-sm hover:underline"
              >
                {tHardcodedUi.raw('componentsSessionSessionChat.line5833JsxTextGoToHome')}
              </button>
            </div>
          ) : (
            <div ref={chatAreaRef} className="relative z-10 min-h-0 flex-1">
              <div
                ref={scrollContainerCallbackRef}
                className={cn(
                  'scrollbar-hide relative z-10 h-full flex-1 overflow-y-auto [scroll-behavior:auto]',
                  shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
                )}
                onMouseUp={handleChatMouseUp}
                onMouseDown={handleChatMouseDown}
                onScroll={handleChatScroll}
              >
                <div
                  ref={contentRef}
                  role="log"
                  className="mx-auto w-full max-w-3xl min-w-0 px-3 py-6 sm:px-6"
                >
                  <div className="flex min-w-0 flex-col">
                    {/* Optimistic turn — the user's message plus the waiting row,
                        shared verbatim with InstantSessionShell so the shell → chat
                        crossfade has nothing to drift on (see OptimisticTurn). */}
                    {showOptimistic && (
                      <OptimisticTurn
                        text={optimisticPrompt || ''}
                        agentNames={agentNames}
                        onFileClick={openFileInComputer}
                        onFilePreview={openPreview}
                      />
                    )}

                    {isOptimisticCompacting && !hasCompactionTurn && (
                      <div className="mt-12 space-y-3">
                        <div className="my-3 flex items-center gap-3 py-4">
                          <div className="bg-border h-px flex-1" />
                          <div className="bg-muted/80 border-border/60 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                            <Layers className="text-muted-foreground size-3.5" />
                            <span className="text-muted-foreground text-xs font-semibold tracking-wide">
                              Compaction
                            </span>
                          </div>
                          <div className="bg-border h-px flex-1" />
                        </div>
                        <div className="flex items-center gap-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src="/kortix-logomark-white.svg"
                            alt="Kortix"
                            className="h-[14px] w-auto flex-shrink-0 invert dark:invert-0"
                          />
                          <div className="text-muted-foreground text-sm">
                            {tHardcodedUi.raw(
                              'componentsSessionSessionChat.line5954JsxTextCompactingSession',
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Turn-based message rendering.
                    ToolActivateContext makes inline tool rows open the side
                    panel (Actions) focused on that tool, instead of expanding. */}
                    {hasOlder && (
                      <div className="mb-6 flex flex-col items-center gap-2">
                        {/* Sentinel: crossing into view pulls the previous page.
                        Sits above the spinner so it clears the viewport as
                        soon as the prepended turns render. */}
                        <div ref={olderSentinelRef} aria-hidden className="h-px w-full" />
                        {isLoadingOlder && <Loading />}
                        {olderPullFailed && !isLoadingOlder && (
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-xs">
                              Couldn&apos;t load older messages.
                            </span>
                            <Button
                              type="button"
                              variant="outline-ghost"
                              size="sm"
                              onClick={() => void handleLoadOlder()}
                            >
                              Retry
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    <ToolActivateContext.Provider value={toolActivate}>
                      {turns.map((turn, turnIndex) => {
                        // Check if this turn is a compaction summary
                        const hasCompaction =
                          turn.assistantMessages.some(
                            (msg) => (msg.info as any).summary === true,
                          ) ||
                          turn.assistantMessages.some((msg) =>
                            msg.parts.some((p) => p.type === 'compaction'),
                          );

                        // Notification-only early-return removed: it rendered the
                        // user's pty_* card but skipped turn.assistantMessages,
                        // hiding every subsequent assistant response in that turn.
                        // Fall through to the normal turn renderer instead.

                        return (
                          <div
                            key={turn.userMessage.info.id}
                            data-turn-id={turn.userMessage.info.id}
                            className={cn(
                              '[contain-intrinsic-size:auto_600px] [content-visibility:auto]',
                              turnIndex === 0 ? '' : 'mt-12',
                            )}
                          >
                            {/* Compaction divider — shown before the first turn after compaction */}
                            {hasCompaction && (
                              <div className="my-3 flex items-center gap-3 py-4">
                                <div className="bg-border h-px flex-1" />
                                <div className="bg-muted/80 border-border/60 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                                  <Layers className="text-muted-foreground size-3.5" />
                                  <span className="text-muted-foreground text-xs font-semibold tracking-wide">
                                    Compaction
                                  </span>
                                </div>
                                <div className="bg-border h-px flex-1" />
                              </div>
                            )}
                            <SessionTurn
                              turn={turn}
                              allMessages={messages!}
                              sessionId={sessionId}
                              sessionStatus={sessionStatus}
                              permissions={pendingPermissions}
                              questions={pendingQuestions}
                              agentNames={agentNames}
                              isFirstTurn={turnIndex === 0}
                              isBusy={isBusy}
                              isCompaction={hasCompaction}
                              providers={providers}
                              commandMessages={commandMessagesRef.current}
                              commands={commands}
                              disableToolNavigation={disableToolNavigation}
                              onPermissionReply={handlePermissionReply}
                              onRewind={(messageId, text) => setRewindTarget({ messageId, text })}
                              rewindDisabled={
                                !!readOnly || !sessionState || isBusy || sessionState.rewindPending
                              }
                            />
                          </div>
                        );
                      })}
                    </ToolActivateContext.Provider>

                    {/* Busy indicator when no turns yet but session is busy */}
                    {commandError && <TurnErrorDisplay error={commandError} className="mt-2" />}
                    {/* A turn refused for a missing connector renders HERE — after
                    the last turn, directly under the message that triggered it —
                    rather than as a one-line pill. It is the one failure with a
                    button that fixes it. */}
                    <ConnectorRequiredNotice
                      error={sessionState?.sendError}
                      projectId={projectId}
                      resend={
                        sessionState && lastSubmittedRef.current
                          ? () => {
                              const last = lastSubmittedRef.current;
                              if (!last) return;
                              void sessionState.sendParts(
                                last.parts as Parameters<typeof sessionState.sendParts>[0],
                                last.options as Parameters<typeof sessionState.sendParts>[1],
                              );
                            }
                          : undefined
                      }
                      className="mt-2"
                    />
                    {/* Busy with no turn to attach it to yet — the same waiting row
                        the optimistic turn and every live turn use, so it never
                        changes shape as the first turn materialises. */}
                    {!showOptimistic && isBusy && turns.length === 0 && <SessionBusyIndicator />}
                  </div>
                  {/* Spacer — ensures the last message can scroll to the top of
						    the viewport (ChatGPT-style). Without this, scrollToBottom
						    only brings the last message to the bottom of the screen.
						    Height is dynamically measured from the scroll container so
						    the newest message appears flush at the top. */}
                  <div ref={spacerElRef} />
                </div>
              </div>

              {/* Selection "Reply" popup — floats near selected text */}
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
                    size="sm"
                    className="animate-in fade-in-0 zoom-in-95 origin-bottom px-3 text-xs duration-150 ease-out has-[>svg]:px-3"
                  >
                    Reply
                    <ArrowBendUpLeftIcon className="size-4 shrink-0" />
                  </Button>
                </div>
              )}

              {/* Chat Minimap */}
              <ChatMinimap
                turns={turns}
                scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
                contentRef={contentRef as React.RefObject<HTMLDivElement>}
              />

              <div
                className={cn(
                  'absolute bottom-4 left-1/2 z-20 -translate-x-1/2',
                  'transition-[opacity,translate,scale] ease-[cubic-bezier(0.23,1,0.32,1)]',
                  'motion-reduce:translate-y-0 motion-reduce:scale-100 motion-reduce:transition-[opacity]',
                  showScrollButton
                    ? 'translate-y-0 scale-100 opacity-100 duration-150'
                    : 'pointer-events-none translate-y-1 scale-[0.97] opacity-0 duration-100',
                )}
              >
                <Button
                  variant="secondary"
                  size="icon-md"
                  aria-hidden={!showScrollButton}
                  tabIndex={showScrollButton ? undefined : -1}
                  className={cn(
                    'hit-area-2 shadow-xs',
                    'transition-[scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96]',
                  )}
                  onClick={smoothScrollToAbsoluteBottom}
                >
                  <CaretDownIcon className="size-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Input — hidden in read-only mode (sub-session modal) */}
          {!readOnly && (
            <>
              <SessionChatInput
                onSend={async (text, files, mentions) => {
                  await handleSend(text, files, mentions);
                  if (failedStartDraft) {
                    clearStartStash(sessionId);
                    usePendingFilesStore.getState().consumePendingFiles();
                    setFailedStartDraft(null);
                  }
                }}
                prefill={
                  rewindDraft
                    ? {
                        text: rewindDraft.text,
                        id: rewindDraft.id,
                        mode: 'replace',
                      }
                    : failedStartDraft
                      ? {
                          text: failedStartDraft.text,
                          files: failedStartDraft.files,
                          id: failedStartDraft.id,
                          mode: 'merge',
                        }
                      : sessionPrefill
                        ? { text: sessionPrefill.text, id: sessionPrefill.id, mode: 'merge' }
                        : null
                }
                isBusy={isBusy}
                queuedMessages={queuedMessages}
                onQueueMessage={handleQueueMessage}
                onRemoveQueuedMessage={handleRemoveQueuedMessage}
                onStop={handleStop}
                escCount={escCount}
                agents={local.agent.list}
                selectedAgent={lockedAgentName ?? local.agent.current?.name ?? null}
                onAgentChange={lockedAgentName ? undefined : handleAgentChange}
                agentSelectorLocked={!!lockedAgentName}
                commands={chatCommands}
                onCommand={handleCommand}
                models={local.model.list}
                selectedModel={local.model.currentKey ?? null}
                onModelChange={handleModelChange}
                modelDefaultControls={chatModelDefaultControls}
                variants={local.model.variant.list}
                selectedVariant={local.model.variant.current ?? null}
                onVariantChange={handleVariantChange}
                messages={messages}
                sessionId={sessionId}
                projectId={projectId}
                onFileSearch={handleFileSearch}
                providers={providers}
                modelRequired
                modelsLoading={providersLoading}
                threadContext={threadContext}
                onContextClick={handleContextClick}
                replyTo={replyTo}
                onClearReply={handleClearReply}
                // Only lock the input into question-answer mode while the session is
                // actually busy (a live question keeps the run busy). If a question
                // chip is ever showing while the session is idle — e.g. a dead /
                // abandoned question the agent left behind — the input stays unlocked
                // so a typed message is sent to the agent instead of being swallowed
                // as a custom answer.
                lockForQuestion={!!renderedQuestion && isBusy}
                // Same dead-prompt guard as questions: only lock while the agent is
                // actually paused on the decision (isBusy), so a stale card can't
                // swallow the composer on an idle session.
                lockForApproval={hasPendingApproval || (pendingPermissions.length > 0 && isBusy)}
                onCustomAnswer={handleCustomAnswer}
                questionButtonLabel={renderedQuestion ? questionAction.label : null}
                questionCanAct={questionAction.canAct}
                onQuestionAction={handleQuestionAction}
                inputSlot={chatInputSlot}
                toolbarSlot={chatToolbarSlot}
                // The shell can now render on a cached transcript alone, i.e. before
                // the sandbox answers — so sending has to be gated separately from
                // reading. See sessionComposerReadiness.
                disabled={composerReadiness.disabled}
                placeholder={composerReadiness.placeholder}
              />
              <ConfirmDialog
                open={!!rewindTarget}
                onOpenChange={(open) => !open && setRewindTarget(null)}
                title="Edit from this message?"
                description={
                  <>
                    <p>This rewinds the same session and restores its files to this message.</p>
                    <p className="mt-2">
                      You can restore the removed path until you send a replacement prompt.
                    </p>
                  </>
                }
                confirmLabel="Rewind session"
                confirmVariant="destructive"
                confirmIcon={<RotateCcw className="size-3.5" />}
                isPending={sessionState?.rewindPending}
                onConfirm={() => void handleConfirmRewind()}
              />
            </>
          )}
        </div>

        {/* The action panel column — a sibling of the chat, so it pushes
            rather than covers. Self-gates to null on mobile and outside a
            SessionPanelProvider (the read-only sub-session modal renders this
            component with no panel around it). */}
        {!hideHeader && !readOnly && <SessionActionPanelColumn />}
      </div>
    </div>
  );
}

'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { detectCommandFromText } from '@/features/session/detect-command';
import { SessionApprovalPrompt } from '@/features/session/session-approval-prompt';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionPermissionPrompt } from '@/features/session/session-permission-prompt';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { errorMessageOf, isDeliveredButDisconnected } from '@/lib/delivered-but-disconnected';
import {
  type SandboxLifecycle,
  type SessionPrompt,
  hasRetryingAssistantTurn,
  listSessionPrompts,
  projectSessionConnection,
} from '@kortix/sdk';
import { isOptimisticSessionPrompt, useProjectSession } from '@kortix/sdk/react';
import {
  WarningIcon as AlertTriangle,
  ArrowBendUpLeftIcon,
  CaretDownIcon,
  CheckCircleIcon as CheckCircle,
  CheckIcon,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  StackIcon as Layers,
  PauseIcon,
  PlayIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  COMPOSER_EDITOR_SELECTOR,
  SUGGESTION_MENU_SELECTOR,
  shouldCountEscape,
} from './esc-to-stop';
import {
  SystemNotificationCard,
  parseSystemNotifications,
  stripSystemPtyText,
} from './message-parsing';
import { projectQueueRows } from './queue-projection';
import { createQueueUndoAction } from './queued-message-restore';
import { ActivityBurst } from './turn/activity-burst';
import {
  CompactionFailedRow,
  CompactionMarker,
  CompactionSummaryBody,
} from './turn/compaction-card';
import { compactionTurnInfo } from './turn/compaction-state';
import { ExpandableOutput } from './turn/expandable-output';
import { chatPlanAnchorId, isPlanWriteTool } from './turn/plan-anchor';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  QueuedPromptActions,
  QueuedPromptBubbles,
  type QueuedPromptState,
  QueuedPromptStatus,
} from './turn/queued-prompt-bubbles';
import { segmentTurn } from './turn/segment-turn';
import { stabilizeTurns } from './turn/stable-turns';
import { statusElapsedFrame } from './turn/status-elapsed';
import { ThrottledMarkdown } from './turn/throttled-markdown';
import { TurnViewport } from './turn/turn-viewport';
import { UserMessage } from './turn/user-message';
import { resolveWorkingTurn } from './turn/working-turn';

import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useOptionalSessionPanel } from '@/features/session/action-panel/session-panel-provider';
import { Composer as SessionChatInput } from '@/features/session/composer/composer';
import { resolveComposerAgent } from '@/features/session/composer/composer-agent-access';
import { sessionSlashFiles } from '@/features/session/composer/menus/slash-files';
import { ConnectorRequiredNotice } from '@/features/session/connector-required-notice';
import { CompactModal } from '@/features/session/header/compact-modal';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import {
  ConnectProviderDialog,
  type ModelDefaultControls,
} from '@/features/session/model-selector';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import { type TurnSpan } from '@/features/session/outcomes/anchor-outcomes';
import type { Outcome } from '@/features/session/outcomes/outcome-types';
import { SessionOutcomeSummary } from '@/features/session/outcomes/session-outcome-summary';
import { SessionOutcomesProvider } from '@/features/session/outcomes/session-outcomes-provider';
import { TurnOutcomes } from '@/features/session/outcomes/turn-outcomes';
import { SessionOverridesComposer } from '@/features/session/overrides/session-overrides-composer';
import {
  type QuestionAction,
  QuestionPrompt,
  type QuestionPromptHandle,
} from '@/features/session/question-prompt';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import type { AttachedFile, TrackedMention } from '@/features/session/session-chat-input';
import { SessionContextModal } from '@/features/session/session-context-modal';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SessionWelcome } from '@/features/session/session-welcome';
import { showTurnBusyIndicator } from '@/features/session/turn-busy-visibility';
import { SessionBusyIndicator } from './session-busy-indicator';
import { useSessionBaseRef } from './session-changes-shared';
import { resolveEffectiveBusy } from './session-chat-busy';
import { SessionTurnMeta } from './session-turn-meta';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnSpan,
} from './session-turn-meta-rows';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Loading from '@/components/ui/loading';
import { dismissToast, errorToast, infoToast } from '@/components/ui/toast';
import { uploadFile } from '@/features/files/api/runtime-files';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
// billingApi / invalidateAccountState / useQueryClient removed — billing is handled server-side by the router
import { ChatMinimap } from '@/features/session/chat-minimap';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { usePlanInChat } from '@/features/session/plan-surface';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  ToolActivateContext,
  ToolPartRenderer,
  TurnLiveContext,
} from '@/features/session/tool/tool-renderers';
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
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import {
  useAttachRequest,
  useSessionComposerPrefillStore,
  useSessionPrefill,
} from '@/stores/session-composer-prefill-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import { Copy } from '@/features/icon/icons/copy';
import { projectSessionHref } from '@/lib/navigation/session-href';
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
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
  unwrapError,
} from '@/ui';
import { isAbortError } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import {
  type AbortSettlement,
  type KortixSendError,
  type ModelKey,
  type UseSessionResult,
  abandonOptimisticSend,
  applyOptimisticAbort,
  ascendingId,
  awaitAbortSettlement,
  beginOptimisticSend,
  classifySendError,
  clearStartStash,
  formatModelString,
  formatPromptModel,
  markOptimisticSendDispatched,
  markOptimisticSendInboxBacked,
  mintSessionWireMessageId,
  parseModelKey,
  readStartStash,
  recoverFromSendFailure,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  requestRuntimeReconnect,
  startSessionWithPrompt,
  useAbortRuntimeSession,
  useExecuteRuntimeCommand,
  useProjectConfig,
  useRuntimeAgents,
  useRuntimeBootStalled,
  useRuntimeCommands,
  useRuntimeConfig,
  useRuntimeConnectionStore,
  useRuntimePendingStore,
  useRuntimePhase,
  useRuntimeProviders,
  useRuntimeReady,
  useRuntimeSession,
  useRuntimeSessions,
  useSessionModelSelection,
  useSessionPrompts,
  useSessionStateStore,
  useSessionSync,
  useSessionWorking,
  useSessionWorkingStore,
} from '@kortix/sdk/react';
import { useReloadForensics } from './reload-forensics';
import { CodeBlockEndpoints, SandboxUrlDetector } from './sandbox-url-detector';
import {
  resolveLastTurnWorking,
  serverHoldsOpenTurn,
  sessionComposerReadiness,
} from './session-composer-readiness';
import { captureTurnScrollAnchor, restoreTurnScrollAnchor } from './session-history-scroll';
import { resolveSessionContentState } from './session-load-state';
import {
  nextOlderAutoloadArm,
  olderAutoloadExhausted,
  shouldLoadOlderHistory,
} from './session-older-autoload';
import { useHeldOlderLoading } from './session-older-loading';
import { useReadinessSettling } from './use-readiness-settling';

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
          className="bg-card flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-4 py-2 text-left"
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
        <div className="space-y-2 px-3.5 py-2">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || 'No answer';
            return (
              <div key={q.question} className="space-y-0.5">
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

/** How long Stop will wait for the inbox hold before it issues the cancel
 *  anyway. The hold going first is a preference — it saves a stopped prompt
 *  from coming back a reaper pass later — while the abort is the thing the user
 *  pressed the button for, and a stalled request must never hold it hostage
 *  with the agent still running. One round-trip's worth, no more. */
const STOP_HOLD_DEADLINE_MS = 1500;

/** After this long on one status the working label shows elapsed time. */
const STATUS_STALL_AFTER_MS = 20_000;

/** Dependencies `stopThenSendNow` needs, injected so the ordering logic is
 *  directly testable without React or a DOM. */
export interface StopThenSendNowDeps {
  /** True when a turn is currently running and must be stopped first. */
  isRunning: () => boolean;
  /** The still-pending `AbortSettlement` for a stop already issued by someone
   *  else (e.g. a direct click on the Stop button), if one exists. Checked
   *  BEFORE `isRunning()`: the abort receipt makes the projection `isRunning`
   *  reads answer idle before that earlier stop's settlement arrives, so
   *  `isRunning()` alone cannot see an in-flight stop issued outside this
   *  call. Returns `undefined` when no stop is currently pending for this
   *  session. */
  pendingSettlement: () => Promise<AbortSettlement> | undefined;
  /** Issue the stop and resolve with its `AbortSettlement`, or `null` if this
   *  stop produced no trackable settlement. Called only when
   *  `pendingSettlement()` is `undefined` and `isRunning()` is true. Never
   *  expected to reject — `AbortSettlement`-producing paths
   *  (`sessionState.cancel()`, `awaitAbortSettlement`) never do. A `null`
   *  settlement means there is nothing to wait for, so the dispatch follows
   *  at once. */
  stop: () => Promise<AbortSettlement | null>;
  /** The actual send-now dispatch: `POST .../prompts/:id/retry`, which
   *  promotes the row the user pointed at and releases the session's inbox
   *  hold ITSELF, in that order. Nothing here may release the hold first —
   *  see `stopThenSendNow`'s doc. */
  dispatch: () => Promise<void>;
}

/**
 * Orchestrates "Stop & send": end the current turn (if one is running), wait
 * for that to actually settle, then dispatch.
 *
 * T10: waits for the SERVER-confirmed `AbortSettlement` `stop()`
 * returns — never a raw status slot. (There used to be a `waitForSessionIdle`
 * fallback that polled the sync-store slot; the abort's own optimistic idle
 * frame flipped that slot synchronously, so the poll resolved on its first
 * check at every reachable call site and its 5s timer was unreachable. C4
 * deleted the frame, which made the predicate constant the other way. Gone.)
 * `stop()`'s settlement is already bounded (~5s, see
 * `awaitAbortSettlement`), never rejects, and a
 * `{status:'failed'}` or `{status:'timed-out'}` result still lets `dispatch()`
 * proceed once that bound elapses: whichever cancel path produced the
 * settlement already cancelled any local in-flight delivery
 * (`abortInFlightDeliveries`) before returning it, so there is nothing left on
 * the client to race even without a server acknowledgement.
 *
 * When nothing is running and no stop is pending, `stop()` is never called
 * and the send is not delayed at all.
 *
 * IT DOES NOT LIFT THE INBOX HOLD. Stop holds every queued row
 * (`available_at = now + 24h`); "send now" is `POST .../prompts/:id/retry`,
 * and `retryInboxPrompt` promotes THAT row and only then releases the hold.
 * Lifting it here first made all held rows due at one instant and kicked a
 * drain that claims by `available_at, created_at` — so the oldest prompt ran
 * and the one the user clicked queued behind its turn. `dispatch()` owns the
 * whole ordering.
 *
 * T10 (settlement race): a stop can already be in flight when this runs —
 * e.g. the user clicked Stop directly, whose `noteAbortReceipt` makes the
 * projection `isRunning()` reads answer idle well before that stop's
 * `AbortSettlement` arrives from the server. Gating on `isRunning()` alone
 * would then see "idle" and dispatch immediately, racing the still-in-flight
 * abort. `pendingSettlement()` is consulted
 * FIRST for exactly this reason: if a settlement is already pending for this
 * session, it is awaited (and `stop()` is NOT called again — a stop was
 * already issued) before resuming/dispatching, regardless of what
 * `isRunning()` reports.
 */
export async function stopThenSendNow(deps: StopThenSendNowDeps): Promise<void> {
  const pending = deps.pendingSettlement();
  if (pending) {
    await pending;
  } else if (deps.isRunning()) {
    await deps.stop();
  }
  await deps.dispatch();
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
    const texts: string[] = [];
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored) {
        texts.push((p as TextPart).text || '');
      }
    }
    return texts.join('\n');
  }, [turn.userMessage.parts]);

  const { notifications } = useMemo(
    () => parseSystemNotifications(stripKortixSystemTags(rawText)),
    [rawText],
  );

  if (notifications.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {notifications.map((n) => (
        <SystemNotificationCard key={`${n.tag}-${n.body}`} notification={n} />
      ))}
    </div>
  );
}

// ============================================================================
// Session Turn — core turn component
// ============================================================================

/**
 * Pure derivation of "was this turn's error an abort" from a turn's assistant
 * messages — the exact logic `turnErrorIsAbort` below runs per render.
 * Extracted (T17) so it can be exercised by real behavior tests
 * (`interrupted-label.test.ts`) instead of a source-text pattern match.
 *
 * Scans for the FIRST assistant message carrying an object error (matching
 * `getTurnError`'s own "first wins" rule) and classifies THAT message once —
 * see the `useMemo` below for why identity must come from the SDK's single
 * `isAbortError` classifier.
 *
 * The abort's `AbortReason` is deliberately NOT read: every abort — a user
 * Stop, an untagged wire `MessageAbortedError`, a `'runtime-disposed'`
 * respawn — renders nothing, so the reason changes no outcome.
 */
export function deriveTurnErrorAbortState(turn: {
  assistantMessages: ReadonlyArray<{ info: unknown }>;
}): { isAbort: boolean } {
  for (const msg of turn.assistantMessages) {
    const err = (msg.info as { error?: unknown }).error;
    if (!err || typeof err !== 'object') continue;
    return { isAbort: isAbortError(err) };
  }
  return { isAbort: false };
}

interface SessionTurnProps {
  turn: Turn;
  /**
   * Both were derived HERE from `allMessages`, once per turn, on every render.
   *
   * `ownsPlan` was the worst thing in the chat: `planAnchorMessageId` walks
   * every message and calls `parts.some(...)` on each, so a fifty-turn session
   * ran an O(total-parts) scan fifty times per frame. Hoisting it to the parent
   * makes it one scan for the whole transcript. `isLast` is cheap by comparison,
   * but it took `allMessages` — a new array every frame — which alone would have
   * defeated `React.memo` on this component.
   */
  isLast: boolean;
  ownsPlan: boolean;
  sessionId: string;
  sessionStatus: import('@/ui').SessionStatus | undefined;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  agentNames?: string[];
  /** Whether this is the first turn in the session */
  isFirstTurn: boolean;
  /**
   * The session's working state, resolved ONCE by the parent
   * (`resolveLastTurnWorking`): the projection for a Kortix session, the raw
   * SSE slot only for a child session that has no `/turn` row. Only the
   * WORKING turn renders it (`isWorkingTurn`).
   */
  sessionWorking: boolean;
  /**
   * This turn is the one the agent is on — see `resolveWorkingTurn`. It used
   * to be `isLast` by definition; a prompt queued mid-turn broke that: OpenCode
   * persists it as the last user message while the agent is still streaming
   * the turn before, so the shimmer sat under a bubble nobody had started and
   * the live turn looked settled.
   */
  isWorkingTurn: boolean;
  /**
   * Suppress this turn's live busy indicator even though it is the working
   * turn. Set only when `resolveWorkingTurn` fell back to a turn whose answer is
   * already COMPLETE while queued prompts wait below it (every pending prompt
   * still held in the inbox). Without it, that finished turn's "Thinking" row
   * rendered ABOVE the just-sent (queued) message and then jumped down when the
   * prompt started running — the reposition the transcript must never do. A
   * finished turn shows nothing; the queued turns render as their own dimmed
   * bubbles until one starts and legitimately becomes the working turn.
   */
  suppressBusyIndicator: boolean;
  /**
   * A user message the agent has not reached yet — after the working turn,
   * with no assistant content. Drawn dimmed, like a queued prompt (it IS one:
   * the server forwarded it and OpenCode holds it until the next step), and
   * it fades up to full opacity the moment the agent takes it.
   */
  pending: boolean;
  /**
   * The inbox row behind this turn's user message, while the row is still
   * live (queued, held, delivering, failed). Puts remove / send-now / retry
   * in the bubble's own meta row — the bubble IS the queue entry.
   */
  queueRow?: SessionPrompt | null;
  queueHeld?: boolean;
  onQueueRemove?: (promptId: string) => void;
  onQueueSendNow?: (promptId: string) => void;
  onQueueRetry?: (promptId: string) => void;
  /**
   * A Stop ended the turn before a step opened under this user message: the
   * runtime holds it and runs it with the next send. Drawn dimmed like any
   * queued prompt, with the meta row saying so.
   */
  interruptedBeforeRun?: boolean;
  /** Whether this turn contains a compaction */
  isCompaction?: boolean;
  /**
   * Open a landed compaction summary in the panel's DETAIL view. Provided by
   * the parent (which already subscribes to the panel context) so this
   * memoized component doesn't have to — the context value churns with
   * messages. Absent → the marker keeps its inline-disclosure fallback.
   */
  onOpenCompactionSummary?: (turnId: string, summary: string) => void;
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
  /** Open the inline edit-from-here editor on this turn's user message. */
  onRewind: (messageId: string, text: string) => void;
  /** Disable history changes while the session is busy or read-only. */
  rewindDisabled: boolean;
  /**
   * Non-null when THIS turn's user message is being edited from here — the
   * bubble renders as the full-width inline editor prefilled with this text.
   */
  editingText?: string | null;
  /** The staged rewind + replacement send is in flight. */
  editPending?: boolean;
  onEditCancel?: () => void;
  /** Commit the edit: rewind the session at `messageId` and send `text`. */
  onEditSend?: (messageId: string, text: string) => void;
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

function SessionTurnImpl({
  turn,
  isLast,
  ownsPlan,
  sessionId,
  sessionStatus,
  permissions,
  questions,
  agentNames,
  isFirstTurn,
  sessionWorking,
  isWorkingTurn,
  suppressBusyIndicator,
  pending,
  queueRow,
  queueHeld,
  onQueueRemove,
  onQueueSendNow,
  onQueueRetry,
  interruptedBeforeRun,
  isCompaction,
  onOpenCompactionSummary,
  providers,
  commandMessages,
  commands,
  disableToolNavigation,
  onPermissionReply,
  onRewind,
  rewindDisabled,
  editingText,
  editPending,
  onEditCancel,
  onEditSend,
}: SessionTurnProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );

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
        // `isPlanWriteTool` — NOT a bare `=== 'todowrite'`. The runtime emits
        // both spellings, and the plan card owns both (see plan-anchor.ts).
        if (isPlanWriteTool(part.tool) || part.tool === 'task' || part.tool === 'question')
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
  // The WORKING turn's working state is the session's, and the parent resolved
  // that answer once (`resolveLastTurnWorking`): the projection
  // (`useSessionWorking` → `GET .../turn`) for a Kortix session, the raw SSE
  // slot only for a child session with no `/turn` row. Any other turn is
  // NEVER working — that is a fact about the transcript, not an observation,
  // and it is what removes the "last turn shimmers for ever" symptom the raw
  // slot's dropped end-of-turn frames caused here.
  const working = isWorkingTurn && sessionWorking;
  // A compaction turn's message-state — `inFlight` (summary open: not
  // completed, not errored) is the half of "is this compaction running" the
  // working projection cannot see, because it deliberately knows nothing
  // about compaction.
  const compactionInfo = useMemo(
    () => (isCompaction ? compactionTurnInfo(turn) : null),
    [isCompaction, turn],
  );
  const compactionInFlight = compactionInfo?.inFlight ?? false;
  // The bubble is the queue entry: while its inbox row is live, the row's
  // state decides the controls in the bubble's meta row.
  const rowState: QueuedPromptState | null = !queueRow
    ? null
    : queueRow.state === 'failed'
      ? 'failed'
      : queueRow.state === 'delivering'
        ? 'in-flight'
        : queueRow.reason === 'held' || queueHeld
          ? 'held'
          : 'queued';
  // Only while the bubble is still WAITING (dimmed) — or has something to
  // say regardless (held, failed). A row that reads `delivering` for the rest
  // of the turn in front of it must not label a bubble the agent has reached.
  const queueState: QueuedPromptState | null =
    rowState && (pending || rowState === 'held' || rowState === 'failed')
      ? rowState
      : interruptedBeforeRun
        ? 'interrupted'
        : null;
  // The word under the bubble. A PENDING bubble says "Queued" even when its
  // inbox row is already closed (the runtime holds the message, the agent has
  // not reached it): the dim alone reads as "something is wrong".
  const statusState: QueuedPromptState | null = queueState ?? (pending ? 'queued' : null);
  // What the X removes: the row while it is listed, the message's own wire id
  // after the row left the list (the DELETE route resolves `msg_…` handles) —
  // for any bubble the agent has not reached.
  const queueRemovalId =
    onQueueRemove && statusState && statusState !== 'interrupted' && statusState !== 'failed'
      ? (queueRow?.prompt_id ?? turn.userMessage.info.id)
      : null;
  // Send-now / retry / remove all live in `UserMessageActions` (`leading`).
  // A pending bubble can outlive its inbox row; the X still has to work, so
  // the action id falls back to the user message's own wire id.
  const queueActionId = queueRemovalId ?? queueRow?.prompt_id ?? null;
  const showQueueActions =
    Boolean(queueActionId) &&
    (Boolean(queueRemovalId) || Boolean(queueRow && queueState && queueState !== 'interrupted'));

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
    let text = '';
    for (const p of activeAssistantMessage.parts) {
      if (isTextPart(p)) text += p.text ?? '';
    }
    return text;
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
  // The landed summary opens in the panel's DETAIL view — the same surface a
  // file opens into — instead of expanding inline in the transcript. The
  // parent owns the panel handle (deliberately NOT `useOptionalSessionPanel`
  // here: the panel context value carries files/apps/detail and churns with
  // messages, so a per-turn context read would defeat this component's memo
  // for the whole transcript). Absent prop → the marker's inline fallback.
  const openCompactionSummary = useCallback(() => {
    onOpenCompactionSummary?.(turn.userMessage.info.id, response);
  }, [onOpenCompactionSummary, turn.userMessage.info.id, response]);
  // Retry info (only on last turn). These KEEP reading the raw `sessionStatus`
  // frame on purpose: they render the retry *reason* carried on the frame
  // (attempt count, provider message, next-retry time), which the working
  // projection does not carry. Do not "finish the job" by moving them to the
  // projection — the shimmer decision above is the only thing that moved.
  const retryInfo = useMemo(
    () => (isWorkingTurn ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );
  const retryMessage = useMemo(
    () => (isWorkingTurn ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
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

  /**
   * Was the turn ACTUALLY aborted, as opposed to failing with a message that
   * happens to contain the word?
   *
   * `getTurnError` flattens the structured error to a display string and drops
   * its `name`, so the banner was left substring-matching "abort" over arbitrary
   * prose — which classifies a genuine failure as a stop and, since a stop
   * renders nothing, hides what really went wrong. The identity is right here
   * on the message; read it
   * through the SDK's single `isAbortError` classifier, which recognizes both
   * real producers: the opencode wire's `MessageAbortedError` and the client's
   * synthesized `AbortError` patch applied when the user hits Stop.
   */
  const turnErrorIsAbort = useMemo(() => deriveTurnErrorAbortState(turn).isAbort, [turn]);

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
      questions.flatMap((q) =>
        q.sessionID === sessionId && q.tool?.callID ? [q.tool.callID] : [],
      ),
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
    const texts: string[] = [];
    for (const p of turn.userMessage.parts) {
      if (!isTextPart(p) || (p as TextPart).synthetic || (p as any).ignored) continue;
      const text = stripSystemPtyText((p as TextPart).text);
      if (text.trim()) texts.push(text);
    }
    return texts.join('\n').trim();
  }, [turn.userMessage.parts]);

  const commandForTurn = useMemo(() => {
    const mapped = commandMessages?.get(turn.userMessage.info.id);
    if (mapped) return mapped;
    if (!userMessageText) return undefined;
    return detectCommandFromText(userMessageText, commands);
  }, [commandMessages, turn.userMessage.info.id, userMessageText, commands]);

  // ---- Status throttling (2.5s) ----
  const [statusThrottleStart] = useState(() => Date.now());
  const lastStatusChangeRef = useRef(statusThrottleStart);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
  const rawStatus = useMemo(
    () => getTurnStatus(allParts, childMessages),
    [allParts, childMessages],
  );
  const [throttledStatus, setThrottledStatus] = useState('');
  // How long the status has read the same thing. Past STATUS_STALL_AFTER_MS
  // the label carries the elapsed time, so a slow model step or a long tool
  // call reads as "still working, this long" instead of a frozen screen.
  const [statusElapsedState, setStatusElapsedState] = useState(() =>
    statusElapsedFrame(undefined, {
      status: throttledStatus,
      working,
      nowMs: Date.now(),
    }),
  );
  const statusElapsedMs =
    statusElapsedState.status === throttledStatus && statusElapsedState.working === working
      ? statusElapsedState.elapsedMs
      : 0;
  useEffect(() => {
    const update = () =>
      setStatusElapsedState((previous) =>
        statusElapsedFrame(previous, {
          status: throttledStatus,
          working,
          nowMs: Date.now(),
        }),
      );
    update();
    if (!working) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [working, throttledStatus]);
  /** The phrase alone — never the elapsed time. Folding the ticking duration in
   *  here changed the busy indicator's animation key once a second, which
   *  replayed its roll-swap forever during any long tool call. */
  const statusPhrase =
    throttledStatus && working && statusElapsedMs >= STATUS_STALL_AFTER_MS
      ? throttledStatus.replace(/(\.\.\.|…)$/, '')
      : throttledStatus;
  const statusElapsedLabel =
    throttledStatus && working && statusElapsedMs >= STATUS_STALL_AFTER_MS
      ? formatDuration(statusElapsedMs)
      : undefined;

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
          .flatMap((item) => {
            if (item.type !== 'text') return [];
            const text = (item.part as TextPart).text?.trim();
            return text ? [text] : [];
          })
          .join('\n\n')
      : response;
    if (!textToCopy) return;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Parts with a pending permission need a visible, actionable surface — they
  // must never fold into a collapsed burst. Answered questions are NOT
  // standalone: they are a step of the turn (the agent asked, the user
  // answered, the work continued), so they render inside the activity burst as
  // their own chain row (`AnsweredQuestionStep` in turn/answered-question-step)
  // instead of a card that force-splits the burst around it. Pending/dismissed
  // questions are not standalone either: the real, actionable prompt for
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
    return ids;
  }, [permissions, sessionId]);

  /**
   * The turn's parts, cut into bursts / standalone tools / text.
   *
   * This ran INLINE in the JSX below, which meant a `map`, a `filter` and the
   * whole of `segmentTurn` on every render of this turn — and, worse, a brand
   * new `segment.parts` array for every burst every time. `ActivityBurst` keys
   * its `useMemo`s on `parts`, so a fresh array identity per render made every
   * one of them a guaranteed miss: `mergeBurstSteps`, `burstSummary` and
   * `stepLabel` recomputed for every burst in the turn on every frame, and no
   * `React.memo` below could ever hold. A turn re-renders for reasons that have
   * nothing to do with its parts — a hover, a permission arriving, the parent's
   * state — and each of those paid the full price.
   *
   * Memoised, the arrays keep their identity until the parts actually change,
   * which is what makes the memo boundaries downstream able to bite.
   */
  const segments = useMemo(() => {
    const parts: (typeof allParts)[number]['part'][] = [];
    for (const { part } of allParts) {
      if (isToolPart(part) && isPlanWriteTool(part.tool)) continue;
      if (isToolPart(part) && part.tool === 'question') {
        // Keep only answered questions, and only if not rendering inline.
        if (!answeredQuestionPartsById.has(part.id) || shouldUseInlineContent) continue;
        // A kept question rides into its burst as the ANSWERED part — the
        // one from answeredQuestionParts, possibly synthetic with
        // optimistically-cached or output-parsed answers the raw store part
        // does not carry yet. Without this substitution the burst row would
        // show "0 answered" until the server confirms.
        parts.push(answeredQuestionPartsById.get(part.id) ?? part);
        continue;
      }
      parts.push(part);
    }
    return segmentTurn(parts, { standaloneCallIds });
  }, [allParts, answeredQuestionPartsById, shouldUseInlineContent, standaloneCallIds]);

  // ============================================================================
  // Shell mode — short-circuit rendering
  // ============================================================================

  if (shellModePart) {
    return (
      <TurnLiveContext.Provider value={working}>
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
              isAbort={turnErrorIsAbort}
              className="mt-2"
            />
          )}
          <ConnectProviderDialog
            open={connectProviderOpen}
            onOpenChange={setConnectProviderOpen}
            providers={providers}
          />
        </div>
      </TurnLiveContext.Provider>
    );
  }

  // ============================================================================
  // Compaction mode — render as a distinct card, no user bubble / logo / steps
  // ============================================================================

  // While `working`, the summary is still streaming: render the SAME card with
  // the streaming markdown inside it, instead of falling through to the normal
  // turn renderer (which streamed the summary as bare prose and then swapped
  // shape into this card at the end). A finished compaction with an empty
  // response (e.g. aborted before any token) still falls through, as before.
  // `working` (the projection) OR the summary message's own open state: the
  // projection treats compaction as "not a turn", so around stream start/end
  // the two disagree for a few frames — and classifying by projection alone
  // flapped this turn between renders, a height oscillation at the end of the
  // transcript that yanked the reader's scroll position around. See
  // `compactionTurnInfo.inFlight`.
  //
  // The marker is the WHOLE render for a compaction turn — divider pill while
  // running, pill-with-disclosure once landed. `hasContent` keeps a landed
  // compaction that carries only a `compaction` part (no summary text) on the
  // marker instead of misfiling it as a failed attempt.
  if (isCompaction) {
    const compactionRunning = working || compactionInFlight;
    if (compactionRunning || response || compactionInfo?.hasContent) {
      return (
        <div className="group/turn">
          <CompactionMarker
            running={compactionRunning}
            summary={response}
            onOpenSummary={onOpenCompactionSummary ? openCompactionSummary : undefined}
          />
        </div>
      );
    }
    // An attempt that produced nothing (errored, or stopped before the first
    // token) collapses to one slim row. Falling through to the normal turn
    // renderer drew a full-height turn scaffold per attempt — a retry loop
    // left a stack of near-empty screens with one error line each.
    //
    // `getTurnError`/`deriveTurnErrorAbortState` read only assistantMessages,
    // which a SYNTHETIC compaction turn (summary message as `userMessage`,
    // empty assistantMessages) has none of — the helper's own `error` is the
    // fallback that keeps the row's error text for those.
    const compactionRawError = compactionInfo?.error;
    const compactionErrorText =
      turnError ?? (compactionRawError != null ? unwrapError(compactionRawError) : undefined);
    const compactionIsAbort =
      turnErrorIsAbort ||
      (typeof compactionRawError === 'object' &&
        compactionRawError !== null &&
        isAbortError(compactionRawError));
    return (
      <div className="group/turn">
        <CompactionFailedRow error={compactionErrorText} isAbort={compactionIsAbort} />
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
    <div className="group/turn text-factor-[2] space-y-2.5">
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
        <div
          data-turn-pending={pending || interruptedBeforeRun || undefined}
          data-turn-queue-state={queueState ?? undefined}
          className={cn(
            'transition-opacity duration-500',
            (pending || interruptedBeforeRun) && QUEUED_BUBBLE_OPACITY_CLASS,
          )}
        >
          <UserMessage
            message={turn.userMessage}
            agentNames={agentNames}
            commandInfo={commandMessages?.get(turn.userMessage.info.id)}
            commands={commands}
            sessionId={sessionId}
            ownsPlan={ownsPlan}
            onRewind={onRewind}
            rewindDisabled={rewindDisabled}
            editingText={editingText}
            editPending={editPending}
            onEditCancel={onEditCancel}
            onEditSend={onEditSend}
            leadingStatus={
              statusState ? (
                <QueuedPromptStatus
                  state={statusState}
                  lastError={queueRow?.last_error ?? undefined}
                />
              ) : undefined
            }
            leadingActions={
              showQueueActions && queueActionId ? (
                <QueuedPromptActions
                  id={queueActionId}
                  state={queueState ?? statusState ?? 'queued'}
                  onRemove={queueRemovalId && onQueueRemove ? onQueueRemove : undefined}
                  onSendNow={onQueueSendNow}
                  onRetry={onQueueRetry}
                />
              ) : undefined
            }
            actionsAlwaysVisible={queueState === 'failed'}
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
			    - the plan write (`todowrite` / `todo_write`, matched by
			      `isPlanWriteTool`) — the Easy panel's Plan card (mobile: the
			      plan card beneath the user message) is the single canonical
			      todo surface; showing the same checklist again inside a burst
			      would just duplicate it.
			    - `question`: only answered questions are kept — they fold into
			      their burst as a "Questions · N answered" chain row
			      (turn/answered-question-step.tsx). Pending and dismissed
			      questions are dropped entirely. Additionally, answered
			      questions are dropped when rendering inline content (below),
			      since that mode shows them already, in natural order. */}
      {(working || hasSteps || hasReasoning) && turn.assistantMessages.length > 0 && (
        // Every tool row below — the bursts' rows and the standalone ones —
        // reads this to tell a call that has not spoken YET from one that never
        // will. Provided here rather than per-row because `working` is a fact
        // about the TURN, and this block is the turn's whole part tree.
        // See `TurnLiveContext`.
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
                    disableNavigation={disableToolNavigation}
                    density={conversationDensity}
                  />
                );
              }

              if (segment.kind === 'standalone') {
                if (!shouldShowToolPart(segment.part)) return null;
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
        </TurnLiveContext.Provider>
      )}

      {/* ── Screen reader ──
          Announce COMPLETION only. Mirroring the full response here duplicated
          every turn in the DOM, so select-all across the transcript copied each
          answer twice. The visible markdown is already in the a11y tree. */}
      <div className="sr-only" aria-live="polite">
        {!working && response ? 'Response complete' : ''}
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
              <div className="space-y-2">
                <div className="bg-secondary flex w-full flex-col overflow-hidden rounded-lg">
                  <div className="text-foreground flex min-w-0 items-center justify-between gap-2 p-3 pb-0 text-xs [&>svg]:size-4">
                    <span
                      className="bg-popover text-foreground/95 dark:bg-card min-w-0 truncate rounded-[calc(var(--radius-sm)-0.5px)] border px-1.5 py-[0.08rem] align-baseline font-mono text-[0.95em] font-medium wrap-anywhere whitespace-nowrap"
                      title={`/${commandForTurn.name}`}
                    >
                      {commandForTurn.name}
                    </span>
                  </div>
                  {/* Command output clamps to a readable height and opens from a
                      centred toggle on the fade. `from-secondary` matches the
                      panel this sits on — the gradient has to dissolve into the
                      surface, not paint a band over it. */}
                  <ExpandableOutput
                    className="min-h-0"
                    fadeClassName="from-secondary"
                    contentClassName="px-4 py-3 text-sm"
                  >
                    <SandboxUrlDetector content={response} isStreaming={false} />
                  </ExpandableOutput>
                </div>
                <CodeBlockEndpoints content={response} />
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
      {showTurnBusyIndicator({
        working: working && !suppressBusyIndicator,
        hasError: !!turnError,
        isRetrying: !!retryInfo,
      }) && (
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
            statusText={statusPhrase || undefined}
            elapsedLabel={statusElapsedLabel}
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
      {turnError && (
        <TurnErrorDisplay
          errorText={turnError}
          errorDetails={turnErrorDetails}
          isAbort={turnErrorIsAbort}
        />
      )}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Outcomes — what this turn left behind ──
          Always visible, unlike the hover-revealed action bar below. A hidden
          record of a change request is a trust bug: the point of
          the card is that a durable side effect cannot happen quietly.

          Gated on `!working` for the same reason the action bar is — an
          outcome is a settled fact, and a card that appears mid-stream would
          claim a change request exists before the server has one. */}
      {!working && <TurnOutcomes turnKey={turn.userMessage.info.id} />}

      {/* ── Action bar (copy + turn meta) ──
          Gated on `!working` only. A turn that ends in tool calls has no closing
          prose, but its finished-at / duration / cost are still turn facts —
          `SessionTurnMeta` self-hides when it has no rows. Only the copy button
          needs a response to copy.

          `max-md:opacity-100` — same rule as the user turn's meta row
          (`turn/user-message.tsx`): hover-to-reveal is a desktop affordance.
          On touch there is no hover, so Copy and the turn's finished-at /
          duration / cost would be permanently invisible, and tap-emulated
          `:hover` would leave exactly one arbitrary turn's bar lit. */}
      {!working && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
          {response ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy response'}
              className="hit-area-3"
            >
              <span className="relative inline-flex shrink-0 items-center justify-center">
                <AnimatePresence initial={false} mode="popLayout">
                  <m.span
                    key={copied ? 'check' : 'copy'}
                    initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                    animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                    exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                    transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                    className="absolute inset-0 inline-flex items-center justify-center"
                  >
                    {copied ? (
                      <CheckIcon className="text-foreground/70 size-[1.05rem]" />
                    ) : (
                      <Copy className="text-foreground/70 size-[1.05rem]" />
                    )}
                  </m.span>
                </AnimatePresence>
              </span>
            </Button>
          ) : null}
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

/**
 * The boundary that stops the transcript re-rendering with the stream.
 *
 * `messages` is rebuilt on every SSE frame, so this component used to re-render
 * for every turn in the session ~60 times a second — and each of those renders
 * re-ran ~28 `useMemo`s (all keyed on `turn`), a `planAnchorMessageId` scan of
 * the whole transcript, `segmentTurn`, and every tool renderer beneath it.
 * `content-visibility: auto` on the wrapper hid the layout cost of that, not the
 * JavaScript.
 *
 * The default shallow compare is correct here ONLY because three things were
 * fixed first, and each is load-bearing: `turn` keeps its identity when its
 * messages have not changed (`stabilizeTurns`), the `allMessages` array prop is
 * gone (replaced by the `isLast` / `ownsPlan` booleans derived once above), and
 * `onRewind` is a `useCallback` rather than an inline arrow. Any one of the
 * three reverting silently turns this memo back into a no-op — it would still
 * compile, still pass tests, and simply never bail out.
 */
const SessionTurn = memo(SessionTurnImpl);
SessionTurn.displayName = 'SessionTurn';

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
  /**
   * Fired once this component is painting a real surface — the conversation or
   * the not-found card — rather than its own "starting" loader.
   *
   * The project-session route crossfades the instant boot shell into this
   * component over 300ms. It used to start that fade as soon as an OpenCode
   * session id existed, which is earlier than this component has anything to
   * show: the fade landed on the compact `SessionStartingLoader` below, which
   * then swapped to the transcript. Two handovers where the user asked for one.
   */
  onContentReady?: () => void;
  /**
   * Hold the composer's mount-time autofocus.
   *
   * `useComposerFocus` decides "am I visible?" from `offsetParent`, which does
   * not care that this whole subtree is sitting behind an opaque overlay — so
   * the composer grabs focus the instant it mounts, out from under whatever the
   * user is actually looking at. That used to be harmless by accident: the boot
   * shell was torn down in the same commit the chat mounted, so the focus it
   * lost belonged to a dying element. Now the shell is deliberately pinned
   * until the crossfade, and the steal would land on a live input the user may
   * be mid-sentence in.
   *
   * `Composer` reads `autoFocus ?? (viewport >= 640px)`, and the focus effect is
   * keyed on that resolved value — so flipping this false to true on
   * `chatReady` focuses the composer exactly once, as the overlay dissolves.
   */
  deferComposerFocus?: boolean;
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
  onContentReady,
  deferComposerFocus,
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
  // The composer's `/compact` row opens this instance; the header keeps its
  // own independently-stated one (two mounted Modals, at most one ever open).
  const [compactModalOpen, setCompactModalOpen] = useState(false);

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
  // Set the first time the reader scrolls the transcript UP, and read by the
  // older-history sentinel: history loads when someone reaches for it, never
  // because the first page happened to be shorter than the viewport.
  const readerScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef<number | null>(null);
  const handleChatScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setSelectionPopup(null);
    const top = event.currentTarget.scrollTop;
    if (lastScrollTopRef.current !== null && top < lastScrollTopRef.current) {
      readerScrolledUpRef.current = true;
    }
    lastScrollTopRef.current = top;
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

  // ---- Hooks ----
  // runtimeReady gates the session query (it's disabled until the sandbox
  // runtime is connected + healthy). We need it here too so the render logic
  // can tell "still booting" apart from "genuinely gone".
  const runtimeReady = useRuntimeReady();
  // "The health poller GAVE UP", which `!runtimeReady` does not say — that is
  // also every ordinary boot. Only the composer notice reads it, to tell a probe
  // that has not answered yet from one that keeps failing.
  const runtimeUnreachable = useRuntimeConnectionStore((s) => s.status === 'unreachable');
  const { data: session, isFetched: sessionFetched } = useRuntimeSession(sessionId);
  // useSessionSync is the SINGLE source of truth for messages (matches OpenCode SolidJS).
  // It fetches on first access, then SSE events keep it up to date.
  // No React Query fallback — prevents stale refetches from overwriting live data.
  const localSync = useSessionSync(sessionState ? '' : sessionId);
  const {
    messages: syncMessages,
    isLoading: syncMessagesLoading,
    // Transcript-read state. `loading` with no messages is a WAIT (the box may
    // be waking — the SDK keeps retrying), `error` with no messages is a
    // failure that needs a retry affordance. Neither is an empty session: a
    // swallowed 503 used to render exactly that, blank and "complete".
    freshness: transcriptFreshness,
    retryTranscript,
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
  );
  const hasPendingApproval = (approvalAudit?.actions ?? []).some(isPendingAction);
  const { data: commands } = useRuntimeCommands();
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: allSessions } = useRuntimeSessions();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const abortSession = useAbortRuntimeSession();
  const executeCommand = useExecuteRuntimeCommand();

  // THE send path. Every prompt this composer accepts becomes a durable server
  // row before anything else happens, so a closed tab, a second device, or a
  // crash cannot lose it, and the server — not this component — decides whether
  // it runs now or waits for the turn in flight.
  const promptInbox = useSessionPrompts(projectId, projectSessionId);

  // T10: the most recently issued stop/cancel's `AbortSettlement`
  // promise for this session, so `stopThenSendNow` (used by
  // `handleQueueSendNow`) can await the SERVER-confirmed settlement instead
  // of racing the optimistic idle flip `applyOptimisticAbort` makes
  // synchronously. Keyed by sessionId even though this component instance is
  // 1:1 with a session, matching the sessionId-keyed conventions used
  // elsewhere in this file (e.g. the zustand stores) rather than assuming the
  // prop never changes across this instance's lifetime.
  const pendingAbortSettlementRef = useRef<Map<string, Promise<AbortSettlement>>>(new Map());

  /**
   * The one place that issues a stop/cancel for this session's run, whether
   * through the mounted `sessionState` hook or the fallback raw mutation.
   * Both branches resolve a real `AbortSettlement` (never throwing — see
   * `awaitAbortSettlement`) and stash it in `pendingAbortSettlementRef` for
   * `stopThenSendNow` to await. Cleared once it settles so a stale settlement
   * never gates an unrelated future send.
   */
  const issueSessionCancel = useCallback((): Promise<AbortSettlement> => {
    // The stop's own receipt, taken before the cancel goes out and settled
    // when it is acknowledged. `applyOptimisticAbort` writes an idle status
    // frame, which invalidates the `/turn` query — and the read that comes
    // back still shows the turn, because the cancel needs ~1.6s to reach the
    // daemon. Without this the composer flipped Send back to Stop ~120ms after
    // the click and stayed there for the whole abort. See `AbortReceipt`.
    useSessionWorkingStore.getState().noteAbortReceipt(projectSessionId ?? '', Date.now());
    const settlement = sessionState
      ? sessionState.cancel()
      : awaitAbortSettlement(() => abortSession.mutateAsync(sessionId));
    pendingAbortSettlementRef.current.set(sessionId, settlement);
    void settlement.finally(() => {
      useSessionWorkingStore.getState().settleAbortReceipt(projectSessionId ?? '', Date.now());
      if (pendingAbortSettlementRef.current.get(sessionId) === settlement) {
        pendingAbortSettlementRef.current.delete(sessionId);
      }
    });
    return settlement;
  }, [sessionId, projectSessionId, sessionState, abortSession]);

  // ---- Unified model/agent/variant state (1:1 port of SolidJS local.tsx) ----
  const local = useSessionModelSelection({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.open_code_default_agent,
  });
  // The agent picker defaults to the session's agent (seeded via useRuntimeLocal's
  // boundAgentName) but stays switchable: sends use the current pick. Switching
  // mid-session is allowed everywhere — the grant re-mint re-resolves the
  // connector tokens for the newly picked agent on every turn.
  /**
   * The agent this composer will ACTUALLY run — see `composer-agent-access.ts`.
   *
   * Project agents are deny-by-default for a member: `agents` can come back
   * empty, and the project's `default_agent` may not be in it. `local.agent`
   * resolves over the SDK's visible roster (subagents included) and yields
   * `undefined` on an empty one, which rendered no agent in the picker while
   * the send still went out under the server's manifest default.
   */
  const composerAgent = resolveComposerAgent({
    agents,
    boundAgent: boundAgentName,
    defaultAgent: projectConfig?.open_code_default_agent,
    selectedAgent: local.agent.current?.name ?? null,
  });
  const composerAgentName = composerAgent.selected;
  const noAccessibleAgents = composerAgent.disabled;
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

  const [commandError, setCommandError] = useState<KortixSendError | null>(null);
  // The last prompt handed to the runtime, verbatim. Only read by the
  // connector-refusal card, to re-send exactly what was refused.
  const lastSubmittedRef = useRef<{ parts: unknown[]; options: Record<string, unknown> } | null>(
    null,
  );
  // The message currently open in the inline edit-from-here editor. Setting
  // this swaps that bubble for the full-width editor; nothing is staged
  // against the session until the editor's Send.
  const [rewindTarget, setRewindTarget] = useState<{
    messageId: string;
    text: string;
  } | null>(null);
  const [editSendPending, setEditSendPending] = useState(false);
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
  // WHICH held draft the composer is handed right now, in priority order, in
  // ONE place. The four sources mint their ids from four independent counters,
  // so `prefill.id` alone cannot say which one the composer just applied — and
  // the carried draft's handshake below has to know exactly that.
  const composerPrefill = useMemo(() => {
    if (sessionPrefill) {
      return {
        source: 'session' as const,
        text: sessionPrefill.text,
        id: sessionPrefill.id,
        mode: 'merge' as const,
      };
    }
    return null;
  }, [sessionPrefill]);
  // "Add context" (Task 5) — the empty Context card's button asks the
  // composer to open its attach flow. Same held/id-keyed handoff as the
  // prefill above, cleared the same way once the composer's own id-keyed
  // effect has acted on it.
  const attachRequestId = useAttachRequest(sessionId);
  useEffect(() => {
    if (attachRequestId != null) {
      useSessionComposerPrefillStore.getState().clearAttachRequest(sessionId);
    }
  }, [attachRequestId, sessionId]);
  // Map of user message IDs → command info, so UserMessage can render
  // a compact command pill instead of the raw expanded template text.
  const commandMessagesRef = useRef<
    Map<string, { name: string; args?: string; split?: { before: string; after: string } }>
  >(new Map());
  // Stash the pending command info so we can associate it with the user message
  // even if the busy signal arrives before the message list updates.
  const pendingCommandStashRef = useRef<{
    name: string;
    args?: string;
    /** Where the chip sat in `args` — display only. See `handleCommand`. */
    split?: { before: string; after: string };
  } | null>(null);
  /**
   * This tab's record that a prompt went out, and when.
   *
   * It replaces `pendingSendInFlight` — a boolean set on send, cleared by an
   * effect that watched for a busy status or a matching assistant reply, and
   * backstopped by a 30s timer because both of those signals can be lost. The
   * receipt is the same fact with a bound and a provenance tag: it claims
   * `working` only until a server source that CAN know about the send answers,
   * and `projectWorking` releases it either way — see `useSessionWorking`.
   *
   * It lives in the SDK's per-session store rather than in this component
   * because `useSession` mounts a projection for the SAME session and both
   * share one `GET .../turn` cache entry. With a receipt each, the observer
   * that had none polled on its own timer, wrote an uninformed "no turns" read
   * into that shared entry, and flipped this composer to idle mid-send.
   *
   * `note` is taken before the POST; `accept` is what lets a `/turn` read
   * answer for the send at all, because until `POST .../prompts` returns there
   * is no row for it to see. Only the paths that know nothing is coming clear
   * it — a refused send, Stop, and leaving the session.
   */
  const receiptSessionId = projectSessionId ?? '';
  const noteSendReceipt = useCallback(
    (messageId: string, turnId: string | null = messageId) =>
      useSessionWorkingStore
        .getState()
        .noteSendReceipt(receiptSessionId, { messageId, turnId, atMs: Date.now() }),
    [receiptSessionId],
  );
  const acceptSendReceipt = useCallback(
    (messageId: string) =>
      useSessionWorkingStore.getState().acceptSendReceipt(receiptSessionId, messageId, Date.now()),
    [receiptSessionId],
  );
  const clearSendReceipt = useCallback(
    // The id is REQUIRED of every caller that has one: `clearSendReceipt` is
    // keyed by session, so an unguarded clear from an older send's failure
    // deleted a NEWER send's receipt while its POST was still on the wire, and
    // an uninformed `/turn` read then flipped the composer back to Send
    // mid-send. Omitted only where nothing is coming for ANY send.
    (messageId?: string) =>
      useSessionWorkingStore.getState().clearSendReceipt(receiptSessionId, messageId),
    [receiptSessionId],
  );

  // ---- Start-stash PICKS seeding (model/agent/variant) ----
  //
  // The stash no longer carries the first prompt for this host: the prompt is
  // a durable inbox row before this component ever mounts (created server-side
  // from `create.pending_prompt`, or POSTed by `startSessionWithPrompt`), and
  // it renders in the queue strip like every other pending prompt. What still
  // travels here are the producer's PICKS, seeded once into this session's
  // local stores. The old replay effect — a 30s readiness poll, an optimistic
  // bubble that its own timeout path never cleared, and per-send receipt
  // bookkeeping — is gone with the hand-off it served.
  //
  // A NON-empty prompt in the stash is a legacy hand-off (a pre-deploy tab, or
  // an unconverted producer): POST it to the inbox rather than dropping it.
  useEffect(() => {
    if (pendingPromptHandled.current) return;
    const stash = readStartStash(sessionId);
    if (!stash) return;
    pendingPromptHandled.current = true;
    clearStartStash(sessionId);
    if (stash.agent) localAgentSet(stash.agent);
    // The seed and the legacy replay share ONE validity check. A stash written
    // under the other provider mode (e.g. a `kortix` pick from before the
    // project's llm_gateway flag flipped off) must neither seed the store nor
    // ride the legacy prompt — it names a provider this session does not have.
    const stashModelValid =
      !!stash.model &&
      localModelList.some(
        (m) => m.providerID === stash.model!.providerID && m.modelID === stash.model!.modelID,
      ) &&
      localModelVisible(stash.model as ModelKey);
    if (stashModelValid) {
      localModelSet(stash.model as ModelKey, { autoSeed: true });
    }
    if (stash.variant) localVariantSet(stash.variant);
    const legacyPrompt = stash.prompt.trim();
    if (legacyPrompt && projectId && projectSessionId) {
      void startSessionWithPrompt(projectId, projectSessionId, {
        parts: [{ type: 'text', text: legacyPrompt }],
        overrides: {
          ...(stash.agent ? { agent: stash.agent } : {}),
          ...(stashModelValid ? { model: stash.model } : {}),
          ...(stash.variant ? { variant: stash.variant } : {}),
        },
      }).catch((error) => {
        console.error('[session-chat] failed to queue the stashed legacy prompt', error);
        setCommandError(classifySessionError(error));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId, projectSessionId]);

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
  // A NEW user bubble in the transcript is a queue row that just landed —
  // OpenCode persisted a forwarded prompt. Re-read the inbox NOW so the row
  // leaves the strip in the same beat its bubble appears, instead of on the
  // next poll: the two were visible together for up to a poll interval.
  const newestUserBubbleId = lastUserMessage?.info.id;
  useEffect(() => {
    if (!newestUserBubbleId) return;
    void promptInbox.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestUserBubbleId]);
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

  /**
   * IS THIS SESSION WORKING — one answer, and it says where it came from.
   *
   * It used to be read straight off the SSE status slot, which is a stream
   * this tab can miss frames from: a dropped end-of-turn frame left the
   * composer on "stop" until a reload, and a dropped start-of-turn frame let
   * the queue drain into a live turn. The projection reads the control plane's
   * turn authority first (`GET .../turn`), the stream second, and this tab's
   * own send receipt only until either of them answers.
   */
  // A child-session mount (`sub-session-modal.tsx` passes no project ids) has
  // no Kortix session row for `/turn` to answer about, so the projection below
  // is disabled and every working read falls back to the raw stream slot —
  // the same split `session-layout.tsx` makes for its busy indicator.
  const isChildSession = !projectId || !projectSessionId;
  const working = useSessionWorking(projectId ?? '', projectSessionId ?? '', {
    enabled: !isChildSession,
    runtimeSessionId: sessionId,
  });
  const isServerBusy = working.state === 'working';

  // The one transcript-derived gate that survives, and the only one that
  // carries proof: during a provider 429 OpenCode stamps `info.error` with
  // `data.isRetryable === true` and keeps writing the SAME assistant message,
  // while the status frame this tab holds can read non-busy for all of it. The
  // projection cannot substitute — a frame stamped after the last `/turn` read
  // outranks that read by design — so without this a `/` command submitted
  // now would go out into a turn that is still running.
  //
  // Paired with the server's own authority so it can never wedge: an assistant
  // message left open by a sandbox that died mid-turn (no error, no
  // completion) is not a retry, AND a dead box's turn is husk-finalized, so
  // `serverOpenTurnToken` goes null and the gate opens. That pair is what the
  // old 10s husk clock and its confirmation round-trip existed to approximate.
  //
  // The TOKEN, not the message id: a `/` command's own turn carries no wire
  // `messageID`, so keying this on the id left the gate open for exactly the
  // producer it guards.
  //
  // It gates COMMANDS only now (`sessionWorking` on the composer). A prompt is
  // an inbox row and the server's admission gate holds it.
  const hasRetryingAssistant = useMemo(
    () => hasRetryingAssistantTurn(messages) && working.serverOpenTurnToken !== null,
    [messages, working.serverOpenTurnToken],
  );

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

  // The working projection, plus compaction — which `projectWorking`
  // deliberately knows nothing about, because a compaction is not a turn and
  // `GET .../turn` reports none for it.
  //
  // It is no longer a client-only latch either. `sessionState.isCompacting` is
  // its own projection (`core/session/compaction.ts`) over the runtime's
  // `Session.time.compacting` row plus this tab's own bounded `/compact` stamp,
  // so a lost `session.compacted` frame stops pinning the composer at
  // `OPTIMISTIC_COMPACTION_MAX_MS` instead of for the lifetime of the tab, and
  // a compaction started by a second device is visible here at all.
  const effectiveBusy = resolveEffectiveBusy({
    isServerBusy,
    isOptimisticCompacting,
    hasRetryingAssistant,
  });

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

  // The one working answer the LAST turn card renders (its shimmer). Resolved
  // here, once, so the card never reads the raw slot for a Kortix session —
  // see `resolveLastTurnWorking` for the split and the defect it removes.
  const lastTurnWorking = resolveLastTurnWorking({
    isChildSession,
    // The delay-hidden projection, so the card and the composer settle on the
    // same frame instead of the card flickering 300ms earlier.
    projectionBusy: isBusy,
    rawSlotBusy: getWorkingState(sessionStatus, true),
  });

  // Read by `handleSend` for its ANCHORING decision only (a send into a running
  // turn must not yank the viewport). Refs, not the values: `handleSend` is a stable callback
  // that a dozen surfaces hold, and adding busy state to its deps would rebuild
  // it on every turn transition. Written in an EFFECT, never during render — a
  // render-phase ref write is what deadlocked the session shell once already.
  const isBusyRef = useRef(false);
  useEffect(() => {
    isBusyRef.current = effectiveBusy;
  }, [effectiveBusy]);

  // Render-driven only: the session is working, or the transcript shows a user
  // message nothing has answered yet. The transcript-inference terms are gone —
  // "is a turn running" has one authority now.
  const expectAssistantResponse = isServerBusy || hasPendingUserReply;

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

  // WHAT THE TRANSCRIPT RENDERS AS QUEUED IS THE SERVER INBOX — see
  // `projectQueueRows` and `QueuedPromptBubbles`.
  //
  // `GET .../prompts` is the queue: durable, shared across tabs and devices,
  // ordered and admitted by the control plane. There is no browser lane beside
  // it any more, so there is no second list to keep in sync, no per-row origin
  // to route actions by, and nothing left that a closed tab can lose.
  //
  // The transcript is passed in because a row whose message is ALREADY on
  // screen is not a queue row. Every prompt this tab sends is painted into the
  // transcript on Enter under its WIRE id — the same id its row carries — so
  // its row is never drawn. When the runtime echoes it under a RE-MINTED id,
  // the store remembers the alias (`optimisticOriginOf`), and the row — which
  // reports the original id until its next poll — stays hidden through the
  // swap. Without both, the same text is on screen twice for a frame or a
  // second: once as the bubble, once as a queued row.
  const transcriptUserMessageIds = useMemo(() => {
    const ids = new Set<string>();
    const store = useSessionStateStore.getState();
    for (const message of messages ?? []) {
      if (message.info.role !== 'user') continue;
      ids.add(message.info.id);
      const origin = store.optimisticOriginOf(sessionId, message.info.id);
      if (origin) ids.add(origin);
    }
    // A prompt whose wire/echo id is already on screen also contributes its
    // client_message_id — the one id stable across a re-mint AND a reload — so
    // the queue projection's client-id hide clause is live even when the
    // transcript only knows the re-minted id (the sticky-"Queued" reload case).
    for (const prompt of promptInbox.prompts) {
      if (!prompt.client_message_id) continue;
      if (
        (prompt.message_id && ids.has(prompt.message_id)) ||
        (prompt.wire_message_id && ids.has(prompt.wire_message_id))
      ) {
        ids.add(prompt.client_message_id);
      }
    }
    return ids;
  }, [messages, sessionId, promptInbox.prompts]);
  // Inbox rows keyed by the transcript id they will confirm under — the
  // original wire id AND, after a re-mint, the echo — so a pending bubble can
  // find its own row for remove / send-now / retry.
  const inboxRowsByMessageId = useMemo(() => {
    const store = useSessionStateStore.getState();
    const byId = new Map<string, SessionPrompt>();
    for (const prompt of promptInbox.prompts) {
      if (!prompt.message_id) continue;
      // The row names the re-minted id BEFORE the runtime echoes it: register
      // the alias so the echo supersedes ITS OWN optimistic bubble instead of
      // the ordinal fallback consuming the oldest one in flight.
      if (prompt.wire_message_id && prompt.wire_message_id !== prompt.message_id) {
        store.registerOptimisticEcho(sessionId, prompt.wire_message_id, prompt.message_id);
      }
      byId.set(prompt.message_id, prompt);
      const echo = store.optimisticEchoOf(sessionId, prompt.message_id);
      if (echo) byId.set(echo, prompt);
      // The id this tab painted under, when the drain already re-minted.
      if (prompt.wire_message_id && prompt.wire_message_id !== prompt.message_id) {
        byId.set(prompt.wire_message_id, prompt);
        const wireEcho = store.optimisticEchoOf(sessionId, prompt.wire_message_id);
        if (wireEcho) byId.set(wireEcho, prompt);
      }
    }
    return byId;
  }, [promptInbox.prompts, sessionId]);
  const queueRows = useMemo(
    () =>
      projectQueueRows({
        prompts: promptInbox.prompts,
        transcriptMessageIds: transcriptUserMessageIds,
      }),
    [promptInbox.prompts, transcriptUserMessageIds],
  );
  const queuedMessages = queueRows.queued;
  const failedQueuedMessages = queueRows.failed;

  // A row the server has CLAIMED is on the wire; locking it against
  // edit/remove/reorder is the same rule as before.
  const queueInFlightIds = queueRows.inFlightIds;

  // How many prompts the Stop hold is currently pausing. The per-row Resume is
  // a hover-only icon on each held bubble; this count backs the persistent
  // composer-level "Queue paused — Resume" banner, which is the one control the
  // user can always see while the queue is stopped. A FAILED row is not paused
  // by the hold, so it does not count.
  const heldQueueCount = useMemo(
    () => promptInbox.prompts.filter((p) => p.reason === 'held' && p.state !== 'failed').length,
    [promptInbox.prompts],
  );

  // Removing used to be a local-store delete with an undo toast that restored
  // the entry into that store. The row is durable now, so a removal is a real
  // DELETE and the undo has to re-create it — which the inbox makes exact,
  // because re-POSTing the SAME `clientMessageId` is idempotent by unique
  // index rather than by a client-side latch.
  const handleRemoveQueuedMessage = useCallback(
    async (id: string) => {
      // The DELETE hands back what it destroyed, and that is the only lossless
      // undo: the row is hard-deleted, and the list view carries a 2000-char
      // text preview with no parts at all. Restoring from the list dropped
      // every attachment and the model/agent picks — silently, under a button
      // that says "Undo".
      let removed: Awaited<ReturnType<typeof promptInbox.remove>>;
      try {
        removed = await promptInbox.remove(id);
      } catch (error) {
        // Branch on the STATUS, and say what the server said.
        //
        // This used to test `/409/` against `error.message` — but `ApiError`
        // carries the server's prose in `message` and the code in `status`, so
        // that regex could never match. Every failure rendered the same
        // "Could not remove that prompt", including the 409 that has a precise
        // explanation ("Prompt is already being answered") and the 404 that
        // means something entirely different. Two unrelated causes behind one
        // dead-end string is why this looked like the button simply never
        // worked.
        const status = (error as { status?: number } | null)?.status;
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : null;
        errorToast(
          status === 409
            ? (detail ?? 'The agent is already answering that prompt')
            : status === 404
              ? 'That prompt is no longer in the queue'
              : (detail ?? 'Could not remove that prompt'),
        );
        return;
      }
      if (!removed) return;
      // The bubble IS the queue entry: the row is gone, so every copy of the
      // message goes with it — the optimistic bubble, a confirmed echo, and
      // the ownership marks that would otherwise resurrect it when the
      // runtime relays the deletion.
      const store = useSessionStateStore.getState();
      store.optimisticRemove(sessionId, removed.message_id);
      for (const id of removed.removed_message_ids ?? [removed.message_id]) {
        store.forgetControlPlaneMessage(sessionId, id);
      }

      // Undo rather than a confirm dialog. A queue is something you curate —
      // gating every removal behind a modal would make it unusable, and the
      // thing being removed is a draft, not data. Reversible beats guarded.
      const undoToastId = `queue-undo-${sessionId}-${removed.prompt_id}`;
      infoToast('Removed from queue', {
        id: undoToastId,
        duration: 5000,
        button: (
          <Button
            size="sm"
            variant="outline"
            // The SAME `clientMessageId`, so an undo re-creates ONE row and a
            // double-click cannot create two. A FRESH wire id, because
            // OpenCode orders by id and the original one was minted before the
            // turn that has been writing higher ids since. The parts and
            // overrides are the ORIGINALS, straight from the delete's own
            // response — see `createQueueUndoAction`.
            onClick={createQueueUndoAction({
              removed,
              mintMessageId: () => mintSessionWireMessageId(sessionId),
              enqueue: promptInbox.enqueue,
              dismiss: () => dismissToast(undoToastId),
              onError: () => errorToast('Could not restore that prompt'),
            })}
          >
            Undo
          </Button>
        ),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, promptInbox.remove, promptInbox.enqueue],
  );

  const handleRetryQueuedMessage = useCallback(
    (id: string) => {
      // Re-queued UNDER ITS ORIGINAL WIRE ID, so a delivery that actually
      // landed is still absorbed by the proxy instead of running twice.
      void promptInbox.retry(id).catch(() => errorToast('Could not retry that prompt'));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promptInbox.retry],
  );

  // Associate stashed command info with the newest user message when messages
  // arrive, so `UserMessage` renders the command pill instead of raw template
  // text. `prevMsgLenRef` exists for this one observation.
  const prevMsgLenRef = useRef(messages?.length || 0);
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

  // ---- Auto-scroll: see use-auto-scroll.ts (room + end + follow) ----
  const messageCount = messages?.length ?? 0;
  const {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToBottom,
    smoothScrollToAbsoluteBottom,
    anchorTurn,
    startAtTop,
  } = useAutoScroll({
    hasContent: messageCount > 0,
  });
  // Older history loads by scrolling, not by clicking: a sentinel above the
  // first turn pulls the previous page as it nears the top of the viewport.
  // A pull always prepends content above the reader, so every one is wrapped
  // in the turn anchor — capture where the topmost visible turn sits, restore
  // it after the prepended turns render, and the viewport never jumps.
  const [olderPullFailed, setOlderPullFailed] = useState(false);
  // The row the reader actually sees while a page is in flight — the live flag
  // held long enough to be read (`session-older-loading.ts`).
  const showOlderLoading = useHeldOlderLoading(isLoadingOlder);
  // Pages the SENTINEL has pulled. An explicit pull never counts — see
  // `OLDER_AUTOLOAD_MAX_PAGES` for why the automatic path is the one bounded.
  const [autoLoadedPages, setAutoLoadedPages] = useState(0);
  // The sentinel's re-arm latch (`nextOlderAutoloadArm`). A pull disarms it;
  // it re-arms only once the sentinel has LEFT the 400px rootMargin zone. A
  // prepend of short/collapsed turns that fails to push the sentinel out of
  // the zone used to re-fire the observer immediately and chain pulls in one
  // paint — while the rAF anchor-restore of pull N raced the capture of pull
  // N+1, which is the jump behind "keeps fetching". A ref, not state: arming
  // must not re-create the observer.
  const olderAutoloadArmedRef = useRef(true);
  useEffect(() => {
    setOlderPullFailed(false);
    setAutoLoadedPages(0);
    olderAutoloadArmedRef.current = true;
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
        const isIntersecting = !!entry?.isIntersecting;
        const didPull = shouldLoadOlderHistory({
          isIntersecting,
          hasOlder,
          isLoadingOlder,
          lastPullFailed: olderPullFailed,
          autoLoadedPages,
          readerScrolledUp: readerScrolledUpRef.current,
          armed: olderAutoloadArmedRef.current,
        });
        olderAutoloadArmedRef.current = nextOlderAutoloadArm({
          armed: olderAutoloadArmedRef.current,
          isIntersecting,
          didPull,
        });
        if (didPull) {
          setAutoLoadedPages((pages) => pages + 1);
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
  }, [
    hasOlder,
    isLoadingOlder,
    olderPullFailed,
    autoLoadedPages,
    handleLoadOlder,
    scrollRef,
    sessionId,
  ]);

  // Scroll to the bottom on initial load / session change.
  // Uses a callback ref on the scroll container to guarantee it's mounted.
  // A session opens at its end: `useAutoScroll` follows from the first layout
  // (no near-bottom-then-smooth choreography, which fought the follow). The
  // one exception is a sub-session viewed from its start.
  const initialScrollDoneRef = useRef<string | null>(null);
  const scrollContainerCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Always keep scrollRef updated
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (!node) return;
      if (initialScrollDoneRef.current === sessionId) return;
      initialScrollDoneRef.current = sessionId;
      if (initialScrollTop) startAtTop();
      else scrollToBottom();
    },
    [sessionId, scrollRef, initialScrollTop, startAtTop, scrollToBottom],
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
  /**
   * Queue rows the transcript does not hold yet, as SYNTHETIC user messages —
   * fed into the SAME turn list as everything else, sorted by their creation
   * time, so a queued prompt never renders in a second container below newer
   * turns. The strip used to draw them after the turns; a send painted as an
   * optimistic TURN while an older row was still a strip ROW then displayed
   * newest-first (measured on the shell→chat handoff: Boot 4 above Boot 1–3).
   * The echo arrives under the same `message_id`, so the synthetic turn
   * becomes the real one in place — same element, same key.
   */
  const queuedSyntheticMessages = useMemo(() => {
    const out: NonNullable<typeof messages> = [];
    // A queued row is by definition newer than everything the transcript
    // already holds — but its clock is the SENDER TAB's, and the box stamps
    // real messages from its own. A box running ~1 s ahead sorted a fresh
    // queued row ABOVE the previous turn (measured). Floor every synthetic
    // time just past the newest real stamp, keeping the rows' own relative
    // order.
    let floor = 0;
    for (const message of messages ?? []) {
      const created = (message.info as { time?: { created?: number } }).time?.created;
      if (typeof created === 'number' && created > floor) floor = created;
    }
    let previous = floor;
    for (const prompt of promptInbox.prompts) {
      if (prompt.state === 'failed') continue;
      if (!prompt.text.trim()) continue;
      if (prompt.message_id && transcriptUserMessageIds.has(prompt.message_id)) continue;
      if (prompt.wire_message_id && transcriptUserMessageIds.has(prompt.wire_message_id)) continue;
      if (isOptimisticSessionPrompt(prompt)) continue; // painted by this tab already
      const id = prompt.message_id || `queued-${prompt.prompt_id}`;
      const sentAt =
        typeof prompt.client_sent_at_ms === 'number'
          ? prompt.client_sent_at_ms
          : Date.parse(prompt.created_at);
      const createdMs = Math.max(sentAt, previous + 1);
      previous = createdMs;
      out.push({
        info: {
          id,
          sessionID: sessionId,
          role: 'user',
          time: Number.isFinite(createdMs) ? { created: createdMs } : {},
        },
        parts: [
          {
            id: `syn-${prompt.prompt_id}`,
            messageID: id,
            sessionID: sessionId,
            type: 'text',
            text: prompt.text,
          },
        ],
      } as unknown as NonNullable<typeof messages>[number]);
    }
    return out;
  }, [promptInbox.prompts, transcriptUserMessageIds, sessionId]);
  const rawTurns = useMemo(
    () =>
      messages || queuedSyntheticMessages.length > 0
        ? groupMessagesIntoTurns([...(messages ?? []), ...queuedSyntheticMessages])
        : [],
    [messages, queuedSyntheticMessages],
  );
  /**
   * `groupMessagesIntoTurns` allocates a fresh object per turn on every call, and
   * `messages` is rebuilt on every SSE frame — so a fifty-turn session handed
   * React fifty new `turn` objects ~60 times a second, of which at most one had
   * changed. `turn` is the dependency of ~28 memos inside `SessionTurn`, so that
   * one fact invalidated all of them, for every turn, every frame.
   *
   * The previous stable array is carried in a ref written after commit, so
   * render stays pure; `stabilizeTurns` is idempotent, so StrictMode's double
   * invocation lands on the same objects.
   */
  const stableTurnsRef = useRef<Turn[]>([]);
  const turns = useMemo(() => stabilizeTurns(rawTurns, stableTurnsRef.current), [rawTurns]);
  useEffect(() => {
    stableTurnsRef.current = turns;
  }, [turns]);
  // Outcomes anchor to the SAME id `TurnViewport` receives as `turnId`
  // (`turn.userMessage.info.id`) — never `turnRenderKeys`, which re-aliases a
  // turn to its optimistic origin id on an id swap, so anchoring to it would
  // make an outcome card jump between turns mid-stream.
  //
  // Stabilised BY CONTENT, mirroring `stableTurnsRef` above: `turns` gets a
  // new array from `stabilizeTurns` on every turn that changed, which is every
  // turn while ANY turn is streaming (a growing turn's object identity itself
  // changes). Without this, `turnSpans` — and everything built on it below —
  // would be new every frame, which makes `SessionOutcomesProvider`'s context
  // `value` new every frame, which re-renders every `TurnOutcomes` in the
  // transcript on every SSE frame — exactly the cost `stabilizeTurns` was
  // written to remove one level up. The ref is written in a `useEffect` AFTER
  // commit, same as `stableTurnsRef`, so render stays pure.
  const stableSpansRef = useRef<TurnSpan[]>([]);
  const turnSpans = useMemo(() => {
    const next = turns.map((turn) => ({
      key: turn.userMessage.info.id,
      ...sessionTurnSpan(turn),
    }));
    const prev = stableSpansRef.current;
    const same =
      prev.length === next.length &&
      prev.every(
        (p, i) =>
          p.key === next[i].key &&
          p.startedAt === next[i].startedAt &&
          p.endedAt === next[i].endedAt,
      );
    return same ? prev : next;
  }, [turns]);
  useEffect(() => {
    stableSpansRef.current = turnSpans;
  }, [turnSpans]);
  // The first prompt as its producer left it for the boot shell — drawn here
  // too, inert, until the transcript or the inbox has the real thing, then
  // released. See `useFirstPromptPreviewStore`.
  const firstPromptPreview = useFirstPromptPreviewStore((state) =>
    projectSessionId ? (state.previewBySession[projectSessionId] ?? null) : null,
  );
  const clearFirstPromptPreview = useFirstPromptPreviewStore(
    (state) => state.clearFirstPromptPreview,
  );
  // "The transcript has it" means a user message WITH text on screen — the
  // info frame and the text part arrive separately, and a bubble with no text
  // renders nothing. Until then the preview stands in.
  const transcriptShowsFirstPrompt = useMemo(
    () =>
      turns.some((turn) =>
        turn.userMessage.parts.some(
          (part) =>
            isTextPart(part) && !!part.text?.trim() && !(part as { synthetic?: boolean }).synthetic,
        ),
      ),
    [turns],
  );
  const showFirstPromptPreview = !!firstPromptPreview && !transcriptShowsFirstPrompt;
  useEffect(() => {
    if (!projectSessionId || !firstPromptPreview) return;
    if (transcriptShowsFirstPrompt) clearFirstPromptPreview(projectSessionId);
  }, [projectSessionId, firstPromptPreview, transcriptShowsFirstPrompt, clearFirstPromptPreview]);

  /**
   * Which turn, if any, draws the plan.
   *
   * Null on desktop, always: the Easy panel owns the plan at every width above
   * 768px — collapsed column and detail panel included — so no turn claims it
   * and the transcript scan below never runs. Mobile has no panel column at
   * all, so the chat keeps it there. `usePlanInChat` is the single decision
   * both surfaces read; see `plan-surface.ts` and `planBelongsToChat`.
   *
   * One scan of the transcript, not one per turn. `planAnchorMessageId`
   * inspects every part of every message. It used to run inside each turn,
   * which made it O(turns x total-parts) — on the order of 100k part
   * inspections per frame for a long session.
   */
  const planInChat = usePlanInChat();
  const planAnchorId = useMemo(
    () => chatPlanAnchorId(messages, planInChat),
    [messages, planInChat],
  );
  const lastUserMessageId = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') return messages[i].info.id;
    }
    return null;
  }, [messages]);
  // The store's alias for a re-minted echo — stable function reference, read
  // per turn for the React key (see the `TurnViewport` key below).
  const optimisticOriginOf = useSessionStateStore((state) => state.optimisticOriginOf);
  // WHICH turn carries the shimmer, and which user bubbles are still queued at
  // the agent. Not "the last one" any more — see `resolveWorkingTurn`.
  // Turns the SERVER still holds in its inbox — see `resolveWorkingTurn`'s
  // `unrunTurnIds`. Keyed by every id a bubble can be on screen under, because
  // the drain re-mints `message_id` while the tab still paints `wire_message_id`.
  const unrunTurnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const prompt of promptInbox.prompts) {
      if (prompt.state !== 'queued' && prompt.state !== 'waiting' && prompt.state !== 'delivering')
        continue;
      if (prompt.message_id) ids.add(prompt.message_id);
      if (prompt.wire_message_id) ids.add(prompt.wire_message_id);
    }
    return ids;
  }, [promptInbox.prompts]);
  const workingTurn = useMemo(
    () => resolveWorkingTurn({ turns, hintMessageId: working.turnId, unrunTurnIds }),
    [turns, working.turnId, unrunTurnIds],
  );
  const workingTurnIdRef = useRef<string | null>(workingTurn.workingTurnId);
  useEffect(() => {
    workingTurnIdRef.current = workingTurn.workingTurnId;
  }, [workingTurn.workingTurnId]);
  const pendingTurnIds = useMemo(() => new Set(workingTurn.pendingTurnIds), [workingTurn]);
  /**
   * Does the resolved working turn have a COMPLETED answer while queued prompts
   * wait below it? `resolveWorkingTurn` falls back to the newest turn WITH
   * content when every pending prompt is still held in the inbox (rule 4). If
   * that turn's answer is already complete, its live busy row would render above
   * the just-sent (queued) message and then jump down when the prompt starts
   * running. In that one case the working turn shows no indicator — the queued
   * turns are their own dimmed bubbles until one runs. Only a FINISHED answer
   * suppresses; a turn streaming between steps has an OPEN assistant message, so
   * `resolveWorkingTurn` rule 1 picks it and this stays false (no flicker).
   */
  const suppressWorkingTurnBusy = useMemo(() => {
    if (workingTurn.pendingTurnIds.length === 0) return false;
    const wt = turns.find((t) => t.userMessage.info.id === workingTurn.workingTurnId);
    if (!wt || wt.assistantMessages.length === 0) return false;
    const newest = wt.assistantMessages[wt.assistantMessages.length - 1];
    return !!(newest.info as { time?: { completed?: number } }).time?.completed;
  }, [turns, workingTurn]);
  /**
   * ONE render key per turn. A turn keeps the id its bubble was FIRST painted
   * under (the optimistic origin), so a re-minted echo re-renders the same
   * element instead of mounting a new one. But an origin can transiently be
   * claimed by TWO turns — an old echo still on screen while its re-placed
   * copy arrives — and duplicate React keys corrupt the whole list (measured:
   * 1.5k "two children with the same key" errors in one churn). The origin
   * key goes to the FIRST claimant; any other turn falls back to its own id.
   */
  const turnRenderKeys = useMemo(() => {
    const keys = new Map<string, string>();
    const used = new Set<string>();
    for (const turn of turns) {
      const id = turn.userMessage.info.id;
      const origin = optimisticOriginOf(sessionId, id);
      let key = origin && !used.has(origin) ? origin : id;
      // Belt and braces: whatever aliasing produced a collision, NEVER hand
      // React two children with one key — that corrupts the whole list.
      while (used.has(key)) key = `${key}~`;
      keys.set(id, key);
      used.add(key);
    }
    return keys;
  }, [turns, sessionId, optimisticOriginOf]);
  // User messages a Stop stranded: the session is idle, the newest turn with
  // content ended by abort, and these came after it with nothing under them.
  // The runtime holds them; nothing runs them until the next send.
  const interruptedTurnIds = useMemo(() => {
    if (lastTurnWorking) return new Set<string>();
    let newestWithContent = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].assistantMessages.length > 0) {
        newestWithContent = i;
        break;
      }
    }
    if (newestWithContent < 0 || newestWithContent === turns.length - 1) return new Set<string>();
    const last = turns[newestWithContent].assistantMessages.at(-1);
    if (!last || !isAbortError((last.info as { error?: unknown }).error)) return new Set<string>();
    return new Set(turns.slice(newestWithContent + 1).map((t) => t.userMessage.info.id));
  }, [turns, lastTurnWorking]);
  /** Hoisted out of the JSX: an inline arrow prop defeats `React.memo` by itself.
   *  Opens the inline editor on that message — nothing is staged until its Send. */
  const handleRewind = useCallback(
    (messageId: string, text: string) => setRewindTarget({ messageId, text }),
    [],
  );
  const hasAnyMessages = turns.length > 0;
  // A pending inbox row counts as content: the session HAS the user's message
  // (durably), so the welcome overlay must not paint over the queue strip.
  const hasChatContent =
    hasAnyMessages || promptInbox.prompts.length > 0 || firstPromptPreview !== null;
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
  // The 2 s permission/question self-heal polls that used to sit here are
  // gone: the session stream's runtime channel is SEQUENCED (a lost
  // `question.asked` frame is a detectable gap, not a silent hole), and the
  // `kortix.control.runtime_state` snapshots re-seed open asks on every
  // attach/reconnect — see the SDK's `useSessionRuntimeStream`.

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
      // Also abort the session so the "The operation was aborted." banner
      // appears. Routed through `issueSessionCancel` (T10) so this
      // cancel's `AbortSettlement` is tracked the same as every other stop
      // path, in case a queued "send now" follows a question rejection.
      if (sessionState) {
        issueSessionCancel();
      } else if (!abortSession.isPending) {
        issueSessionCancel();
      }
    },
    [sessionState, removeQuestion, abortSession, suppressQuestionFor, issueSessionCancel],
  );
  // The single classifier (`compactionTurnInfo`) rather than an inline scan:
  // it also sees SYNTHETIC compaction turns (summary message as userMessage),
  // so a failed attempt's turn suppresses the optimistic "Compacting…" marker
  // instead of leaving it shimmering beside the failure row.
  const hasCompactionTurn = useMemo(
    () => turns.some((turn) => compactionTurnInfo(turn).isCompaction),
    [turns],
  );
  // Index of the LAST compaction turn (any state). Every FAILED attempt
  // before it is history the reader retried past — a run of retries renders
  // as ONE failure row (the latest), not a stack of near-identical lines.
  const lastCompactionTurnIndex = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (compactionTurnInfo(turns[i]).isCompaction) return i;
    }
    return -1;
  }, [turns]);

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
    clearSendReceipt();
    setRewindTarget(null);
  }, [sessionId, clearSendReceipt]);

  // ============================================================================
  // Billing: DISABLED — billing is handled server-side by the router
  // (POST /v1/router/chat/completions deducts credits per LLM call).
  // This frontend useEffect was causing double-billing once opencode.jsonc
  // got cost config and step-finish.cost became non-zero.
  // ============================================================================

  // No composer-draft side effect any more: the old flow prefilled the
  // composer with the rewound prompt and Restore had to wipe that prefill.
  // The inline editor never touches the composer, so wiping it here would
  // only destroy an unrelated draft the user had typed.
  const handleRestoreRewind = useCallback(async () => {
    if (!sessionState?.rewindMessageId) return;
    try {
      await sessionState.restoreRewind();
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
        /**
         * The queue entry's stable key, when this send is a queued entry being
         * dispatched. Re-dispatching the SAME entry (a retry) re-sends one wire
         * `messageID` so the sandbox proxy still recognises the delivery;
         * a different entry, even with identical text, gets its own. Omitted
         * for a direct composer send, which has no retry path.
         */
        clientMessageId?: string;
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
      const fileMentionRefs: FileRefLike[] = [];
      const agentMentionRefs: AgentRefLike[] = [];
      for (const m of mentions ?? []) {
        if (!m.label) continue;
        if (m.kind === 'file') fileMentionRefs.push({ path: m.label, name: m.label });
        else if (m.kind === 'agent') agentMentionRefs.push({ name: m.label });
      }

      // Play send sound
      playSound('send');
      // ONE id for the prompt's whole life. This is the WIRE id the inbox row
      // carries and the runtime persists — minted by the SDK against this
      // session's transcript (idempotent per `clientMessageId`, so an undo or
      // retry re-uses it). The optimistic bubble is painted with it, so the
      // server's echo confirms it IN PLACE, and the inbox row is never a
      // second thing on screen (`transcriptUserMessageIds`). It used to be an
      // `ascendingId` that only the optimistic bubble knew — three ids per
      // prompt (optimistic, wire, delivered) and two surfaces, and every
      // hand-off between them was a frame where the message doubled, blinked
      // or jumped.
      const clientMessageId = overrides?.clientMessageId ?? ascendingId('msg');
      const sentAtMs = Date.now();
      const messageID = mintSessionWireMessageId(sessionId, clientMessageId);

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
      let optimisticSessionsById: Map<string, any> | null = null;
      while ((rawOptimisticMatch = rawOptimisticRegex.exec(text)) !== null) {
        const rawId = rawOptimisticMatch[1];
        if (sessionMentionsForOptimistic.some((m) => m.value === rawId)) continue;
        optimisticSessionsById ??= new Map((allSessions ?? []).map((s: any) => [s.id, s] as const));
        const found = optimisticSessionsById.get(rawId);
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

      // Optimistic: the bubble is in the transcript from THIS frame, whether
      // the prompt runs now or waits behind the running turn. There is no
      // "will it wait?" branch any more — the server decides admission, and
      // the transcript is the one place a prompt is drawn either way. A
      // waiting prompt's turn renders dimmed (`pending`, see
      // `resolveWorkingTurn`) and comes up to full opacity when the agent
      // reaches it; nothing else changes about it, ever.
      beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);
      // Inbox-backed from THIS tick, before the first `await` below: the row it
      // becomes is durable, and this send's own failure paths
      // (`abandonOptimisticSend`, `recoverFromSendFailure`) are the ONLY things
      // allowed to take the bubble away. Between short turns the runtime emits
      // `session.idle` frames every few seconds; one landing during the
      // attachment build below used to sweep the bubble as "unconfirmed" — it
      // vanished, and came back seconds later under the echo, beside a queued
      // row that no longer had a transcript twin to hide behind.
      markOptimisticSendInboxBacked(sessionId, messageID);
      const sendingIntoRunningTurn = isBusyRef.current;
      const receiptTurnId = sendingIntoRunningTurn ? workingTurnIdRef.current : messageID;

      // A send follows from here: the new bubble lands at the top of the
      // screen the frame it commits (use-auto-scroll.ts, FACT 2 + THE RULE).
      // While a turn runs the queued bubble is not anchored at the top (that
      // would shift the streaming answer out of view); one who is at the end
      // sees it appear anyway. One who had scrolled UP is brought to it,
      // smoothly: pressing Enter is intent to see the message land, and a
      // queued bubble that appears off-screen with no feedback reads as
      // "nothing happened" (queue-lab `scroll_up_queue`, 2026-08-19).
      if (!sendingIntoRunningTurn) anchorTurn(messageID);
      else if (scrollRef.current?.dataset.follow === 'false') smoothScrollToAbsoluteBottom();

      const options: Record<string, unknown> = {};
      const overrideAgent = overrides?.agent;
      const overrideModel = overrides?.model;
      const overrideVariant = overrides?.variant;
      if (overrideAgent !== undefined) {
        if (overrideAgent) options.agent = overrideAgent;
      } else if (composerAgentName) {
        // The name the picker is SHOWING, not `local.agent.current`: an
        // inaccessible project default resolves to the first agent this user
        // holds a grant on, and the send must carry that same one.
        options.agent = composerAgentName;
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
      let sessionsById: Map<string, any> | null = null;
      while ((rawMatch = rawSessionIdRegex.exec(textPrompt.text)) !== null) {
        const rawId = rawMatch[1];
        // Skip if already covered by a tracked mention
        if (trackedSessionMentions.some((m) => m.value === rawId)) continue;
        // Look up session by ID
        sessionsById ??= new Map((allSessions ?? []).map((s: any) => [s.id, s] as const));
        const found = sessionsById.get(rawId);
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
      // Don't send part IDs. `ascendingId` encodes the HIGH bits of the id
      // clock where opencode encodes the LOW 48 (see the warning on it in the
      // SDK), so a client id of that shape sorts before EVERY server id: the
      // server's "has this prompt already been answered?" ordering check reads
      // a stale assistant reply as the answer and the turn never runs.
      //
      // The `messageID` is a different matter and IS sent — by the SDK, not
      // from here. `promptOpenCodeMessage` mints it in opencode's own wire
      // format and places it above everything already in this session's
      // transcript, which is what makes it safe; without one, two identical
      // prompts inside 60s hash to a single proxy delivery and the second is
      // silently dropped. Do not "restore" the old no-messageID behaviour on
      // the strength of the part-id reasoning above — they are not the same
      // hazard, and the mint is the guard against this one.
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

      // The prompt is going out, so the optimistic message stops being
      // `pending`. This is what lets the server's echo — which arrives under a
      // DIFFERENT id — supersede it instead of rendering beside it.
      //
      // `useSession.sendParts` normally marks dispatch by correlating the
      // client-generated part ids carried with the prompt. We strip those ids
      // on purpose (see the note above `mappedParts`: client ids can sort
      // before server ids under clock skew and make the server's loop exit
      // early), so there is nothing for it to correlate on and the mark never
      // happened. The result was every message rendering twice for the whole
      // turn, until the session went idle and the optimistic sweep ran.
      markOptimisticSendDispatched(sessionId, messageID);

      const selectedAgent = typeof sendOpts?.agent === 'string' ? sendOpts.agent : null;
      const selectedVariant = typeof sendOpts?.variant === 'string' ? sendOpts.variant : null;
      const selectedModel = sendOpts?.model ? (sendOpts.model as ModelKey) : null;

      // THE ONE SEND PATH: the server-side prompt inbox.
      //
      // This used to POST straight into the sandbox's OpenCode server, and
      // anything the user typed while the agent was busy went into a browser
      // queue instead — which meant a closed tab, a second device, or a crash
      // lost it silently, and two tabs on one session disagreed about what was
      // pending. Now every prompt becomes a durable row first, and the SERVER
      // decides whether it runs now or waits: the admission gate reads the same
      // turn authority `GET .../turn` serves from, so the composer never has to
      // guess whether a turn is in flight.
      //
      // The WIRE id is minted here, by the SDK, and never by the control plane:
      // OpenCode resolves "has this prompt already been answered?" by id ORDER,
      // and only this process holds the transcript to place one against. It is
      // `messageID` above. `clientMessageId` is only the inbox idempotency key.
      // The prompt is out of this tab's hands the moment the row lands, so the
      // receipt is taken BEFORE the POST: it is what holds the composer on
      // "working" until `GET .../turn` reports the turn the inbox admitted.
      noteSendReceipt(messageID, receiptTurnId);
      const result = await (async () => {
        try {
          if (!projectId || !projectSessionId) {
            throw new Error('This session has no project — cannot queue a prompt');
          }
          const created = await promptInbox.enqueue({
            clientMessageId,
            messageId: messageID,
            parts: mappedParts,
            // Enter time, not POST time: uploads and a busy API sit between
            // the two, and the server orders racing sends by THIS.
            clientSentAtMs: sentAtMs,
            overrides: {
              // Pass the session's directory so opencode resolves project-scoped
              // agents (.opencode/agent/*.md under the project) and applies them
              // when the user picked a project agent from the picker.
              ...(session?.directory ? { directory: session.directory } : {}),
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedModel ? { model: formatPromptModel(selectedModel) } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
            },
          });
          // The server's admission verdict, not a guess. A `failed` row is a
          // real refusal wearing a 200: a re-POST of a `clientMessageId` whose
          // row already dead-lettered dedupes into that row, and discarding
          // the result used to accept the receipt, clear the draft, and tell
          // the user nothing. Thrown here so the ordinary failure path below
          // clears the named receipt and surfaces the error.
          if (created.state === 'failed') {
            throw new Error(
              'This prompt was refused — its earlier delivery already failed. Edit it and send again.',
            );
          }
          // The server has the prompt. From here — and NOT before — a
          // `GET .../turn` read is able to see it, so one is allowed to answer
          // for it. `useSessionPrompts` raises the inbox floor at the same
          // moment, which is what covers the window before the row is
          // delivered and becomes a turn.
          acceptSendReceipt(messageID);
          return { ok: true } as const;
        } catch (cause) {
          // Ask the INBOX, not the runtime. This prompt's home is a durable
          // control-plane row; OpenCode's transcript cannot see it until the
          // admission gate delivers it, so a rehydrate always reports it
          // missing and the recovery used to delete the bubble on that answer —
          // while the row was already running. Reported from a live self-host:
          // "it queues the message and starts running it, but doesn't show in
          // the frontend."
          //
          // `clientMessageId` is the POST's idempotency key, so the row is
          // addressable by exactly the thing this send already holds.
          const error = recoverFromSendFailure(sessionId, messageID, cause, {
            classify: classifySessionError,
            inboxRowExists: async () => {
              if (!projectId || !projectSessionId) return false;
              const { prompts } = await listSessionPrompts(projectId, projectSessionId);
              return prompts.some((prompt) => prompt.client_message_id === clientMessageId);
            },
          });
          return { ok: false, error, cause } as const;
        }
      })();
      if (!result.ok) {
        // Nothing durable was created, so nothing is coming — drop the receipt
        // rather than let a refused send claim `working` for a minute. Named,
        // so a slow refusal cannot drop the receipt of a send the user made
        // after it.
        //
        // ONE exception, and it resolves AFTER this line: if the inbox turns
        // out to hold the row, `recoverFromSendFailure` re-takes the receipt
        // when its lookup lands, so the composer goes back to working on its
        // own. This clear is still right in the moment — as far as this tab
        // knows right now, nothing is coming — and it is NAMED, so it can only
        // ever drop this send's own receipt.
        clearSendReceipt(messageID);
        setCommandError(result.error);
        throw result.cause instanceof Error ? result.cause : new Error(result.error.message);
      }

      return messageID;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      projectId,
      projectSessionId,
      promptInbox.enqueue,
      noteSendReceipt,
      acceptSendReceipt,
      clearSendReceipt,
      composerAgentName,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
      anchorTurn,
      smoothScrollToAbsoluteBottom,
      scrollRef,
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
    registerSender(
      sessionId,
      async (text: string) => {
        // No local queue-vs-send decision any more: the send IS the queue. The
        // inbox admits the prompt when the session can take it, so a caller
        // that used to be told "queued" is simply told "sent" — the prompt is
        // durable either way, which is the stronger promise.
        await handleSend(text);
        return 'sent';
      },
      projectSessionId ? [projectSessionId] : [],
    );
    return () => unregisterSender(sessionId);
    // No local busy/queue gates in the deps any more: the sender does not read
    // them, because the server decides admission.
  }, [sessionId, projectSessionId, handleSend, registerSender, unregisterSender]);

  // NOTE: no client-side "auto-continue after approval" here — resuming the
  // agent when nobody was holding the gated call is the RESOLVE ENDPOINT's job
  // (server-side continueSession delivery in r7.ts), so it works with zero
  // browsers open. A web-side nudge would just double-send.

  const handleEditCancel = useCallback(() => setRewindTarget(null), []);

  /**
   * The inline editor's Send: stage the rewind at the edited message, then
   * deliver the edited text through the ONE send path. The delivery is what
   * commits the truncation, so the turns below the message clear only on Send
   * — Cancel leaves the session untouched.
   *
   * This replaced `handleConfirmRewind` + `ConfirmDialog` + a composer
   * prefill: the dialog asked for a decision before the user had typed
   * anything, and the prefill left a second decision (press send again) in a
   * different control. Now the editor IS the confirmation.
   */
  const handleEditSend = useCallback(
    async (messageId: string, text: string) => {
      if (!sessionState) return;
      setEditSendPending(true);
      try {
        await sessionState.rewind(messageId);
        // THE QUEUED ROWS GO, and this is not a preference.
        //
        // A rewind stages `session.revert`; the NEXT prompt delivered is what
        // commits the truncation. The inbox admits by `created_at`, so a row
        // queued before the rewind is admitted BEFORE the replacement prompt
        // this send delivers — it would commit the user's rewind and then run
        // against the trajectory that rewind just deleted.
        //
        // Holding them instead does not hold: `POST .../prompts` releases the
        // session's hold, and the send that releases it is precisely this
        // edit's replacement prompt. So the rows are removed, exactly as the
        // browser queue's `clearSession` removed them — but visibly, and once,
        // for every tab, rather than per tab.
        const doomed = promptInbox.prompts.filter((prompt) => prompt.state !== 'delivering');
        let removed = 0;
        for (const prompt of doomed) {
          // Sequential: a row that turns out to be on the wire answers 409, and
          // that is not a reason to stop removing the rest.
          const gone = await promptInbox.remove(prompt.prompt_id).catch((error) => {
            console.warn('[session-chat] failed to remove a queued prompt on rewind', error);
            return null;
          });
          if (gone) removed += 1;
        }
        if (removed > 0) {
          infoToast(
            removed === 1 ? 'Queued message removed' : `${removed} queued messages removed`,
            {
              description: 'They were written for the messages this rewind discards.',
            },
          );
        }
        setRewindTarget(null);
        // handleSend surfaces its own failures (commandError card + receipt
        // clear), so a refused send must not wear the rewind toast below —
        // its rejection is swallowed here, not ignored.
        let sendOk = true;
        await handleSend(text).catch(() => {
          sendOk = false;
        });
        // Mirror the SDK's own send path (`use-session.ts` `sendParts`, which
        // ends in `commitSessionRevert`): delivering ANY prompt makes OpenCode
        // commit the staged revert — it deletes the reverted messages and
        // clears the pointer (`SessionRevert.cleanup`, run first thing in
        // `SessionPrompt.prompt`). But the classic server NEVER emits a
        // `session.next.revert.*` wire event (`setRevert`/`clearRevert` are
        // bare session patches, and `syncSessionRevertFromInfo` deliberately
        // ignores an absent `revert` field), and this send goes through the
        // prompt inbox, not `sendParts` — so nothing else ever flips the local
        // record. Without this line the composer's Restore button outlives the
        // path it claims to restore, and every click is a guaranteed no-op:
        // `unrevert` finds nothing staged (or throws BusyError mid-run).
        // A FAILED send leaves the record staged on purpose — the revert is
        // still real server-side and Restore genuinely works there.
        if (sendOk && sessionState.opencodeSessionId) {
          useSessionStateStore.getState().commitSessionRevert(sessionState.opencodeSessionId);
        }
      } catch (error) {
        errorToast('Session rewind failed', {
          description: formatCommandError(error),
        });
      } finally {
        setEditSendPending(false);
      }
    },
    [sessionState, promptInbox.prompts, promptInbox.remove, handleSend],
  );

  const handleStop = useCallback(async () => {
    // Guard against rapid clicks — ignore if an abort is already in flight
    if (abortSession.isPending) {
      console.log(`[handleStop] Ignoring - abort already in flight for session ${sessionId}`);
      return;
    }
    console.log(`[handleStop] Stopping session ${sessionId}`);
    // Optimistically mark the session idle + patch an abort error onto the
    // last assistant message (so the turn reads as stopped instantly — no
    // waiting for the SSE session.error round-trip, and no error row in the
    // gap: `TurnErrorDisplay` renders nothing for an abort). Also clear the
    // busy debounce timer to bypass the 2s delay.
    applyOptimisticAbort(sessionId);
    clearTimeout(busyTimerRef.current);
    setIsBusy(false);
    // Stop means the send this tab was still waiting on is over too.
    clearSendReceipt();

    // Stopping means stop doing things, and that includes the queue. Without
    // this the interrupt is followed a beat later by exactly the message the
    // user was trying to get ahead of.
    //
    // ONE hold, on the server, because the queue is not in this tab any more.
    // Pausing a browser drain left every OTHER tab's view of the queue running
    // and never reached the server at all.
    //
    // AWAITED, and BEFORE the abort. A prompt is now forwarded to OpenCode the
    // moment it is admitted, so at stop time the session's queue can hold rows
    // that OpenCode already has. The abort drops OpenCode's in-memory queue,
    // and the reaper then sees those messages unanswered and hands them back —
    // due now — unless the hold has already marked them stop-paused. Ordering
    // the two calls makes "the hold precedes the abort" a fact instead of an
    // argument about reaper cadence. The user sees no delay: the optimistic
    // paint above already ran, so only the network abort moves one hop later.
    //
    // BOUNDED, because the abort is now sequenced behind a network call and
    // `holdSessionPrompts` carries no client timeout of its own. A stalled
    // socket can hang for minutes, and every one of those is the agent still
    // running, still calling tools and still spending tokens under a UI that
    // says it stopped. Past the bound the abort goes out anyway and the hold
    // finishes on its own — the ordering is a preference, the abort is not.
    await Promise.race([
      promptInbox.hold(true).catch((error) => {
        // Caught, never rethrown: a failed hold must not also cost the user
        // their abort. The cost of that path is the one this ordering removes —
        // a stopped prompt can still come back a reaper pass later.
        //
        // SURFACED, not swallowed. A failed hold means the queue is NOT paused,
        // so a prompt the user pressed Stop to get ahead of can still be
        // delivered a reaper pass later — silently. The user has to know the
        // stop did not also pause the queue, and that pressing Stop again (or
        // Resume/Send-now) is how they recover.
        console.warn('[session-chat] failed to hold the prompt inbox on stop', error);
        errorToast('Stopped, but the queue could not be paused', {
          description: 'Queued prompts may still send. Press Stop again to pause them.',
        });
      }),
      new Promise((resolve) => setTimeout(resolve, STOP_HOLD_DEADLINE_MS)),
    ]);

    // Routed through `issueSessionCancel` (T10) so this stop's
    // `AbortSettlement` is tracked for `handleQueueSendNow`'s
    // `stopThenSendNow` to await — see that function's doc for why.
    issueSessionCancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, abortSession, issueSessionCancel, promptInbox.hold]);

  // Release the Stop hold for the WHOLE queue at once — the composer-level
  // counterpart to the per-row "send now". `hold(false)` un-pauses every held
  // row on the server (shared across tabs); the next scheduler tick delivers
  // them in order. A failed release is surfaced, not swallowed: the user has to
  // know the queue is still paused. (Kept OUT of `handleQueueSendNow`, which
  // must never touch the hold — see `session-chat-inbox-queue.test.ts`.)
  const handleResumeQueue = useCallback(async () => {
    try {
      await promptInbox.hold(false);
    } catch (error) {
      console.warn('[session-chat] failed to release the prompt inbox hold', error);
      errorToast('Could not resume the queue', { description: 'Try again in a moment.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptInbox.hold]);

  /**
   * The per-row action: end the current turn if one is running, then send that
   * message. The only path that interrupts a running turn — automatic draining
   * never does — which is why it is a deliberate click and says what it does.
   *
   * T10: waits for the real `AbortSettlement` the stop it just issued
   * produces (via `stopThenSendNow`), not a guess and not the optimistic
   * idle flip `handleStop` makes synchronously — so the prompt cannot race
   * the abort still in flight on the server.
   */
  const handleQueueSendNow = useCallback(
    async (id: string) => {
      await stopThenSendNow({
        // The control plane's turn authority (`serverOpenTurnToken`), not the
        // raw SSE slot. Both stale directions of the slot were real failures
        // here: stale-idle dispatched into a live turn (OpenCode answers that
        // by aborting it — the "Interrupted" symptom), and stale-busy issued a
        // spurious Stop that held the whole inbox.
        isRunning: () => serverHoldsOpenTurn(working),
        pendingSettlement: () => pendingAbortSettlementRef.current.get(sessionId),
        stop: async () => {
          // AWAITED: `handleStop` holds the inbox before it issues the cancel,
          // so the settlement this reads only exists once that has happened.
          // Reading the ref synchronously would find nothing, and a null
          // settlement dispatches at once — racing the abort still in flight.
          await handleStop();
          return pendingAbortSettlementRef.current.get(sessionId) ?? null;
        },
        // `retry` is the inbox's own "run this one next", and it is the WHOLE
        // dispatch: it promotes the row past the ordering gate and only THEN
        // releases the session's hold, so the prompt the user pointed at is
        // the one that runs and the rest of the queue follows it. Releasing
        // the hold separately first is what made the oldest row run instead.
        dispatch: async () => {
          await promptInbox.retry(id).catch(() => errorToast('Could not send that prompt'));
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, handleStop, promptInbox.retry, working],
  );

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

    // Sampled in the CAPTURE phase — before ProseMirror/@tiptap/suggestion
    // run — because an Escape that dismisses the `@`/`/` menu unmounts its
    // listbox synchronously inside the editor's own keydown handling; by
    // bubble time the menu this press was meant for is already gone. See
    // `EscapePress` in esc-to-stop.ts.
    let suggestionMenuWasOpen = false;
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      suggestionMenuWasOpen = document.querySelector(SUGGESTION_MENU_SELECTOR) !== null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isBusy) return;

      // ESC-to-stop is a page-wide shortcut: it must fire whether or not the
      // composer is focused, because users watch the agent run with focus
      // elsewhere (chat body, a tool view, or nothing at all) AND with focus
      // in the chat input itself. The presses that must not advance the
      // counter: one meant for an open overlay the user is interacting with
      // (focus in a dialog/menu/popover/select — that ESC dismisses it; a
      // hovered tooltip never takes focus, so the stop button's own tooltip
      // can't suppress the shortcut), and one another control already
      // consumed. `defaultPrevented` decides "consumed" EXCEPT for presses
      // inside the composer editor: ProseMirror's backdrop key mapping
      // preventDefaults EVERY Escape in the contenteditable, so there the
      // real consumed-signal is the `@`/`/` menu having been open at capture
      // time. shouldCountEscape (esc-to-stop.ts) owns the decision.
      const active = document.activeElement;
      const focusInOverlay =
        active?.closest(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]',
        ) != null;
      const fromComposerEditor =
        e.target instanceof Element && e.target.closest(COMPOSER_EDITOR_SELECTOR) !== null;
      if (
        !shouldCountEscape({
          fromComposerEditor,
          defaultPrevented: e.defaultPrevented,
          suggestionMenuWasOpen,
          focusInOverlay,
          isComposing: e.isComposing,
        })
      ) {
        return;
      }

      e.preventDefault();

      const now = Date.now();
      const withinWindow = now < escDeadlineRef.current;

      if (withinWindow) {
        const currentCount = escDeadlineRef.current ? Math.max(1, escCount) : 0;
        if (currentCount >= 2) {
          // Third ESC → stop. Not awaited: the keyboard path has nothing to
          // sequence after it, and `handleStop` never rejects.
          clearEscHint();
          void handleStop();
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

    window.addEventListener('keydown', onKeyDownCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isActiveSessionTab, readOnly, isBusy, handleStop, clearEscHint, escCount]);

  // Reset when session goes idle
  useEffect(() => {
    if (!isBusy) clearEscHint();
  }, [isBusy, clearEscHint]);

  // Unmount-only: a fade timer armed by a keydown must not outlive the chat.
  useEffect(() => {
    return () => {
      if (escFadeTimerRef.current) {
        clearTimeout(escFadeTimerRef.current);
      }
    };
  }, []);

  // Ref-based guard against rapid double-fire of commands (replaces
  // the old executeCommand.isPending check from the TQ mutation).
  const commandInFlightRef = useRef(false);

  const handleCommand = useCallback(
    (cmd: Command, args?: string, split?: { before: string; after: string }): boolean => {
      // Returns whether the command was DISPATCHED, not whether it succeeded.
      // The composer needs that distinction: a swallowed dispatch that reports
      // success clears the draft, so the command is lost with nothing on screen
      // to say so.
      if (commandInFlightRef.current) return false;
      setCommandError(null);

      playSound('send');
      // Rebuild the sentence the way it was WRITTEN, not command-first. This
      // used to be `/${name} ${args}` unconditionally, which is why typing
      // `explain /webapp to me` produced `/webapp explain to me` — the chip's
      // position is not recoverable from `args`, so it has to be carried
      // (`split`, from the editor's serializer) or it is lost here.
      const label = split
        ? [split.before, `/${cmd.name}`, split.after].filter(Boolean).join(' ')
        : args
          ? `/${cmd.name} ${args}`
          : `/${cmd.name}`;
      const selectedModel = local.model.sendKey ?? undefined;
      const handleCommandError = (err?: unknown) => {
        // A command that was DELIVERED and then lost its connection is not a
        // failed command. `/command` blocks for the whole turn, so both proxy
        // hops routinely stop waiting while opencode is still working — and the
        // request was already on the wire when they did. Clearing the session
        // to `idle` and painting an error here told the user their message had
        // not sent while the agent was actively answering it, and invited the
        // retry that aborts the live turn and stamps it "Interrupted".
        // See `delivered-but-disconnected.ts`.
        if (isDeliveredButDisconnected(errorMessageOf(err))) {
          pendingCommandStashRef.current = null;
          // The session status stays put on purpose: the turn is live and SSE
          // owns it from here.
          return;
        }
        // Release the receipt taken at dispatch — it is what held the composer
        // on "working" for a command that has now failed. No fabricated idle
        // frame beside it: dropping the receipt IS the honest signal, and a
        // written frame outranked the control plane's `/turn` answer.
        clearSendReceipt(label);
        pendingCommandStashRef.current = null;
        setCommandError(classifySessionError(err));
      };

      pendingCommandStashRef.current = {
        name: cmd.name,
        args: args || cmd.description,
        // Carried to `UserMessage` via `commandMessagesRef` so the sent bubble
        // draws the chip where it was typed. Display only.
        split,
      };
      // Closes the queue drain's working gate SYNCHRONOUSLY. Without it a
      // command dispatched from the queue left every gate clear: the drain's
      // 700ms settle window would elapse before the server reported busy, the
      // next queued message would go out, and a new prompt mid-turn aborts the
      // one running — the "Interrupted" symptom the queue exists to prevent.
      // A command is not an inbox row, so this receipt is the only thing that
      // covers it until the runtime reports the turn.
      noteSendReceipt(label);

      // Match SolidJS reference (submit.ts:259-289): fire command
      // directly via SDK — no TanStack Query, no mutation retry, no
      // optimistic message. The server creates the user message and
      // SSE delivers it. Commands use the blocking /command endpoint
      // which can take minutes; using TQ would cause retry on timeout.
      commandInFlightRef.current = true;
      const agent = composerAgentName ?? undefined;
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
          // `/command` blocks for the whole turn, so this is the turn ending —
          // and the instant from which a `/turn` read can speak for it. Nothing
          // accepted a command's receipt before, and an unaccepted receipt puts
          // the server floor at infinity: for a full 60s after every `/compact`
          // the control plane's own "no turns" answer was discarded, and a
          // dropped idle frame held the composer on Stop for twice the 30s
          // backstop this replaced. A no-op when `handleCommandError` already
          // dropped the receipt, or when a newer send replaced it.
          acceptSendReceipt(label);
        });
      setTimeout(() => scrollToBottom(), 50);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      scrollToBottom,
      sessionState,
      executeCommand,
      composerAgentName,
      local.model.currentKey,
      local.model.sendKey,
      local.model.variant.current,
    ],
  );

  const pathname = usePathname();
  const router = useRouter();

  // Thread context for subsessions only (real parentID).
  const { data: parentSessionData } = useRuntimeSession(session?.parentID || '');

  // The "Sub-session of <parent>" back destination, resolved the moment the
  // parent session loads. It is a route-cache miss on the `?oc=` branch, so it
  // is warmed below instead of being fetched cold on the click.
  const backToParentHref = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return null;
    const projectRoute = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
    if (!projectRoute) return null;
    const [, projectId, projectSessionId] = projectRoute;
    return parentSessionData.parentID
      ? `/projects/${projectId}/sessions/${projectSessionId}?oc=${encodeURIComponent(parentSessionData.id)}`
      : `/projects/${projectId}/sessions/${projectSessionId}`;
  }, [session?.parentID, parentSessionData, pathname]);

  useEffect(() => {
    if (backToParentHref) router.prefetch(backToParentHref);
  }, [backToParentHref, router]);

  const threadContext = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return undefined;
    return {
      parentTitle: parentSessionData.title || 'Parent session',
      onBackToParent: () => {
        if (backToParentHref) {
          // nav-contract: prefetch-only — the composer's threadContext contract
          // carries an opaque `onBackToParent: () => void`, so this control
          // cannot render an anchor until that contract carries the href.
          router.push(backToParentHref);
          return;
        }
        // The fallback when the panel contract carries no href. Project-scoped,
        // because `/sessions/<id>` is not a route: the tab stays mounted so the
        // click looks fine, but that URL 404s on reload or Back.
        openTabAndNavigate({
          id: parentSessionData.id,
          title: parentSessionData.title || 'Parent session',
          type: 'session',
          href: projectId
            ? projectSessionHref(projectId, parentSessionData.id)
            : `/sessions/${parentSessionData.id}`,
        });
      },
    };
  }, [session?.parentID, parentSessionData, backToParentHref, router, projectId]);

  // ---- Stable props for <SessionChatInput> (it's React.memo-wrapped, so every
  // prop below must keep referential identity across renders that don't
  // actually change it — otherwise the memo is defeated on every streaming
  // token). Bodies are verbatim copies of what used to be inlined in the JSX. ----

  const handleAgentChange = useCallback(
    (name: string | null | undefined) => local.agent.set(name ?? undefined),
    [local.agent],
  );

  const handleModelChange = useCallback(
    (m: ModelKey | null) => local.model.set(m ?? undefined, { recent: true }),
    [local.model],
  );

  // Only the ACCOUNT default is settable from the picker now — it is the one
  // scope with no screen of its own. The project default lives in the provider
  // modal's Models tab and the agent default on the agent's detail page, both
  // of which also SHOW and can CLEAR what is set. See ModelDefaultControls.
  // Native mode (llm_gateway off) has NO model-defaults chain: the star's
  // write 404s llm_gateway_disabled, so the affordance disappears entirely.
  const chatModelDefaultControls: ModelDefaultControls | undefined = useMemo(
    () =>
      local.model.defaults.llmGatewayEnabled
        ? {
            accountDefault: local.model.defaults.accountDefault ?? null,
            onSetAccountDefault: (m) => {
              void local.model.defaults.setAccountDefault(m);
            },
          }
        : undefined,
    [local.model.defaults],
  );

  const handleVariantChange = useCallback(
    (v: string | null | undefined) => local.model.variant.set(v ?? undefined),
    [local.model.variant],
  );

  const handleContextClick = useCallback(() => setContextModalOpen(true), []);
  const handleCompactClick = useCallback(() => setCompactModalOpen(true), []);

  const handleCustomAnswer = useCallback((text: string) => {
    questionPromptRef.current?.submitCustomAnswer(text);
  }, []);

  const handleQuestionAction = useCallback(() => {
    questionPromptRef.current?.performAction();
  }, []);

  const chatCommands = useMemo(() => commands || [], [commands]);

  /**
   * Where this session's unsent draft is persisted.
   *
   * `projectSessionId` — the KORTIX session id — not the OpenCode `sessionId`:
   * it is the id the boot shell also keys on, so a draft typed in the instant
   * shell is still there after the crossfade into this component, and it is
   * the same id every other per-session handoff store uses
   * (`session-composer-handoff-store.ts`). Null before it resolves, which just
   * means the composer persists nothing for those few frames.
   *
   * Memoized like every other prop in this block: SessionChatInput is
   * React.memo-wrapped, and a fresh object literal per render would defeat the
   * memo on every streaming token.
   */
  const composerDraftScope = useMemo<DraftScope | null>(
    () => (projectSessionId ? { kind: 'session', sessionId: projectSessionId } : null),
    [projectSessionId],
  );

  // Null in the sub-session modal, which renders this chat read-only and
  // OUTSIDE `SessionPanelProvider` — the same self-gating every other panel
  // consumer does (see `easy-panel.tsx`).
  const panel = useOptionalSessionPanel();

  // A landed compaction summary opens HERE, in the panel's detail view — the
  // same surface a file opens into. Read through a ref so the callback stays
  // identity-stable while the panel context value churns with messages
  // (SessionTurn is memoized on its props; see `onOpenCompactionSummary`).
  const panelRef = useRef(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);
  const handleOpenCompactionSummary = useCallback((turnId: string, summary: string) => {
    panelRef.current?.openDetail({
      key: `compaction:${turnId}`,
      title: 'Compaction summary',
      icon: <Layers weight="duotone" className="size-4" />,
      padded: true,
      body: <CompactionSummaryBody summary={summary} />,
    });
  }, []);

  /**
   * The session's files, handed to the composer so the `/` palette can offer
   * them — the Outputs card's deliverables and the Context card's reads, as
   * `sessionSlashFiles` flattens them.
   *
   * Read here rather than inside the composer because this component already
   * sits beside the panel, and the composer is also mounted on project home
   * and in the marketing demo, where importing the panel provider would drag
   * the whole detail-panel tree into their bundles. See `Composer`'s
   * `slashFiles` prop.
   *
   * `panel.files` arrives already ranked — this run's deliverables first, then
   * everything older, each group in `sortOutputs` order — so the palette and
   * the Outputs card cannot disagree about which file matters most.
   *
   * Both inputs are re-derived from `messages`, so their identity changes on
   * every streaming update and this memo re-runs with them. That is a walk of
   * a few dozen items; it is not worth a deeper equality check, and this
   * component is already re-rendered by the same `messages` change.
   */
  const panelOutputs = panel?.files;
  const panelContextFiles = panel?.context.files;
  const chatSlashFiles = useMemo(
    () =>
      sessionSlashFiles({
        outputs: panelOutputs ?? [],
        contextFiles: panelContextFiles ?? [],
      }),
    [panelOutputs, panelContextFiles],
  );
  const sessionScopeAgentName = composerAgentName ?? undefined;

  const chatToolbarSlot = useMemo(
    () =>
      projectId && projectSessionId ? (
        <SessionOverridesComposer
          projectId={projectId}
          sessionId={projectSessionId}
          selectedAgent={sessionScopeAgentName ?? null}
        />
      ) : undefined,
    [projectId, projectSessionId, sessionScopeAgentName],
  );

  const chatInputSlot = useMemo(
    () => (
      <>
        {/* Queue paused by a Stop hold. The per-row Resume is a hover-only icon
            on each held bubble; this is the ONE control that is always visible
            while the queue is stopped, so the paused state is never a surprise
            and recovery is one click. Self-hides when nothing is held. */}
        {queueRows.held && heldQueueCount > 0 ? (
          <div className="border-border bg-muted/40 mb-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
              <PauseIcon weight="fill" className="size-4 shrink-0" />
              <span className="truncate">
                Queue paused — {heldQueueCount} {heldQueueCount === 1 ? 'prompt' : 'prompts'}{' '}
                waiting
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => void handleResumeQueue()}
            >
              <PlayIcon weight="fill" className="size-3.5" />
              Resume
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
              'w-full overflow-hidden transition-[max-height,opacity,transform] ease-in-out',
              questionPromptVisible
                ? 'max-h-130 translate-y-0 opacity-100 duration-300'
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
      pendingPermissions,
      handlePermissionReply,
      renderedQuestion,
      questionPromptVisible,
      handleQuestionReply,
      handleQuestionReject,
      handleQuestionActionChange,
      queueRows.held,
      heldQueueCount,
      handleResumeQueue,
    ],
  );

  // The rewound-path notice lives on the composer toolbar, beside send/stop —
  // send is what commits the path, so the control sits at the moment of
  // commitment instead of in a banner above the card. No manual useMemo: the
  // React Compiler memoizes this component, and a hand-written dependency list
  // narrower than `sessionState` makes it skip the whole component.
  // `!editSendPending` — during an inline edit's Send the revert is staged
  // FIRST and committed only after `handleSend` resolves, so without the gate
  // the Restore button paints for the milliseconds in between: a control that
  // flashes in and vanishes. While the edit-send is in flight the staged
  // revert is already spoken for; only a FAILED send (editSendPending back to
  // false, record still staged) should surface it.
  const composerRewind =
    sessionState?.rewindMessageId && !editSendPending
      ? {
          pending: sessionState.rewindPending,
          // OpenCode's `unrevert` asserts the session is idle (`assertNotBusy`
          // → BusyError) — offering the button mid-run offers a guaranteed
          // failure, so it waits, visibly, instead.
          disabled: isBusy,
          onRestore: () => void handleRestoreRewind(),
        }
      : undefined;

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
  // `useRuntimePhase()` distinguishes a booting/reconnecting sandbox from one
  // confirmed unreachable past the poll loop's failure threshold — plain
  // `runtimeReady` collapses both into the same false. See `retryable` on
  // `SessionComposerReadiness`.
  // The control plane's own statement about the sandbox behind this session —
  // the positive evidence the connection projection needs before anything may
  // say "waking". Read from the shared cache entry `useProjectSession`
  // populates, so this mounts no second poll of its own.
  const projectSessionRow = useProjectSession(projectId, projectSessionId ?? undefined, {
    enabled: !!projectId && !!projectSessionId,
  }).data;
  const runtimePhase = useRuntimePhase();
  // Covers the one gap `unreachable` can't: a sandbox proxy that keeps
  // answering with a 503 (OpenCode wedged mid-boot) resets the probe's
  // failure counter every tick, so `unreachable` never fires no matter how
  // long it stays wedged. See `useRuntimeBootStalled`.
  const runtimeStalled = useRuntimeBootStalled();
  // Label an involuntary page load (discarded tab, or a chunk 404 after a
  // deploy) so the next "my session randomly disconnected" report arrives with
  // its cause attached instead of a shrug.
  useReloadForensics(projectSessionId);
  // Nothing has answered yet and the mount is young: the difference between
  // "this session is asleep" and "we have not looked yet". Without it, every
  // page load painted the waking notice for a beat over a session that was
  // never asleep — which reads as a disconnect. See `settling`.
  const composerSettling = useReadinessSettling(runtimePhase === 'connecting');
  // ONE answer for every surface that draws this session's runtime, and the
  // reason the composer no longer guesses: `unknown` and `connecting` are
  // waits, and a wait is not a fault. Only the control plane saying the box is
  // down earns the waking notice.
  const sessionConnection = projectSessionConnection({
    sandbox: (projectSessionRow?.status as SandboxLifecycle | undefined) ?? null,
    runtimeReady,
    unreachable: runtimePhase === 'unreachable' || runtimeUnreachable,
    stalled: runtimeStalled,
    activityFresh: working.state === 'working' && working.source === 'stream',
  });
  const composerReadiness = sessionComposerReadiness({
    runtimeReady,
    connection: sessionConnection,
    settling: composerSettling,
    // Only an OPEN TURN the control plane is holding counts here. This tab's
    // optimistic receipt and a stream frame both survive a box that died
    // mid-turn, and a durable inbox row (which the projection also sources to
    // `server`) exists precisely while nothing is running yet — see
    // `serverHoldsOpenTurn`.
    serverTurnLive: serverHoldsOpenTurn(working),
    unreachable: runtimePhase === 'unreachable' || runtimeUnreachable,
    stalled: runtimeStalled,
  });
  // #6509's `promptLikelyDropped` notice is deliberately NOT carried over: it
  // instrumented the deleted prompt-observation stall machinery to warn about
  // accepted-but-never-started prompts, and that state is structurally gone —
  // a prompt is a durable inbox row before anything else happens, and an
  // unconfirmed delivery is redelivered by the reaper (see step 7).
  const { isNotFound, isDataLoading: resolvedDataLoading } = resolveSessionContentState({
    runtimeReady,
    sessionFetched,
    hasRuntimeSession: Boolean(session),
    hasMessages,
    // The producer's own copy of the first prompt counts as content here for
    // the same reason it counts in `hasChatContent` above: it is a bubble this
    // component will paint. It used to count in one place and not the other, so
    // on the home->session hand-off — the one path that plants a preview —
    // there was a window with content to draw and `isDataLoading` still true.
    // The early return below then replaced the instant shell's thread with the
    // compact "starting" loader for a frame or two before the real chat
    // appeared: the flicker, mid-crossfade.
    hasOptimisticPrompt: promptInbox.prompts.length > 0 || firstPromptPreview !== null,
    // The session OBJECT arriving is not the transcript arriving — they are two
    // different requests, and the message read is the one that loses to a
    // waking box. Without this the shell rendered over an unread session and
    // the user saw an empty conversation instead of a wait.
    transcriptLoaded: !syncMessagesLoading,
  });
  // MONOTONIC: once this component has painted content, the loader may never
  // replace it. The resolver holds the FIRST paint for the transcript read
  // (so a session open paints the whole conversation at once instead of
  // user-only inbox bubbles with the replies popping in later) — but the same
  // rule re-evaluated after content is on screen would hide it again: the
  // home→session hand-off paints the first-prompt preview before the runtime
  // session resolves, and a bubble typed mid-boot exists before the first
  // read lands. A loader is a promise about what is coming, not a curtain
  // over what is already there.
  const [contentPainted, setContentPainted] = useState(false);
  if (!resolvedDataLoading && !contentPainted) setContentPainted(true);
  const isDataLoading = resolvedDataLoading && !contentPainted;
  // Everything that isn't "we have content" and isn't the terminal not-found
  // state is loading — including the boot window where the query is still
  // disabled (isLoading=false) waiting on the runtime.
  //
  // Tell the route when that window closes, so the crossfade out of the instant
  // shell lands on the conversation and not on the loader below.
  useEffect(() => {
    if (!isDataLoading) onContentReady?.();
  }, [isDataLoading, onContentReady]);
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

  // ---- Outcomes: turn footer cards + the change request's shareable link ----
  // The base branch this session forks from — the SAME read the Changes tab
  // uses (`useSessionBaseRef`), so the transcript and Changes cannot disagree
  // about which ref backs a change request.
  const outcomesBaseRef = useSessionBaseRef(projectId, projectSessionId);
  const searchParams = useSearchParams();
  // `readOnly` is the nested sub-session modal (`sub-session-modal.tsx`) — it
  // shares this component but must not rewrite the parent route's URL.
  const [openCrId, setOpenCrIdState] = useState<string | null>(() =>
    readOnly ? null : (searchParams?.get('cr') ?? null),
  );
  const setOpenCrId = useCallback(
    (id: string | null) => {
      setOpenCrIdState(id);
      if (readOnly) return;
      const params = new URLSearchParams(searchParams?.toString());
      if (id) params.set('cr', id);
      else params.delete('cr');
      const qs = params.toString();
      // `history.replaceState`, not `router.replace`: `cr` is a param this
      // page has already resolved client-side, so there is no server data to
      // fetch. Changing a query param changes the router cache key, so
      // `router.replace` would run a COLD RSC FETCH on every open/close of
      // this dialog, on the hottest route in the app — see the same trap
      // documented at
      // app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:1309. Next
      // patches `replaceState` and updates its own canonical URL, so
      // `useSearchParams` still reports the new URL. Same mechanism as
      // `openTabAndNavigate` in `stores/tab-store.ts`.
      window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
    },
    [readOnly, pathname, searchParams],
  );
  const handleOpenOutcome = useCallback(
    (outcome: Outcome) => {
      // Change requests are the only kind a turn produces. `external` exists on
      // the union for `setup-links/setup-link-button.tsx`, which renders this
      // card inline in prose and handles its own open.
      if (outcome.kind === 'change_request') setOpenCrId(outcome.id.slice('cr:'.length));
    },
    [setOpenCrId],
  );

  // While the session is still connecting / loading its content, render ONLY the
  // staged loader — never the session shell (header + input) at the same time.
  // Showing both reads as "loaded and loading at once" (the very contradiction
  // the loader exists to avoid). The connection keeps running in the parent
  // ProjectSessionRuntimeConnection, so as soon as the runtime is ready
  // isDataLoading flips and the full shell renders in one shot.
  if (isDataLoading) {
    // A transcript read that genuinely FAILED (not a waking box — the SDK keeps
    // those on `loading` and retries them itself) gets an explicit retry, not
    // an eternal loader. Only with nothing to paint: once any message is on
    // screen, staleness is repaired in the background instead.
    if (transcriptFreshness === 'error' && !hasMessages) {
      return (
        <div className="bg-background relative flex h-full flex-col" data-testid="session-chat">
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 p-6"
            data-testid="session-transcript-error"
          >
            <p className="text-muted-foreground text-sm">Couldn&apos;t load this conversation.</p>
            <Button variant="outline" size="sm" onClick={() => retryTranscript()}>
              Retry
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="bg-background relative flex h-full flex-col" data-testid="session-chat">
        {/* `projectId`/`sessionId` are what arm the loader's restart offer
            (`canRestart`). Without them a session wedged in this state spun
            forever with no way out but a page reload. The stage must also track
            the real runtime — hardcoding "ready" froze the copy on
            "Connecting" no matter what the boot was actually doing. */}
        <SessionStartingLoader
          stage={runtimeReady ? 'ready' : 'starting'}
          variant="compact"
          projectId={projectId}
          sessionId={projectSessionId}
        />
      </div>
    );
  }

  return (
    // Outcomes' cache coherence and the shareable `?cr=` link both hinge on
    // ONE `ProjectFilesProvider`: `useChangeRequests` inside
    // `SessionOutcomesProvider` and `ChangeRequestDetailDialog` below both read
    // their project id from this context, which is what keeps them on the same
    // React Query cache entry (see `outcomes/session-outcomes-provider.tsx`).
    <ProjectFilesProvider
      value={{ projectId: projectId ?? '', ref: outcomesBaseRef, defaultBranch: outcomesBaseRef }}
    >
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

        {/* Compact modal — opened from the composer's `/` palette */}
        <CompactModal
          sessionId={sessionId}
          open={compactModalOpen}
          onOpenChange={setCompactModalOpen}
        />

        {/* Change request detail — opened from a turn's outcome card, or from
          `?cr=` on load. Lives inside `ProjectFilesProvider` alongside
          `SessionOutcomesProvider` so both read the SAME project id and cache. */}
        <ChangeRequestDetailDialog crId={openCrId} onClose={() => setOpenCrId(null)} />

        {/* Chat and the action panel share one row — see `session-body.tsx`. The
          instant shell renders the SAME row, so nothing moves at the crossfade.
          Self-gates to null on mobile and outside a SessionPanelProvider (the
          read-only sub-session modal renders this component with no panel). */}
        <SessionBodyRow actionPanel={!hideHeader && !readOnly}>
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
              {/* An anchor, not a button: home is known at render time, so Next
                  prefetches it and the click never runs a cold RSC fetch that
                  could degrade into a full page load. */}
              <Button asChild variant="outline" size="sm">
                <Link
                  href="/"
                  prefetch
                  onClick={() => {
                    try {
                      if (sessionId) useTabStore.getState().closeTab?.(sessionId);
                    } catch {}
                  }}
                >
                  {tHardcodedUi.raw('componentsSessionSessionChat.line5833JsxTextGoToHome')}
                </Link>
              </Button>
            </div>
          ) : (
            <div ref={chatAreaRef} className="relative z-10 min-h-0 flex-1">
              <div
                ref={scrollContainerCallbackRef}
                className={cn(
                  // overflow-anchor:none — this scroll area does ALL of its own
                  // anchoring (useAutoScroll's spacer + RAF follow, the send-path
                  // turn anchor, and the history-prepend content-space restore in
                  // session-history-scroll.ts). The browser's native scroll
                  // anchoring (default `overflow-anchor: auto`) tries to
                  // compensate for the SAME prepends independently, and the two
                  // corrections stacking is the other half of the scroll-up
                  // teleport: ours restores the reader's position, then the
                  // native one nudges it again.
                  'scrollbar-hide relative z-10 h-full flex-1 overflow-y-auto [scroll-behavior:auto] [overflow-anchor:none]',
                  shouldShowWelcomeOverlay ? 'bg-transparent' : 'bg-background',
                )}
                onMouseUp={handleChatMouseUp}
                onMouseDown={handleChatMouseDown}
                onScroll={handleChatScroll}
              >
                <div
                  ref={contentRef}
                  role="log"
                  // Width and gutters live in `SESSION_TRANSCRIPT_CLASS`: the
                  // instant shell draws this same column and the two crossfade
                  // into each other, so a difference here is a sideways jump on
                  // screen, not a style opinion. See session-body.tsx.
                  //
                  // No bottom padding, there or here: the space under the last
                  // message is the auto-scroll spacer's job alone. The `pb-32`
                  // that used to sit here stacked 128px of dead space on top of
                  // it — the "extra inset at the bottom of the session".
                  className={SESSION_TRANSCRIPT_CLASS}
                >
                  <div className="flex min-w-0 flex-col">
                    {/* Turn-based message rendering.
                    ToolActivateContext makes inline tool rows open the side
                    panel (Actions) focused on that tool, instead of expanding. */}
                    {/* `showOlderLoading` and not just `hasOlder`: the LAST page
                      clears the cursor in the same update that delivers it, so
                      a block gated on `hasOlder` alone tears the loading row
                      down at the exact moment the page lands — the reader
                      watches the transcript grow with no explanation, which is
                      the one pull where the explanation matters most. */}
                    {(hasOlder || showOlderLoading) && (
                      <div className="mb-6 flex flex-col items-center gap-2">
                        {/* Sentinel: crossing into view pulls the previous page.
                        Sits above the spinner so it clears the viewport as
                        soon as the prepended turns render. */}
                        {hasOlder && (
                          <div ref={olderSentinelRef} aria-hidden className="h-px w-full" />
                        )}
                        {/* A named state, not a bare spinner: the transcript is
                          about to grow upward and the reader is owed the
                          reason. Held for OLDER_LOADING_MIN_MS so a fast pull
                          reads as a sentence instead of a flash. */}
                        {showOlderLoading && (
                          <div
                            role="status"
                            className="text-muted-foreground flex items-center gap-2 py-1 text-xs"
                          >
                            <Loading className="size-3.5 shrink-0" />
                            Loading older messages
                          </div>
                        )}
                        {!showOlderLoading &&
                          !olderPullFailed &&
                          olderAutoloadExhausted({ hasOlder, autoLoadedPages }) && (
                            <Button
                              type="button"
                              variant="outline-ghost"
                              size="sm"
                              onClick={() => void handleLoadOlder()}
                            >
                              Load older messages
                            </Button>
                          )}
                        {olderPullFailed && !showOlderLoading && (
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
                    <SessionOutcomesProvider
                      projectSessionId={projectSessionId}
                      turnSpans={turnSpans}
                      onOpen={handleOpenOutcome}
                    >
                      {/* Head-of-transcript rollup — same provider the footer cards
                      read (see session-outcomes-provider.tsx). NO `isBusy`
                      gate, unlike the per-turn footer card: a footer card
                      gates on busy because an in-progress turn hasn't produced
                      a settled outcome yet, but this strip only ever
                      summarises outcomes that are ALREADY settled — nothing
                      about it becomes truer once the session goes idle.
                      Self-hides via `SummaryHeading` returning null for an
                      empty list. Gating this on `isBusy` would remount it on
                      EVERY turn (far more often than outcomes actually
                      change) and shift content above a bottom-anchored,
                      self-anchoring transcript — do not add the gate back for
                      symmetry with the footer card. Gated on `!readOnly`: the
                      nested sub-session modal (`SubSessionModal`) mounts this
                      SAME `SessionChat` with `readOnly` set, and without the
                      gate it grew its own head-of-transcript strip on top of
                      the parent transcript's. */}
                      {!readOnly && <SessionOutcomeSummary />}
                      <ToolActivateContext.Provider value={toolActivate}>
                        {/* The first prompt's producer copy (`useFirstPromptPreviewStore`),
                        ABOVE the turns: the transcript's own user message can arrive as
                        an info frame with no text yet, and its turn (with the working
                        indicator) must read as sitting under this bubble, not over it.
                        Gone the frame the transcript shows the text.

                        Drawn by `OptimisticTurn` — the SAME element the instant shell
                        paints for this exact prompt, which is what this stands in for
                        while the transcript catches up. It used to be a
                        `QueuedPromptBubbles` row: that row reserves a `w-6` action column
                        to the RIGHT of the bubble and carries no waiting row, so the
                        bubble landed 28px left of where the shell had it and the
                        "Thinking" line blinked out — during the 300ms the two surfaces
                        were crossfading into each other. The waiting row is suppressed
                        only when a turn is already drawing its own. */}
                        {showFirstPromptPreview &&
                          firstPromptPreview &&
                          queuedMessages.length === 0 && (
                            <OptimisticTurn
                              text={buildOptimisticPromptTextWithUploads(
                                firstPromptPreview.text,
                                firstPromptPreview.files,
                              )}
                              agentNames={agentNames}
                              onFileClick={openFileInComputer}
                              sessionId={sessionId}
                              busy={turns.length === 0}
                            />
                          )}
                        {turns.map((turn, turnIndex) => {
                          // Check if this turn is a compaction summary — and
                          // whether it actually PRODUCED one. A failed/aborted
                          // attempt (compaction-flagged, no content, not the
                          // working turn) renders as one slim row, draws no
                          // divider, and stacks tight against a neighbouring
                          // failed attempt.
                          const compaction = compactionTurnInfo(turn);
                          const hasCompaction = compaction.isCompaction;
                          const isTurnWorking =
                            lastTurnWorking &&
                            turn.userMessage.info.id === workingTurn.workingTurnId;
                          // `inFlight` (message state) alongside the projection:
                          // classifying by projection alone flipped a streaming
                          // compaction to "failed" for the frames where the two
                          // disagree, popping the divider in and out — a layout
                          // bounce right where the reader is looking.
                          const isFailedCompaction =
                            hasCompaction &&
                            !compaction.hasContent &&
                            !compaction.inFlight &&
                            !isTurnWorking;
                          // Retries collapse to ONE visible row, GLOBALLY: a
                          // failed attempt with ANY later compaction turn (a
                          // retry, or the one that finally landed) is history —
                          // it keeps its TurnViewport (stable keys, scroll
                          // anchors) but renders no content, and an empty
                          // TurnViewport costs 0px (turn-viewport.tsx RULE 2).
                          // Adjacency was not enough: attempts whose error landed
                          // on a plain assistant message used to interleave as
                          // unclassified turns, breaking every consecutive run.
                          const suppressedFailedCompaction =
                            isFailedCompaction && turnIndex < lastCompactionTurnIndex;

                          // Notification-only early-return removed: it rendered the
                          // user's pty_* card but skipped turn.assistantMessages,
                          // hiding every subsequent assistant response in that turn.
                          // Fall through to the normal turn renderer instead.

                          return (
                            <TurnViewport
                              // ONE element per prompt: keyed by the id the
                              // bubble was FIRST painted under, so the swap to a
                              // re-minted echo id re-renders this node instead
                              // of mounting a new one (opacity keeps animating,
                              // hover state survives, nothing jumps).
                              key={turnRenderKeys.get(turn.userMessage.info.id)}
                              turnId={turn.userMessage.info.id}
                              // Queued bubbles STACK: a pending turn right after
                              // another pending turn sits close to it, like a
                              // list of what is waiting — not a turn's width
                              // apart as if each had been answered in between.
                              // (Failed compaction rows need no stacking rule any
                              // more — at most one is visible at a time.)
                              className={
                                turnIndex === 0
                                  ? ''
                                  : lastTurnWorking &&
                                      pendingTurnIds.has(turn.userMessage.info.id) &&
                                      pendingTurnIds.has(turns[turnIndex - 1].userMessage.info.id)
                                    ? 'mt-3'
                                    : 'mt-12'
                              }
                            >
                              {/* No separate divider for compaction turns — the
                              CompactionMarker rendered by SessionTurn IS the
                              divider (rule–pill–rule), through every phase. */}
                              {suppressedFailedCompaction ? null : (
                                <SessionTurn
                                  turn={turn}
                                  isLast={turn.userMessage.info.id === lastUserMessageId}
                                  ownsPlan={turn.userMessage.info.id === planAnchorId}
                                  sessionId={sessionId}
                                  sessionStatus={sessionStatus}
                                  permissions={pendingPermissions}
                                  questions={pendingQuestions}
                                  agentNames={agentNames}
                                  isFirstTurn={turnIndex === 0}
                                  sessionWorking={lastTurnWorking}
                                  isWorkingTurn={
                                    turn.userMessage.info.id === workingTurn.workingTurnId
                                  }
                                  suppressBusyIndicator={suppressWorkingTurnBusy}
                                  pending={
                                    lastTurnWorking && pendingTurnIds.has(turn.userMessage.info.id)
                                  }
                                  queueRow={
                                    inboxRowsByMessageId.get(turn.userMessage.info.id) ?? null
                                  }
                                  queueHeld={queueRows.held}
                                  onQueueRemove={handleRemoveQueuedMessage}
                                  onQueueSendNow={handleQueueSendNow}
                                  onQueueRetry={handleRetryQueuedMessage}
                                  interruptedBeforeRun={interruptedTurnIds.has(
                                    turn.userMessage.info.id,
                                  )}
                                  isCompaction={hasCompaction}
                                  onOpenCompactionSummary={
                                    panel ? handleOpenCompactionSummary : undefined
                                  }
                                  providers={providers}
                                  commandMessages={commandMessagesRef.current}
                                  commands={commands}
                                  disableToolNavigation={disableToolNavigation}
                                  onPermissionReply={handlePermissionReply}
                                  onRewind={handleRewind}
                                  editingText={
                                    rewindTarget?.messageId === turn.userMessage.info.id
                                      ? rewindTarget.text
                                      : null
                                  }
                                  editPending={editSendPending || !!sessionState?.rewindPending}
                                  onEditCancel={handleEditCancel}
                                  onEditSend={handleEditSend}
                                  rewindDisabled={
                                    !!readOnly ||
                                    !sessionState ||
                                    isBusy ||
                                    sessionState.rewindPending ||
                                    // The runtime is not idle while queued prompts
                                    // are still on their way to it — a rewind mid-
                                    // delivery fails downstream with "Session is
                                    // busy" (measured); refuse it up front instead.
                                    promptInbox.prompts.length > 0
                                  }
                                />
                              )}
                            </TurnViewport>
                          );
                        })}
                      </ToolActivateContext.Provider>
                    </SessionOutcomesProvider>

                    {/* Optimistic compaction — the SAME marker the compaction
                      turn renders, in the SAME place the real turn will mount
                      (the end of the transcript, where the newest message
                      lands), so the swap to the real turn is an in-place
                      replacement rather than a cross-screen teleport. */}
                    {isOptimisticCompacting && !hasCompactionTurn && (
                      <div className={turns.length > 0 ? 'mt-12' : 'mt-2'}>
                        <CompactionMarker running />
                      </div>
                    )}

                    {/* Busy indicator when no turns yet but session is busy */}
                    {commandError && (
                      <TurnErrorDisplay
                        error={commandError}
                        isAbort={isAbortError(commandError.cause)}
                        className="mt-2"
                      />
                    )}
                    {/* A turn refused for a missing connector renders HERE — after
                    the last turn, directly under the message that triggered it —
                    rather than as a one-line pill. It is the one failure with a
                    button that fixes it.

                    Fed `commandError`, NOT `sessionState.sendError`: the SDK sets
                    `sendError` only inside `useSession.send()`, and this file has
                    always gone through `sendParts` instead (the send above, and the
                    resend below). So `sendError` is permanently null here, and
                    since `TurnErrorDisplay` deliberately suppresses `kind:
                    'connector'` to leave the remedy to this card, a refused turn
                    rendered NOTHING — no card, no pill. `commandError` is the same
                    typed error, classified through the same `classifySendError`. */}
                    <ConnectorRequiredNotice
                      error={commandError}
                      projectId={projectId}
                      resend={
                        sessionState && lastSubmittedRef.current
                          ? () => {
                              const last = lastSubmittedRef.current;
                              if (!last) return;
                              // Clear before, re-classify after: this bypasses the
                              // normal submit path, which is the only other place
                              // `commandError` is managed. Without the clear the
                              // card outlives a successful retry; without the catch
                              // a second refusal looks like success.
                              setCommandError(null);
                              void sessionState
                                .sendParts(
                                  last.parts as Parameters<typeof sessionState.sendParts>[0],
                                  last.options as Parameters<typeof sessionState.sendParts>[1],
                                )
                                .catch((err: unknown) =>
                                  setCommandError(classifySessionError(err)),
                                );
                            }
                          : undefined
                      }
                      className="mt-2"
                    />
                    {/* Prompts queued at the SERVER, not yet in the transcript:
                        drawn as the dimmed user bubbles they are about to become.
                        The composer carries no queue strip any more. The first
                        prompt's producer copy (`useFirstPromptPreviewStore`)
                        stands in until either the row or the transcript has it,
                        so the bubble the boot shell drew never blinks out in the
                        crossfade. */}
                    {/* Unpainted queue rows render as synthetic turns in the
                        list above (`queuedSyntheticMessages`); only FAILED
                        rows remain here — a failure is not a turn-to-be and
                        must not dim like one. */}
                    <QueuedPromptBubbles
                      className={
                        turns.length === 0
                          ? undefined
                          : lastTurnWorking &&
                              pendingTurnIds.has(turns[turns.length - 1].userMessage.info.id)
                            ? 'mt-3'
                            : 'mt-12'
                      }
                      queued={[]}
                      inFlightIds={queueInFlightIds}
                      failed={failedQueuedMessages}
                      held={queueRows.held}
                      onRemove={handleRemoveQueuedMessage}
                      onSendNow={handleQueueSendNow}
                      onRetry={handleRetryQueuedMessage}
                    />
                    {/* Busy with no turn to attach it to yet — the same waiting row
                        the optimistic turn and every live turn use, so it never
                        changes shape as the first turn materialises. */}
                    {isBusy && turns.length === 0 && <SessionBusyIndicator sessionId={sessionId} />}
                  </div>
                  {/* Spacer — the transcript's anchor space. It is sized from
                      the scroll container so the newest turn
                      can sit at the TOP of the viewport with the answer
                      streaming in beneath it, and it keeps that height when the
                      turn ends — nothing shifts on idle. Height is written
                      directly by use-auto-scroll.ts. */}
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
                  'absolute inset-x-0 bottom-4 z-20 flex justify-center',
                  !showScrollButton && 'pointer-events-none',
                )}
              >
                <Button
                  variant="transparent"
                  size="icon-md"
                  aria-hidden={!showScrollButton}
                  tabIndex={showScrollButton ? undefined : -1}
                  className={cn(
                    'hit-area-2 liquid-glass bg-liquid-glass hover:bg-liquid-glass-hover shadow-liquid-glass rounded-full',
                    'transition-[opacity,scale] ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:scale-100 motion-reduce:transition-opacity',
                    showScrollButton
                      ? 'scale-100 opacity-100 duration-150'
                      : 'scale-[0.97] opacity-0 duration-100',
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
                // `undefined`, not `true`, once released: the composer's own
                // viewport rule (>= 640px) still decides, so this never forces
                // focus onto a phone keyboard.
                autoFocus={deferComposerFocus ? false : undefined}
                onSend={async (text, files, mentions) => {
                  await handleSend(text, files, mentions);
                }}
                prefill={composerPrefill}
                draftScope={composerDraftScope}
                attachRequestId={attachRequestId}
                isBusy={isBusy}
                // The ONE projection, not the 300 ms busy fade: it is what
                // decides whether a `/` command may be dispatched, and a fade
                // timer that has already lapsed would let one abort a live turn.
                // `effectiveBusy` folds in optimistic compaction (not a turn, so
                // not in `working`) and the retrying-turn predicate, so this
                // site reads one value instead of re-OR-ing a term onto it.
                sessionWorking={effectiveBusy}
                // Gates `/` COMMANDS only. A prompt typed at a sleeping box is
                // an inbox row and goes out when the box answers; a command has
                // no row, and `runCommand` swallows it silently until the
                // runtime is switched.
                runtimeReady={runtimeReady}
                rewind={composerRewind}
                onStop={handleStop}
                escCount={escCount}
                agents={local.agent.list}
                selectedAgent={composerAgentName}
                onAgentChange={handleAgentChange}
                noAccessibleAgents={noAccessibleAgents}
                commands={chatCommands}
                slashFiles={chatSlashFiles}
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
                providers={providers}
                modelRequired
                modelsLoading={providersLoading}
                threadContext={threadContext}
                onContextClick={handleContextClick}
                onCompactClick={handleCompactClick}
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
                notice={composerReadiness.notice}
                onNoticeRetry={
                  composerReadiness.notice && composerReadiness.retryable
                    ? requestRuntimeReconnect
                    : undefined
                }
              />
            </>
          )}
        </SessionBodyRow>
      </div>
    </ProjectFilesProvider>
  );
}

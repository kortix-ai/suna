'use client';

// ============================================================================
// Session transcript turn rendering (moved verbatim from session-chat.tsx —
// KRTX-355, phase 2 of code-spec:split-session-chat-ts).
// `SessionTurn` renders one turn, `TranscriptTurnRow` wraps it in its
// `TurnViewport`, and the message-indicator components render inline pills,
// answered-question cards and notification turns. `session-chat.tsx`
// re-exports the public names.
// ============================================================================


import { isQuestionTool } from '../session-activity-groups';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { detectCommandFromText } from '@/features/session/detect-command';
import { useTranslations } from '@/i18n/use-translations';
import { type SessionMessageAuthor, type SessionPrompt, groupShowSegments, isCompactionPart, isPatchPart, isSnapshotPart, isStepPart, toolKind } from '@kortix/sdk';
import {
  WarningIcon as AlertTriangle,
  CheckCircleIcon as CheckCircle,
  CheckIcon,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SystemNotificationCard,
  parseSystemNotifications,
  stripSystemPtyText,
} from '../message-parsing';
import { ActivityBurst } from '../turn/activity-burst';
import { CompactionFailedRow, CompactionMarker } from '../turn/compaction-card';
import { compactionTurnInfo, type CompactionTurnInfo } from '../turn/compaction-state';
import { ExpandableOutput } from '../turn/expandable-output';
import { isPlanWriteTool } from '../turn/plan-anchor';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  queuedBubbleTone,
  type QueuedPromptState,
  QueuedPromptFailure,
  QueuedPromptProgress,
  type QueuedPromptStatusState,
} from '../turn/queued-prompt-bubbles';
import { ShowGroupRenderer } from '../tool/show-group-renderer';
import { segmentTurn } from '../turn/segment-turn';
import { stabilizeTurns } from '../turn/stable-turns';
import { statusElapsedFrame } from '../turn/status-elapsed';
import { ThrottledMarkdown } from '../turn/throttled-markdown';
import { TurnViewport } from '../turn/turn-viewport';
import { UserMessage } from '../turn/user-message';
import { resolveWorkingTurn } from '../turn/working-turn';
import { useOptionalSessionPanel } from '@/features/session/action-panel/session-panel-provider';
import { Composer as SessionChatInput } from '@/features/session/composer/composer';
import { ConnectProviderDialog } from '@/features/session/model-selector';
import { TurnOutcomes } from '@/features/session/outcomes/turn-outcomes';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { showTurnBusyIndicator } from '@/features/session/turn-busy-visibility';
import type {
  AttachmentUploadStatus,
  NormalizedAttachment,
} from '@/features/session/turn/user-message';
import type { TurnServedModel } from '@/features/session/turn/served-model';
import { SessionBusyIndicator } from '../session-busy-indicator';
import { SessionTurnMeta } from '../session-turn-meta';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnSpan,
} from '../session-turn-meta-rows';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { useUserPreferencesStore, type ConversationDensity } from '@/stores/user-preferences-store';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolPartRenderer, TurnLiveContext } from '@/features/session/tool/tool-renderers';
import { type SentAttachment } from '@/features/session/sent-attachment-previews';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '@/lib/utils/kortix-system-tags';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import { Copy } from '@/features/icon/icons/copy';
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
  getTurnErrorRawText,
  getTurnStatus,
  isAgentPart,
  isAttachment,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
  unwrapError,
} from '@/ui';
import {
  isAbortError,
  turnEndNotice,
  type SessionTurnOutcome,
  type TurnEndNotice,
} from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { isOptimisticSessionPrompt, useSessionWorking } from '@kortix/sdk/react';
import { CodeBlockEndpoints, SandboxUrlDetector } from '../sandbox-url-detector';
import { resolveLastTurnWorking } from '../session-composer-readiness';

// ============================================================================
// Optimistic answers cache
// ============================================================================
// When a user answers a question, we save the answers here immediately.
// This survives SSE `message.part.updated` events that may overwrite the
// tool part's state before the server has merged the answers.  The cache
// is keyed by the question tool part's `id` (stable across updates).
// Entries are cleaned up once the server's authoritative part arrives with
// real `metadata.answers`.

export const optimisticAnswersCache = new Map<
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          <span className="text-foreground text-xs font-medium">
            {tI18nComplete.raw('text9a72221a2747')}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {answeredCount} {tI18nComplete.raw('text68c780cd132a')}
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
            const answerText = answer.join(', ') || tI18nComplete.raw('text7e49c68db30e');
            return (
              <div key={q.question} className="space-y-0.5">
                <div className="[&_*]:!text-muted-foreground [&_strong]:!text-muted-foreground [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_p]:!text-pretty [&_ul]:!my-0">
                  <UnifiedMarkdown content={q.question} trust="agent" />
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

/** After this long on one status the working label shows elapsed time. */
const STATUS_STALL_AFTER_MS = 20_000;

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

/**
 * What a turn's error row shows. An abort renders nothing — but an abort is the
 * EFFECT of whatever stopped the turn. `turnEndNotice` (SDK) decides whether the
 * control plane has something to say about THIS turn and what kind; this only
 * puts words on it. No notice: the transcript's own error stands, abort or not.
 */
export function deriveTurnErrorPresentation(input: {
  turnError: string | undefined;
  isAbort: boolean;
  notice: TurnEndNotice | null;
}): { text: string | undefined; isAbort: boolean; suggestion: string | undefined } {
  const { turnError, isAbort, notice } = input;
  if (!notice) return { text: turnError, isAbort, suggestion: undefined };
  switch (notice.kind) {
    case 'sandbox-memory':
      return {
        isAbort: false,
        text: `This turn was stopped because the sandbox was almost out of memory${
          notice.usedPct === null ? '' : ` (${notice.usedPct}% used)`
        }.`,
        suggestion:
          'A running process or RAM-backed file may still be using memory. Stop or reduce heavy background work, ' +
          'then ask the agent to continue with a smaller workload.' +
          (notice.detail ? ` Details: ${notice.detail}.` : ''),
      };
    case 'cause':
      return { isAbort: false, text: notice.message, suggestion: undefined };
    case 'unexplained':
      return {
        isAbort: false,
        text: 'This turn stopped before it finished.',
        suggestion: 'No reason was reported. Send a message to continue from where it stopped.',
      };
  }
}

interface SessionTurnProps {
  turn: Turn;
  /** Who wrote this turn's user message, and whether the bubble names them. */
  author?: SessionMessageAuthor;
  showAuthor?: boolean;
  /** The models that answered this turn and what Kortix billed for it, from
   *  the gateway's request record. Keep its identity stable: the row is memoized. */
  servedModel?: TurnServedModel;
  /** What the control plane recorded about how THIS session's turns ended. */
  turnOutcome: SessionTurnOutcome;
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
   * The runtime is parked on an answer only the user can give — a pending
   * `question` request or a tool-permission prompt for this session. Resolved
   * once by the parent, beside the two lists it already passes down, because
   * the fallback waiting row has to make the same call.
   *
   * Distinct from `suppressBusyIndicator`, which is about WHERE the one row
   * belongs when a queue is waiting. This one is about whether any row belongs
   * on screen at all: see `showTurnBusyIndicator`.
   */
  awaitingUser: boolean;
  /**
   * A user message the agent has not reached yet — after the working turn,
   * with no assistant content. Drawn dimmed, like a queued prompt (it IS one:
   * the server forwarded it and OpenCode holds it until the next step), and
   * it fades up to full opacity the moment the agent takes it.
   */
  pending: boolean;
  pendingPrompt?: SessionPrompt;
  onRetryQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** The files this turn's Send carried, by identity — see `UserMessage`. */
  pendingAttachments?: ReadonlyArray<SentAttachment>;
  uploadStatus?: AttachmentUploadStatus;
  /** The prompt's text as the sender knew it — see `UserMessage`. */
  pendingText?: string;
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
  /** Commit the edit: rewind the session at `messageId`, send `text` and the `kept` attachments. */
  onEditSend?: (messageId: string, text: string, kept: NormalizedAttachment[]) => void;
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          {tI18nComplete.raw('texta67b04cd5c49')} {complete ? 'complete' : 'failed'}
        </span>
        {/* One meta line, truncated by CSS against the real available width —
            the old 60-character slice cut mid-word at every viewport and still
            overflowed narrow ones. */}
        {(report.project || report.prompt) && (
          <span className="text-muted-foreground block truncate text-xs">
            {report.project}
            {report.project && report.prompt && (
              <span className="text-muted-foreground/40">
                {' '}
                {tI18nComplete.raw('text3b9453dad42b')}{' '}
              </span>
            )}
            {report.prompt}
          </span>
        )}
      </span>

      <ExternalLink className="text-muted-foreground/40 group-hover/report:text-muted-foreground size-3.5 shrink-0 transition-colors" />
    </button>
  );
}

/**
 * The error a turn renders, which also hides its own Thinking row: the first
 * assistant message error, or a dismissed question tool error. `SessionChat`
 * reads the same answer to decide whether the fallback row must draw instead.
 */
export function resolveTurnError(turn: Turn): string | undefined {
  const msgError = getTurnError(turn);
  if (msgError) return msgError;
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      const tool = part as ToolPart;
      if (isQuestionTool(tool.tool) && tool.state.status === 'error' && 'error' in tool.state) {
        return (tool.state as { error: string }).error.replace(/^Error:\s*/, '');
      }
    }
  }
  return undefined;
}

// ============================================================================
// Turn model hooks — one hook per concern. These are the exact derivations
// SessionTurnImpl ran inline before the turn rendering moved into this file
// (KRTX-355); each is called unconditionally, in order, before any early
// return, so hook order stays stable across renders.
// ============================================================================

type TurnModelState = ReturnType<typeof useTurnModelState>;
type TurnQueueTone = ReturnType<typeof useTurnQueueTone>;
type TurnErrorState = ReturnType<typeof useTurnErrorState>;
type TurnAnsweredState = ReturnType<typeof useAnsweredQuestionState>;
type TurnUserContentState = ReturnType<typeof useTurnUserContent>;
type TurnStatusState = ReturnType<typeof useTurnLiveStatus>;
type TurnRetryState = ReturnType<typeof useTurnRetryState>;
type TurnSettledMeta = ReturnType<typeof useTurnSettledMeta>;
type TurnSegments = ReturnType<typeof useTurnSegments>;

/** Content derivations for one turn: the part lists, the streaming text and
 *  the response string every section below reads — plus the two working
 *  flags the sections branch on. */
function useTurnModelState({
  turn,
  isWorkingTurn,
  sessionWorking,
  awaitingUser,
}: Pick<SessionTurnProps, 'turn' | 'isWorkingTurn' | 'sessionWorking' | 'awaitingUser'>) {
const working = isWorkingTurn && sessionWorking;
/**
 * The same turn, minus the stretch where the next move is the READER's.
 *
 * `working` stays the honest answer about the turn — it is still open, the
 * server still holds its row, and every structural decision below (which
 * steps render, where answered questions go) reads it unchanged. This is the
 * narrower question the waiting row and its clock ask: is the AGENT working?
 * While a question or a permission prompt is parked on screen it is not, and
 * a shimmer with a ticking duration over an unanswered card is a progress
 * claim about the reader — see `showTurnBusyIndicator`.
 */
const agentWorking = working && !awaitingUser;
const allParts = useMemo(() => collectTurnParts(turn), [turn]);
// Check if there are visible steps that actually render inside the
// collapsible steps section. Tool parts that are rendered elsewhere
// (todowrite, task, question) don't count as "steps".
const hasSteps = useMemo(() => {
  return allParts.some(({ part }) => {
    if (isCompactionPart(part) || isSnapshotPart(part) || isPatchPart(part)) return true;
    if (isToolPart(part)) {
      // `isPlanWriteTool` — NOT a bare `=== 'todowrite'`. The runtime emits
      // both spellings, and the plan card owns both (see plan-anchor.ts).
      if (isPlanWriteTool(part.tool) || toolKind(part.tool) === 'task' || isQuestionTool(part.tool))
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
  return {
    working,
    agentWorking,
    allParts,
    hasSteps,
    hasReasoning,
    response,
  };
}

/** The queue tone of the turn's user bubble: interrupted, queued, held or
 *  sending — what the dimmed bubble and its status chip render. */
function useTurnQueueTone({
  pending,
  pendingPrompt,
  interruptedBeforeRun,
}: Pick<SessionTurnProps, 'pending' | 'pendingPrompt' | 'interruptedBeforeRun'>) {
// A Stop ended the turn before a step opened under this message, or the
// prompt still waits for delivery. Both keep the queue tone on the bubble;
// only a delivery failure adds text.
const queueState: QueuedPromptState | null = interruptedBeforeRun ? 'interrupted' : null;
const statusState: QueuedPromptState | null = queueState ?? (pending ? 'queued' : null);
const queuedStatus: QueuedPromptStatusState | null =
  pendingPrompt?.state === 'failed'
    ? 'failed'
    : !statusState
      ? null
      : pendingPrompt?.reason === 'held'
        ? 'held'
        : pendingPrompt &&
            (isOptimisticSessionPrompt(pendingPrompt) || pendingPrompt.state === 'delivering')
          ? 'sending'
          : statusState;
  return { queueState, statusState, queuedStatus };
}

/** Everything the turn's error row shows: the error text, whether it is an
 *  abort, the control-plane notice presentation, and the gateway details. */
function useTurnErrorState({ turn, turnOutcome }: Pick<SessionTurnProps, 'turn' | 'turnOutcome'>) {
const turnError = useMemo(() => resolveTurnError(turn), [turn]);

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
const turnErrorRow = useMemo(
  () =>
    deriveTurnErrorPresentation({
      turnError,
      isAbort: turnErrorIsAbort,
      notice: turnEndNotice(turnOutcome, turn.userMessage.info.id, {
        hasError: Boolean(turnError),
        isAbort: turnErrorIsAbort,
      }),
    }),
  [turnError, turnErrorIsAbort, turnOutcome, turn.userMessage.info.id],
);

// The gateway's structured fields (provider/suggestion/request_id) for
// `turnError`, when recoverable — lets TurnErrorDisplay render WHICH
// provider failed and WHAT to do about it instead of only the raw message.
const turnErrorDetails = useMemo(() => getTurnErrorDetails(turn), [turn]);
// The provider's own text behind the sentence, folded under it. Only for the
// transcript error itself: a named end cause replaced that text, so the raw
// text no longer describes what the row says.
const turnErrorRaw = useMemo(
  () => (turnErrorRow.text === turnError ? getTurnErrorRawText(turn) : undefined),
  [turn, turnError, turnErrorRow.text],
);
// A named end cause brings its own next step; the gateway's details describe
// the transcript error it replaced, so they do not apply to it.
const turnErrorRowDetails = useMemo(
  () => (turnErrorRow.suggestion ? { suggestion: turnErrorRow.suggestion } : turnErrorDetails),
  [turnErrorRow.suggestion, turnErrorDetails],
);
  return {
    turnError,
    turnErrorIsAbort,
    turnErrorRow,
    turnErrorDetails,
    turnErrorRaw,
    turnErrorRowDetails,
  };
}

/** A question tool part rebuilt as answered: `status: 'completed'` with the
 *  given answers merged into its metadata (and `input` when the caller has
 *  it). The server has not confirmed these answers yet — optimistic cache,
 *  parsed output, or a placeholder — so the card reads this copy, not the
 *  raw store part. */
function syntheticAnsweredPart(
  tool: ToolPart,
  answers: string[][],
  input?: Record<string, unknown>,
): ToolPart {
  return {
    ...tool,
    state: {
      ...(tool.state as any),
      status: 'completed',
      ...(input !== undefined ? { input } : {}),
      metadata: {
        ...((tool.state as any)?.metadata ?? {}),
        answers,
      },
    },
  } as unknown as ToolPart;
}

/** Which question tool parts of this turn count as answered, and with which
 *  answers. The body is the `answeredQuestionParts` memo SessionTurnImpl ran
 *  inline before the move, unchanged; it reads and cleans the optimistic
 *  answers cache, so it stays keyed on the same inputs. */
function collectAnsweredQuestions(
  assistantMessages: Turn['assistantMessages'],
  questions: QuestionRequest[],
  sessionId: string,
): { part: ToolPart; messageId: string }[] {
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
  for (let mi = 0; mi < assistantMessages.length; mi++) {
    const msg = assistantMessages[mi];
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (!isToolPart(part)) continue;
      const tool = part as ToolPart;
      if (!isQuestionTool(tool.tool)) continue;
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
      const msg = assistantMessages[msgIndex];
      for (let pi = partIndex + 1; pi < msg.parts.length; pi++) {
        const p = msg.parts[pi];
        if (isStepPart(p)) continue;
        return true;
      }
      // Check for later messages in the turn
      return msgIndex < assistantMessages.length - 1;
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
}

/** The turn's answered questions: which parts render as answered cards, the
 *  id → part map, and whether text and questions render inline in natural
 *  order instead of the settled response block. */
function useAnsweredQuestionState({
  turn,
  questions,
  sessionId,
  allParts,
  hasSteps,
}: {
  turn: Turn;
  questions: QuestionRequest[];
  sessionId: string;
  allParts: TurnModelState['allParts'];
  hasSteps: boolean;
}) {
  const answeredQuestionParts = useMemo(
    () => collectAnsweredQuestions(turn.assistantMessages, questions, sessionId),
    [turn.assistantMessages, questions, sessionId],
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
      isQuestionTool(part.tool) &&
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
  return { answeredQuestionParts, answeredQuestionPartsById, inlineContentParts, shouldUseInlineContent };
}

/** The user side of the turn: the worker-run report, the system pills, the
 *  bubble's visibility, and the command pill. */
function useTurnUserContent({
  turn,
  commandMessages,
  commands,
}: Pick<SessionTurnProps, 'turn' | 'commandMessages' | 'commands'>) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
// Extract kortix_system messages for inline rendering (goal continuations, etc.)
const systemMessages = useMemo<KortixSystemMessage[]>(() => {
  const msgs: KortixSystemMessage[] = [];
  for (const p of turn.userMessage.parts) {
    if (isTextPart(p) && (p as TextPart).text) {
      msgs.push(...extractKortixSystemMessages((p as TextPart).text!, tI18nComplete));
    }
  }
  return msgs;
}, [tI18nComplete, turn.userMessage.parts]);

const hasVisibleUserContent = useMemo(() => {
  // Session reports render as their own card — don't show as user bubble
  if (sessionReport) return false;
  // The prompt is not loaded (a long run's tail): its stand-in has no parts
  // and must not render as the empty bubble a loading prompt would.
  if (turn.partial) return false;
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
}, [turn.partial, turn.userMessage.parts, sessionReport]);

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
  return { sessionReport, systemMessages, hasVisibleUserContent, userMessageText, commandForTurn };
}

/** The throttled working status of the working turn: one status change per
 *  2.5 s, keyed on the turn's parts. */
function useThrottledTurnStatus({
  turn,
  allParts,
}: {
  turn: Turn;
  allParts: TurnModelState['allParts'];
}) {
// ---- Status throttling (2.5s) ----
const [statusThrottleStart] = useState(() => Date.now());
const lastStatusChangeRef = useRef(statusThrottleStart);
const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
// A turn the agent has not started has no status to report, and
// `getTurnStatus` says so with its fallback phrase — "Figuring out what's
// next…", which is a claim about a turn already under way. On a turn with no
// assistant message at all it is simply untrue, and the 2.5s throttle below
// then swaps the waiting row's honest "Thinking" for it while the prompt is
// still queued at the server (dev, 2026-09-06, on video).
//
// Gated at the SOURCE, not at the prop: the throttle ignores an empty status
// (`if (!newStatus) return`), so `throttledStatus` stays '' — the row keeps
// the default word AND grows no elapsed clock — until real content arrives,
// and the first real status then applies immediately.
const hasAssistantContent = turn.assistantMessages.length > 0;
const rawStatus = useMemo(
  () => (hasAssistantContent ? getTurnStatus(allParts, childMessages) : ''),
  [allParts, childMessages, hasAssistantContent],
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
  return throttledStatus;
}

/** How long the throttled status has held, as the busy row's elapsed label. */
function useTurnStatusElapsed({
  throttledStatus,
  agentWorking,
}: {
  throttledStatus: string;
  agentWorking: boolean;
}) {
// How long the status has read the same thing. Past STATUS_STALL_AFTER_MS
// the label carries the elapsed time, so a slow model step or a long tool
// call reads as "still working, this long" instead of a frozen screen.
// `agentWorking`, not `working`: the clock measures how long the AGENT has
// been on this step, so it stops (and clears) the moment the turn parks on a
// question and starts again from zero when the answer resumes it. Left on
// `working` it kept counting behind the hidden row and came back reading the
// time the reader took to reply.
const [statusElapsedState, setStatusElapsedState] = useState(() =>
  statusElapsedFrame(undefined, {
    status: throttledStatus,
    working: agentWorking,
    nowMs: Date.now(),
  }),
);
const statusElapsedMs =
  statusElapsedState.status === throttledStatus && statusElapsedState.working === agentWorking
    ? statusElapsedState.elapsedMs
    : 0;
useEffect(() => {
  const update = () =>
    setStatusElapsedState((previous) =>
      statusElapsedFrame(previous, {
        status: throttledStatus,
        working: agentWorking,
        nowMs: Date.now(),
      }),
    );
  update();
  if (!agentWorking) return;
  const timer = setInterval(update, 1000);
  return () => clearInterval(timer);
}, [agentWorking, throttledStatus]);
/** The phrase alone — never the elapsed time. Folding the ticking duration in
 *  here changed the busy indicator's animation key once a second, which
 *  replayed its roll-swap forever during any long tool call. */
const statusPhrase =
  throttledStatus && agentWorking && statusElapsedMs >= STATUS_STALL_AFTER_MS
    ? throttledStatus.replace(/(\.\.\.|…)$/, '')
    : throttledStatus;
const statusElapsedLabel =
  throttledStatus && agentWorking && statusElapsedMs >= STATUS_STALL_AFTER_MS
    ? formatDuration(statusElapsedMs)
    : undefined;
  return { statusPhrase, statusElapsedLabel };
}

/** The busy row's status line and elapsed clock, composed from the throttle
 *  and the clock. */
function useTurnLiveStatus({
  turn,
  allParts,
  agentWorking,
}: {
  turn: Turn;
  allParts: TurnModelState['allParts'];
  agentWorking: boolean;
}) {
  const throttledStatus = useThrottledTurnStatus({ turn, allParts });
  const { statusPhrase, statusElapsedLabel } = useTurnStatusElapsed({ throttledStatus, agentWorking });
  return { statusPhrase, statusElapsedLabel };
}

/** The working turn's retry presentation: the SDK retry info, its message,
 *  and the countdown the row renders. */
function useTurnRetryState({
  sessionStatus,
  isWorkingTurn,
}: Pick<SessionTurnProps, 'sessionStatus' | 'isWorkingTurn'>) {
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
  return { retryInfo, retryMessage, retrySecondsLeft };
}

/** The settled turn's meta row data: ended-at, duration and cost. */
function useTurnSettledMeta({
  working,
  turn,
  allParts,
  pricingLookup,
}: {
  working: boolean;
  turn: Turn;
  allParts: TurnModelState['allParts'];
  pricingLookup: ReturnType<typeof useModelPricingLookup>;
}) {
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
// Cost info (only when not working)
const costInfo = useMemo(
  () => (!working ? getTurnCost(allParts, pricingLookup) : undefined),
  [allParts, working, pricingLookup],
);
  return { turnEndedAt, turnDurationMs, costInfo };
}

/** The turn's parts, segmented into bursts / standalone tools / text for the
 *  steps section. */
function useTurnSegments({
  allParts,
  answeredQuestionPartsById,
  shouldUseInlineContent,
  permissions,
  sessionId,
}: {
  allParts: TurnModelState['allParts'];
  answeredQuestionPartsById: TurnAnsweredState['answeredQuestionPartsById'];
  shouldUseInlineContent: boolean;
  permissions: PermissionRequest[];
  sessionId: string;
}) {
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
    if (isToolPart(part) && isQuestionTool(part.tool)) {
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
  // Consecutive `show` calls render as one carousel card (`show-group`).
  return groupShowSegments(segmentTurn(parts, { standaloneCallIds }), { standaloneCallIds });
}, [allParts, answeredQuestionPartsById, shouldUseInlineContent, standaloneCallIds]);
  return segments;
}

// ============================================================================
// Turn render sections — the JSX blocks SessionTurnImpl inlined before the
// move (KRTX-355), each one section of the turn. Uncomposed, they render the
// same elements in the same order as before.
// ============================================================================

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

/** Shell mode — a live shell tool replaces the whole turn scaffold. */
function TurnShellMode(
  props: Pick<SessionTurnProps, 'sessionId' | 'disableToolNavigation' | 'onPermissionReply' | 'providers' | 'permissions'> & {
    part: ToolPart;
    working: boolean;
    errors: TurnErrorState;
    connectProviderOpen: boolean;
    onConnectProviderOpenChange: (open: boolean) => void;
  },
) {
  const {
    part, working, providers, errors, connectProviderOpen, onConnectProviderOpenChange,
    permissions, sessionId, disableToolNavigation, onPermissionReply,
  } = props;
  // Permission matching for this session (used for tool-level permission overlays)
  const nextPermission = useMemo(
    () => permissions.filter((p) => p.sessionID === sessionId)[0],
    [permissions, sessionId],
  );
  const { turnErrorRow, turnErrorRowDetails, turnErrorRaw } = errors;
  return (
    <TurnLiveContext.Provider value={working}>
      <div className="space-y-1">
        <ToolPartRenderer
          part={part}
          sessionId={sessionId}
          disableNavigation={disableToolNavigation}
          permission={nextPermission?.tool ? nextPermission : undefined}
          onPermissionReply={onPermissionReply}
          defaultOpen
        />
        {turnErrorRow.text && (
          <TurnErrorDisplay
            errorText={turnErrorRow.text}
            errorDetails={turnErrorRowDetails}
            errorRaw={turnErrorRaw}
            isAbort={turnErrorRow.isAbort}
            className="mt-2"
          />
        )}
        <ConnectProviderDialog
          open={connectProviderOpen}
          onOpenChange={onConnectProviderOpenChange}
          providers={providers}
        />
      </div>
    </TurnLiveContext.Provider>
  );
}

/** A compaction turn renders as its marker or failed row, never the normal
 *  scaffold. */
function TurnCompactionOutcome(
  props: Pick<SessionTurnProps, 'turn' | 'onOpenCompactionSummary'> & {
    compactionInfo: CompactionTurnInfo;
    working: boolean;
    response: string;
    turnError: string | undefined;
    turnErrorIsAbort: boolean;
  },
) {
  const { compactionInfo, working, response, onOpenCompactionSummary, turn, turnError, turnErrorIsAbort } = props;
// The landed summary opens in the panel's DETAIL view — the same surface a
// file opens into — instead of expanding inline in the transcript. The
// parent owns the panel handle (deliberately NOT `useOptionalSessionPanel`
// here: the panel context value carries files/apps/detail and churns with
// messages, so a per-turn context read would defeat this component's memo
// for the whole transcript). Absent prop → the marker's inline fallback.
const openCompactionSummary = useCallback(() => {
  onOpenCompactionSummary?.(turn.userMessage.info.id, response);
}, [onOpenCompactionSummary, turn.userMessage.info.id, response]);
  const compactionRunning = working || compactionInfo.inFlight;
  if (compactionRunning || response || compactionInfo.hasContent) {
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
  const compactionRawError = compactionInfo.error;
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

/** The worker-run report card and its modal — one section of the user block.
 *  Owns the modal state: it is the only consumer. */
function TurnSessionReport({ report }: { report: SessionReport }) {
  const [sessionReportModalOpen, setSessionReportModalOpen] = useState(false);
  return (
    <>
      <SessionReportCard
        report={report}
        onOpen={() => setSessionReportModalOpen(true)}
      />
      <SubSessionModal
        open={sessionReportModalOpen}
        onOpenChange={setSessionReportModalOpen}
        sessionId={report.sessionId}
        title={`Worker${report.project ? ` · ${report.project}` : ''}`}
      />
    </>
  );
}

/** The user side of a turn: the report card, the system-pill line, and the
 *  user bubble (hidden for notification-only turns). */
function TurnUserBlock(
  props: Pick<SessionTurnProps, 'turn' | 'author' | 'showAuthor' | 'pending' | 'interruptedBeforeRun' | 'pendingPrompt' | 'onRetryQueued' | 'onRemoveQueued' | 'pendingAttachments' | 'uploadStatus' | 'pendingText' | 'agentNames' | 'commandMessages' | 'commands' | 'sessionId' | 'ownsPlan' | 'onRewind' | 'rewindDisabled' | 'editingText' | 'editPending' | 'onEditCancel' | 'onEditSend'> & {
    model: TurnModelState;
    queueTone: TurnQueueTone;
    userContent: TurnUserContentState;
  },
) {
  const { userContent } = props;
  const { sessionReport, systemMessages, hasVisibleUserContent } = userContent;
  return (
    <>
      {sessionReport && <TurnSessionReport report={sessionReport} />}
      {/* ── System message indicator — shown for kortix_system-only messages ── */}
      {!hasVisibleUserContent && !sessionReport && systemMessages.length > 0 && (
        <SystemMessageIndicator messages={systemMessages} />
      )}
      {hasVisibleUserContent && <TurnUserBubble {...props} />}
    </>
  );
}

/** The user message bubble — dimmed while the prompt waits in the queue. */
function TurnUserBubble(
  props: Pick<SessionTurnProps, 'turn' | 'author' | 'showAuthor' | 'pending' | 'interruptedBeforeRun' | 'pendingPrompt' | 'onRetryQueued' | 'onRemoveQueued' | 'pendingAttachments' | 'uploadStatus' | 'pendingText' | 'agentNames' | 'commandMessages' | 'commands' | 'sessionId' | 'ownsPlan' | 'onRewind' | 'rewindDisabled' | 'editingText' | 'editPending' | 'onEditCancel' | 'onEditSend'> & {
    queueTone: TurnQueueTone;
    userContent: TurnUserContentState;
  },
) {
  const { hasVisibleUserContent } = props.userContent;
  const {
    turn, author, showAuthor, pending, pendingPrompt, interruptedBeforeRun,
    pendingAttachments, uploadStatus, pendingText, agentNames,
    commandMessages, commands, sessionId, ownsPlan, onRewind, rewindDisabled,
    editingText, editPending, onEditCancel, onEditSend,
    onRetryQueued, onRemoveQueued,
  } = props;
  const { queueState, queuedStatus } = props.queueTone;
  return (
    <>
    {/* ── User message ── */}
    {/* Hide the user bubble when the user message has no visible content
			    (e.g. background task notification with only synthetic parts). */}
    {hasVisibleUserContent && (
      <div
        data-turn-pending={pending || interruptedBeforeRun || undefined}
        data-turn-queue-state={pendingPrompt?.state ?? queueState ?? undefined}
        data-pending-prompt-id={pendingPrompt?.prompt_id}
        data-queue-tone={queuedBubbleTone(queuedStatus)}
        className={cn((pending || interruptedBeforeRun) && QUEUED_BUBBLE_OPACITY_CLASS)}
      >
        <UserMessage
          message={turn.userMessage}
          author={author}
          showAuthor={showAuthor}
          pendingAttachments={pendingAttachments}
          uploadStatus={uploadStatus}
          pendingText={pendingText}
          agentNames={agentNames}
          commandInfo={commandMessages?.get(turn.userMessage.info.id)}
          commands={commands}
          sessionId={sessionId}
          ownsPlan={ownsPlan}
          onRewind={onRewind}
          rewindDisabled={rewindDisabled || pending || interruptedBeforeRun}
          editingText={editingText}
          editPending={editPending}
          onEditCancel={onEditCancel}
          onEditSend={onEditSend}
          deliveryStatus={
            queuedStatus === 'failed' ? (
              <QueuedPromptFailure
                lastError={pendingPrompt?.last_error}
                onRetry={
                  pendingPrompt && onRetryQueued
                    ? () => onRetryQueued(pendingPrompt.prompt_id)
                    : undefined
                }
                onRemove={
                  pendingPrompt && onRemoveQueued
                    ? () => onRemoveQueued(pendingPrompt.prompt_id)
                    : undefined
                }
              />
            ) : queuedStatus === 'sending' || queuedStatus === 'queued' || queuedStatus === 'interrupted' ? (
              <QueuedPromptProgress state={queuedStatus} />
            ) : undefined
          }
        />
      </div>
    )}
    </>
  );
}

/** The assistant's part tree: bursts, standalone deliverables, and prose
 *  between them, under one live-context provider. */
function TurnToolBlocks(
  props: Pick<SessionTurnProps, 'turn' | 'sessionId' | 'permissions' | 'onPermissionReply' | 'disableToolNavigation'> & {
    model: TurnModelState;
    segments: TurnSegments;
    conversationDensity: ConversationDensity;
  },
) {
  const {
    turn, sessionId, permissions, onPermissionReply, disableToolNavigation,
    model, segments, conversationDensity,
  } = props;
  const { working, hasSteps, hasReasoning } = model;
  return (
    <>
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
            const key = turnSegmentKey(segment);
            if (key === null) return null;
            return (
              <TurnSegment
                key={key}
                segment={segment}
                isTrailing={index === segments.length - 1}
                working={working}
                hasSteps={hasSteps}
                sessionId={sessionId}
                permissions={permissions}
                onPermissionReply={onPermissionReply}
                disableNavigation={disableToolNavigation}
                conversationDensity={conversationDensity}
              />
            );
          })}
        </div>
      </TurnLiveContext.Provider>
    )}
    </>
  );
}

/** One segmented part of the turn's steps section: a burst, a show group,
 *  a standalone deliverable, or prose between bursts. Keyed by the same ids
 *  the inline map used before the move (`turnSegmentKey`). */
function turnSegmentKey(segment: TurnSegments[number]): string | null {
  if (segment.kind === 'burst') return `burst-${segment.parts[0]?.id ?? 'empty'}`;
  if (segment.kind === 'standalone') {
    return shouldShowToolPart(segment.part) ? segment.part.id : null;
  }
  if (segment.kind === 'show-group') {
    const visible = segment.parts.filter(shouldShowToolPart);
    return visible.length > 0 ? visible[0].id : null;
  }
  return segment.part.id;
}

function TurnSegment({
  segment,
  isTrailing,
  working,
  hasSteps,
  sessionId,
  permissions,
  onPermissionReply,
  disableNavigation,
  conversationDensity,
}: {
  segment: TurnSegments[number];
  isTrailing: boolean;
  working: boolean;
  hasSteps: boolean;
  sessionId: string;
  permissions: PermissionRequest[];
  onPermissionReply: SessionTurnProps['onPermissionReply'];
  disableNavigation: boolean | undefined;
  conversationDensity: ConversationDensity;
}) {
  if (segment.kind === 'burst') {
    return (
      <ActivityBurst
        parts={segment.parts}
        sessionId={sessionId}
        working={working}
        isTrailing={isTrailing}
        disableNavigation={disableNavigation}
        density={conversationDensity}
      />
    );
  }
  if (segment.kind === 'show-group') {
    const visible = segment.parts.filter(shouldShowToolPart);
    if (visible.length === 1) {
      return (
        <ToolPartRenderer part={visible[0]} sessionId={sessionId} disableNavigation={disableNavigation} />
      );
    }
    return <ShowGroupRenderer parts={visible} sessionId={sessionId} disableNavigation={disableNavigation} />;
  }
  if (segment.kind === 'standalone') {
    if (!shouldShowToolPart(segment.part)) return null;
    return (
      <ToolPartRenderer
        part={segment.part}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
        permission={getPermissionForTool(permissions, segment.part.callID)}
        onPermissionReply={onPermissionReply}
      />
    );
  }
  if (!hasSteps) return null;
  const text = segment.part.text?.trim();
  if (!text) return null;
  return (
    <div className="min-w-0 text-sm">
      <ThrottledMarkdown content={text} isStreaming={working} />
    </div>
  );
}

/** What the turn says: the completion announce, the streaming text, and
 *  either the inline text-and-questions flow or the settled response. */
function TurnAssistantBlock(
  props: Pick<SessionTurnProps, 'turn'> & {
    model: TurnModelState;
    answered: TurnAnsweredState;
    userContent: TurnUserContentState;
    tHardcodedUi: ReturnType<typeof useTranslations>;
  },
) {
  const { model, answered, userContent, tHardcodedUi } = props;
  const { working, hasSteps, hasReasoning, response } = model;
  const { shouldUseInlineContent, inlineContentParts } = answered;
  return (
    <>
    {/* ── Screen reader ──
        Announce COMPLETION only. Mirroring the full response here duplicated
        every turn in the DOM, so select-all across the transcript copied each
        answer twice. The visible markdown is already in the a11y tree. */}
    <div className="sr-only" aria-live="polite">
      {!working && response ? tHardcodedUi.raw('i18nComplete.text7889d06f7235') : ''}
    </div>
    {/* Inline content: text and answered questions rendered in natural order.
			    Works both during streaming and after completion. */}
    {working && !hasSteps && !shouldUseInlineContent && response && (
      <div className="min-w-0 text-sm">
        <ThrottledMarkdown content={response} isStreaming />
      </div>
    )}
      {shouldUseInlineContent ? (
        <TurnInlineContent working={working} parts={inlineContentParts!} />
      ) : (
        <TurnSettledResponse
          working={working}
          hasSteps={hasSteps}
          hasReasoning={hasReasoning}
          response={response}
          commandForTurn={userContent.commandForTurn}
          answeredQuestionParts={answered.answeredQuestionParts}
        />
      )}
    </>
  );
}

/** Inline content: text and answered questions in natural order, while the
 *  turn streams around them. */
function TurnInlineContent({
  working,
  parts,
}: {
  working: boolean;
  parts: NonNullable<TurnAnsweredState['inlineContentParts']>;
}) {
  return (
      <div className="space-y-3">
        {(() => {
          // Find the last text item index — it might still be streaming
          let lastTextIdx = -1;
          if (working) {
            for (let i = parts.length - 1; i >= 0; i--) {
              if (parts[i].type === 'text') {
                lastTextIdx = i;
                break;
              }
            }
          }
          return parts.map((item, idx) => {
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
  );
}

/** The settled response: the text (or command pill) plus the answered
 *  question cards that no upstream renderer has already shown. */
function TurnSettledResponse({
  working,
  hasSteps,
  hasReasoning,
  response,
  commandForTurn,
  answeredQuestionParts,
}: {
  working: boolean;
  hasSteps: boolean;
  hasReasoning: boolean;
  response: string;
  commandForTurn: TurnUserContentState['commandForTurn'];
  answeredQuestionParts: TurnAnsweredState['answeredQuestionParts'];
}) {
  return (
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
                    className="bg-popover text-foreground min-w-0 truncate rounded-sm border px-1.5 py-0.5 align-baseline font-mono text-xs font-medium wrap-anywhere whitespace-nowrap"
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
  );
}

/** The turn's footer: the working row, the error banner, the outcomes, the
 *  action bar, and the connect-provider dialog. */
function TurnFooter(
  props: Pick<SessionTurnProps, 'turn' | 'sessionId' | 'suppressBusyIndicator' | 'awaitingUser' | 'providers' | 'servedModel'> & {
    model: TurnModelState;
    errors: TurnErrorState;
    answered: TurnAnsweredState;
    status: TurnStatusState;
    retry: TurnRetryState;
    meta: TurnSettledMeta;
    tHardcodedUi: ReturnType<typeof useTranslations>;
    connectProviderOpen: boolean;
    onConnectProviderOpenChange: (open: boolean) => void;
  },
) {
  const {
    turn, providers, model, errors, answered, status, retry, meta, tHardcodedUi,
    connectProviderOpen, onConnectProviderOpenChange, servedModel,
  } = props;
  const { working, response } = model;
  const { turnError, turnErrorRow, turnErrorRowDetails, turnErrorRaw } = errors;
  const { statusPhrase, statusElapsedLabel } = status;
  const { retryInfo, retryMessage, retrySecondsLeft } = retry;
  const { turnEndedAt, turnDurationMs, costInfo } = meta;
  return (
    <>
      <TurnBusyRow
        {...props}
        working={working}
        turnError={turnError}
        tHardcodedUi={tHardcodedUi}
      />
    {/* ── Error (abort / failure banner) ── */}
    {turnErrorRow.text && (
      <TurnErrorDisplay
        errorText={turnErrorRow.text}
        errorDetails={turnErrorRowDetails}
        errorRaw={turnErrorRaw}
        isAbort={turnErrorRow.isAbort}
      />
    )}
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
        <TurnActionBar
          response={response}
          inlineContentParts={answered.inlineContentParts}
          turnEndedAt={turnEndedAt}
          turnDurationMs={turnDurationMs}
          costInfo={costInfo}
          servedModel={servedModel}
          tHardcodedUi={tHardcodedUi}
        />
      )}
    <ConnectProviderDialog
      open={connectProviderOpen}
      onOpenChange={onConnectProviderOpenChange}
      providers={providers}
    />
    </>
  );
}

/** The working turn's waiting row: the retry banner and the busy indicator. */
function TurnBusyRow(
  props: Pick<SessionTurnProps, 'sessionId' | 'suppressBusyIndicator' | 'awaitingUser'> & {
    working: boolean;
    turnError: string | undefined;
    retry: TurnRetryState;
    status: TurnStatusState;
    tHardcodedUi: ReturnType<typeof useTranslations>;
  },
) {
  const { working, turnError, suppressBusyIndicator, awaitingUser, sessionId, retry, status, tHardcodedUi } = props;
  const { retryInfo, retryMessage, retrySecondsLeft } = retry;
  const { statusPhrase, statusElapsedLabel } = status;
  return (
    <>
    {showTurnBusyIndicator({
      working: working && !suppressBusyIndicator,
      hasError: !!turnError,
      isRetrying: !!retryInfo,
      awaitingUser,
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
    </>
  );
}

/** Copy + the turn's settled meta row — the hover-revealed bar at the end of
 *  a settled turn. Owns the copy state: it is the only consumer. */
function TurnActionBar({
  response,
  inlineContentParts,
  turnEndedAt,
  turnDurationMs,
  costInfo,
  servedModel,
  tHardcodedUi,
}: {
  response: string;
  inlineContentParts: TurnAnsweredState['inlineContentParts'];
  turnEndedAt: TurnSettledMeta['turnEndedAt'];
  turnDurationMs: TurnSettledMeta['turnDurationMs'];
  costInfo: TurnSettledMeta['costInfo'];
  servedModel?: TurnServedModel;
  tHardcodedUi: ReturnType<typeof useTranslations>;
}) {
  const [copied, setCopied] = useState(false);
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
  return (
    <div className="duration-normal flex items-center gap-0.5 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
      {response ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : tHardcodedUi.raw('i18nComplete.textf0f755afea88')}
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
                    <CheckIcon className="text-muted-foreground size-[1.05rem]" />
                  ) : (
                    <Copy className="text-muted-foreground size-[1.05rem]" />
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
          served={servedModel}
          className="flex items-center justify-center"
        />
    </div>
  );
}

function SessionTurnImpl(props: SessionTurnProps) {
  const {
    turn, turnOutcome, sessionId, sessionStatus, permissions, questions,
    sessionWorking, isWorkingTurn, awaitingUser,
    pending, pendingPrompt, interruptedBeforeRun, isCompaction,
    providers, commandMessages, commands,
  } = props;
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );

  const model = useTurnModelState({ turn, isWorkingTurn, sessionWorking, awaitingUser });
  const queueTone = useTurnQueueTone({ pending, pendingPrompt, interruptedBeforeRun });
  const errors = useTurnErrorState({ turn, turnOutcome });
  const answered = useAnsweredQuestionState({ turn, questions, sessionId, allParts: model.allParts, hasSteps: model.hasSteps });
  const userContent = useTurnUserContent({ turn, commandMessages, commands });
  const status = useTurnLiveStatus({ turn, allParts: model.allParts, agentWorking: model.agentWorking });
  const retry = useTurnRetryState({ sessionStatus, isWorkingTurn });
  const meta = useTurnSettledMeta({ working: model.working, turn, allParts: model.allParts, pricingLookup });
  const segments = useTurnSegments({
    allParts: model.allParts,
    answeredQuestionPartsById: answered.answeredQuestionPartsById,
    shouldUseInlineContent: answered.shouldUseInlineContent,
    permissions,
    sessionId,
  });
  // Shell mode detection
  const shellModePart = useMemo(() => getShellModePart(turn), [turn]);
  // A compaction turn's message-state — `inFlight` (summary open: not
  // completed, not errored) is the half of "is this compaction running" the
  // working projection cannot see, because it deliberately knows nothing
  // about compaction.
  const compactionInfo = useMemo(
    () => (isCompaction ? compactionTurnInfo(turn) : null),
    [isCompaction, turn],
  );

  if (shellModePart) {
    return (
      <TurnShellMode
        {...props}
        part={shellModePart}
        working={model.working}
        errors={errors}
        connectProviderOpen={connectProviderOpen}
        onConnectProviderOpenChange={setConnectProviderOpen}
      />
    );
  }
  if (isCompaction && compactionInfo) {
    return (
      <TurnCompactionOutcome
        {...props}
        compactionInfo={compactionInfo}
        working={model.working}
        response={model.response}
        turnError={errors.turnError}
        turnErrorIsAbort={errors.turnErrorIsAbort}
      />
    );
  }
  return (
    <div className="group/turn text-factor-[2] space-y-2.5">
      <TurnUserBlock {...props} model={model} queueTone={queueTone} userContent={userContent} />
      <TurnToolBlocks {...props} model={model} segments={segments} conversationDensity={conversationDensity} />
      <TurnAssistantBlock {...props} model={model} answered={answered} userContent={userContent} tHardcodedUi={tHardcodedUi} />
      <TurnFooter {...props} model={model} errors={errors} answered={answered} status={status} retry={retry} meta={meta} tHardcodedUi={tHardcodedUi} connectProviderOpen={connectProviderOpen} onConnectProviderOpenChange={setConnectProviderOpen} />
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
export const SessionTurn = memo(SessionTurnImpl);
SessionTurn.displayName = 'SessionTurn';

interface TranscriptTurnRowProps extends SessionTurnProps {
  turnId: string;
  viewportClassName: string;
  /** A failed compaction attempt a later one supersedes: the viewport stays, empty. */
  suppressed: boolean;
  /** The fallback waiting row belongs under this turn. */
  showBusyRow: boolean;
}

/**
 * One transcript row: the turn's `TurnViewport`, its `SessionTurn`, and the
 * fallback waiting row. Memoized at the ROW, not only at `SessionTurn`: the
 * viewport re-rendered for every turn on every streamed delta (its children
 * element is new each time, and its class list goes through tailwind-merge),
 * which made a long transcript cost O(turns) per delta even though every
 * settled `SessionTurn` bailed out. Every prop here is a primitive or a
 * reference that holds while another turn streams.
 */
export const TranscriptTurnRow = memo(function TranscriptTurnRow({
  turnId,
  viewportClassName,
  suppressed,
  showBusyRow,
  ...turnProps
}: TranscriptTurnRowProps) {
  return (
    <TurnViewport turnId={turnId} className={viewportClassName}>
      {/* No separate divider for compaction turns — the
      CompactionMarker rendered by SessionTurn IS the
      divider (rule–pill–rule), through every phase. */}
      {suppressed ? null : <SessionTurn {...turnProps} />}
      {/* Queued bubbles follow this turn. The waiting
          row stays above them, where the working turn
          draws its own, so it never jumps. */}
      {showBusyRow && <SessionBusyIndicator sessionId={turnProps.sessionId} className="mt-2.5" />}
    </TurnViewport>
  );
});
TranscriptTurnRow.displayName = 'TranscriptTurnRow';

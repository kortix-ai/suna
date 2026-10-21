'use client';

// ============================================================================
// Session transcript turn rendering (moved verbatim from session-chat.tsx —
// KRTX-355, phase 2 of code-spec:split-session-chat-ts).
// `SessionTurn` renders one turn, `TranscriptTurnRow` wraps it in its
// `TurnViewport`, and the message-indicator components render inline pills,
// answered-question cards and notification turns. `session-chat.tsx`
// re-exports the public names.
// ============================================================================


import { isQuestionTool } from '@kortix/sdk';

import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { detectCommandFromText } from './detect-command';
import { GenuiTelemetryContext } from '../../markdown/genui/block-telemetry';
import { copyGenuiText } from '../../markdown/genui/to-markdown';
import { useLocale, useTranslations } from '../../i18n';
import {
  type SessionLogBlock,
  type SessionLogCompaction,
  type SessionLogMessage,
  type SessionLogSegment,
  type SessionLogTurn,
  type SessionMessageAuthor,
  type SessionPrompt,
  type SessionPromptViewer,
  type TextBlock,
  type ToolCallBlock,
  isSessionLogRestoreNote,
  type SessionLogReferencedText,
  sessionLogActivityText,
  sessionLogAnsweredQuestionCall,
  sessionLogBurstSteps,
  sessionLogOpenCall,
  sessionLogTurnSegments,
  sessionPromptActions,
  splitSessionLogTurnWork,
  toolCallMetadata,
  toolKind,
} from '@kortix/sdk';
import {
  WarningIcon as AlertTriangle,
  CheckCircleIcon as CheckCircle,
  CheckIcon,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  RobotIcon,
  StopCircleIcon,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AfterFirstPromptContext } from './after-first-prompt';
import { TranscriptRowsContext } from './transcript-rows';
import { MessageRow } from '../turn/message-row';
import { agentDisplayLabel } from '../composer/agent-selector';
import { participantLabel } from '../participants/session-participants';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { UserAvatar } from '../../primitives/user-avatar';
import {
  SystemNotificationCard,
  parseSystemNotifications,
  stripSystemPtyText,
} from './message-parsing';
import { ActivityBurst } from '../turn/activity-burst';
import { TurnWorkAccordion } from '../turn/turn-work-accordion';
import { CompactionFailedRow, CompactionMarker } from '../turn/compaction-card';
import { ExpandableOutput } from '../turn/expandable-output';
import { isPlanWriteTool } from '../turn/plan-anchor';
import { TurnFallbackRows } from '../turn/fallback-row';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  queuedBubbleTone,
  type QueuedPromptState,
  QueuedPromptFailure,
  QueuedPromptProgress,
  type QueuedPromptStatusState,
} from '../turn/queued-prompt-bubbles';
import { ShowGroupRenderer } from '../tool/show-group-renderer';
import { statusElapsedFrame } from '../turn/status-elapsed';
import { ThrottledMarkdown } from '../turn/throttled-markdown';
import { TurnViewport } from '../turn/turn-viewport';
import { UserMessage } from '../turn/user-message';
import { useOptionalSessionPanel } from '../panel/session-panel-provider';
import { Composer as SessionChatInput } from '../composer/composer';
import { ConnectProviderDialog } from '../models/model-selector';
import { TurnOutcomes } from '../outcomes/turn-outcomes';
import { SessionRetryDisplay, TurnErrorDisplay } from '../status/session-error-banner';
import { showTurnBusyIndicator } from '@kortix/sdk';
import type {
  AttachmentUploadStatus,
  NormalizedAttachment,
} from '../turn/user-message';
import type { TurnServedModel } from '../turn/served-model';
import { SessionBusyIndicator } from '../status/session-busy-indicator';
import { SessionTurnMeta } from './session-turn-meta';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnSpan,
} from './session-turn-meta-rows';

import { Button } from '../../primitives/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { useUserPreferencesStore, type ConversationDensity } from '../../internal/stores/user-preferences-store';
import { SubSessionModal } from './sub-session-modal';
import { ToolPartRenderer, TurnLiveContext } from '../tool/tool-renderers';
import { type SentAttachment } from '../composer/sent-attachment-previews';
import { cn } from '../../lib/utils';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '../../internal/lib/utils/kortix-system-tags';
// Shared UI primitives (framework-agnostic, reusable on mobile)
import { Copy } from '../../icons/copy';
import {
  type Command,
  type PermissionRequest,
  type QuestionRequest,
  extractGatewayErrorDetails,
  formatDuration,
  getPermissionForTool,
  getRetryInfo,
  getRetryMessage,
  shouldShowToolPart,
} from '../../internal/session-types';
import {
  isAbortError,
  turnEndNotice,
  type SessionTurnOutcome,
  type TurnEndNotice,
} from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { isOptimisticSessionPrompt, useSessionWorking } from '@kortix/sdk/react';
import { CodeBlockEndpoints, SandboxUrlDetector } from '../media/sandbox-url-detector';
import { resolveLastTurnWorking } from '../composer/session-composer-readiness';
import { HarnessSwitchMarker, RestoreNoteMarker, TurnFullText, type FullTextState } from './session-history';

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
      <span className="text-muted-foreground text-xs whitespace-nowrap select-none">{text}</span>
      <div className="bg-border/30 h-px flex-1" />
    </div>
  );
}

// ============================================================================
// Answered question card — collapsible summary of completed Q&A
// ============================================================================

function AnsweredQuestionCard({ call }: { call: ToolCallBlock }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [expanded, setExpanded] = useState(false);
  const input = (call.input ?? {}) as { questions?: unknown };
  const metadata = toolCallMetadata(call) as { answers?: unknown };
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
// Session Turn — core turn component
// ============================================================================

/**
 * Pure derivation of "was this turn's error an abort" from a turn's replies —
 * the exact logic `turnErrorIsAbort` below runs per render. Extracted (T17) so
 * it can be exercised by real behavior tests (`interrupted-label.test.ts`)
 * instead of a source-text pattern match.
 *
 * Reads the FIRST errored reply (matching the turn error's own "first wins"
 * rule; a compaction's marker first, which carries its summary's error) and
 * classifies THAT message once: `status: 'aborted'` (a wire
 * `MessageAbortedError`), else the SDK's single `isAbortError` classifier on
 * the error's code and text (the client's synthesized `AbortError` on Stop).
 *
 * The abort's `AbortReason` is deliberately NOT read: every abort — a user
 * Stop, an untagged wire `MessageAbortedError`, a `'runtime-disposed'`
 * respawn — renders nothing, so the reason changes no outcome.
 */
export function deriveTurnErrorAbortState(
  turn: Pick<SessionLogTurn, 'user' | 'assistant'>,
): { isAbort: boolean } {
  const sources = turn.user.kind === 'compaction' ? [turn.user, ...turn.assistant] : turn.assistant;
  const msg = sources.find((m) => m.error);
  return { isAbort: !!msg && messageAborted(msg) };
}

/** A message an abort ended: `status: 'aborted'` (a wire `MessageAbortedError`),
 *  else its error read by the SDK's `isAbortError` (the client's `AbortError`). */
export function messageAborted(message: SessionLogMessage): boolean {
  if (message.status === 'aborted') return true;
  return !!message.error && isAbortError({ name: message.error.code, data: { message: message.error.message } });
}

/**
 * The prompts a Stop stranded: the newest turn that got a reply ended by abort, and these
 * prompts came after it with no reply. The runtime holds them; nothing runs them until the
 * next send. A reply counts when `messages` (the whole thread) holds it, so a turn whose only
 * reply the transcript hides (a failed attempt out of context) ran, and is not stranded.
 */
export function strandedPromptIds(turns: readonly SessionLogTurn[], messages: readonly SessionLogMessage[] | undefined): Set<string> {
  const answered = new Set<string>();
  for (const m of messages ?? []) if (m.role === 'assistant' && m.reply_to) answered.add(m.reply_to);
  const newest = turns.findLastIndex((t) => t.assistant.length > 0 || answered.has(t.id));
  if (newest < 0 || newest === turns.length - 1) return new Set();
  const last = turns[newest].assistant.at(-1);
  if (!last || !messageAborted(last)) return new Set();
  return new Set(turns.slice(newest + 1).map((t) => t.id));
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
    case 'cause': {
      // The ledger keeps the provider body as recorded (`400: {"message": …}`): show the
      // gateway's sentence and next step, as a transcript error does.
      const gateway = extractGatewayErrorDetails(notice.message);
      return { isAbort: false, text: gateway?.message || notice.message, suggestion: gateway?.message ? gateway.suggestion : undefined };
    }
    case 'unexplained':
      return {
        isAbort: false,
        text: 'This turn stopped before it finished.',
        suggestion: 'No reason was reported. Send a message to continue from where it stopped.',
      };
  }
}

interface SessionTurnProps {
  /** The turn (`sessionLogTurns`): it keeps its identity while its messages do. */
  turn: SessionLogTurn;
  /** Who wrote this turn's user message, and whether the bubble names them. */
  author?: SessionMessageAuthor;
  showAuthor?: boolean;
  /** The member who stopped this turn, when it was not the viewer
   *  (`stoppedByName`). Null or absent: nothing to say. */
  stoppedBy?: string | null;
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
  sessionStatus: import('../../internal/session-types').SessionStatus | undefined;
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
  /** Who is looking. A prompt runs as its author, so Retry is the author's
   *  and Remove the author's or a session manager's (`sessionPromptActions`).
   *  Omitted: the viewer's own. Keep it referentially stable (memo). */
  queuedPromptViewer?: SessionPromptViewer;
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
  /** Open a sent paste's full text in the panel's detail view, provided like
   *  `onOpenCompactionSummary`. Absent → the paste tile is inert. */
  onOpenPastedContent?: (id: string, text: string) => void;
  /** Providers data for the Connect Provider dialog */
  providers?: ProviderListResponse;
  /** How many models the account can pick (`local.model.list`, enablement
   *  applied) — lets a provider-failure row drop its "choose another model"
   *  hint when no other model exists (KRTX-2598). */
  modelOptions?: number;
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
              <span className="text-muted-foreground">
                {' '}
                {tI18nComplete.raw('text3b9453dad42b')}{' '}
              </span>
            )}
            {report.prompt}
          </span>
        )}
      </span>

      <ExternalLink className="text-muted-foreground group-hover/report:text-foreground size-3.5 shrink-0 transition-colors" />
    </button>
  );
}

/**
 * The error a turn renders, which also hides its own Thinking row: the first
 * reply error, or a dismissed question tool error. `SessionChat` reads the
 * same answer to decide whether the fallback row must draw instead. A
 * question the closure rule closed is open (`sessionLogOpenCall`), not
 * dismissed.
 */
export function resolveTurnError(turn: SessionLogTurn): string | undefined {
  if (turn.error) return turn.error.message;
  for (const block of turn.blocks) {
    if (block.type !== 'tool_call') continue;
    const call = sessionLogOpenCall(block);
    if (isQuestionTool(call.name) && call.status === 'error' && call.result) {
      const text = call.result.error?.message ?? resultText(call);
      return text.replace(/^Error:\s*/, '');
    }
  }
  return undefined;
}

/** The text a call's result carries (a v1 part's `output` or `error`). */
function resultText(call: ToolCallBlock): string {
  return (call.result?.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
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
// Every reply block, with a call the closure rule closed read open
// (`sessionLogOpenCall`): the v1 live view and the v2 page at rest hand the
// sections below one shape, and `TurnLiveContext` says whether it is live.
const blocks = useMemo(() => turnBlocks(turn), [turn]);
// Check if there are visible steps that actually render inside the
// collapsible steps section. Tool calls that are rendered elsewhere
// (todowrite, task, question) don't count as "steps".
const hasSteps = useMemo(() => blocks.some(isStepBlock), [blocks]);
const hasReasoning = useMemo(
  () => blocks.some((b) => b.type === 'reasoning' && !!b.text.trim()),
  [blocks],
);
// The reply still being written: the last one without a completion stamp,
// else the last.
const activeAssistantMessage = useMemo(() => {
  if (turn.assistant.length === 0) return undefined;
  for (let i = turn.assistant.length - 1; i >= 0; i--) {
    if (turn.assistant[i].completed_at === null) return turn.assistant[i];
  }
  return turn.assistant[turn.assistant.length - 1];
}, [turn.assistant]);
const openText = useMemo(() => openTextBlock(working, activeAssistantMessage), [working, activeAssistantMessage]);
const streamingResponseRaw = useMemo(() => {
  if (!activeAssistantMessage) return '';
  let text = '';
  for (const b of activeAssistantMessage.blocks) {
    if (b.type === 'text') text += b.text;
  }
  return text;
}, [activeAssistantMessage]);
const responseRaw = turn.response?.text ?? '';
// Fallback: when aborted, collect ALL non-empty text blocks if the
// primary response is empty.  The last text block may have been lost
// (timing between text-start and first text-delta) but earlier blocks
// might still have content.
const abortedTextFallback = useMemo(() => {
  if (responseRaw) return ''; // primary response exists — no fallback needed
  // Only activate for aborted/errored turns
  const hasError = turn.assistant.some((m) => m.error);
  if (!hasError) return '';
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text.trim()) texts.push(b.text);
  }
  return texts.join('\n\n').trim();
}, [responseRaw, blocks, turn.assistant]);
const completedTextParts = useMemo(
  () =>
    blocks
      .map((b) => (b.type === 'text' ? b.text.trim() : ''))
      .filter((text): text is string => Boolean(text)),
  [blocks],
);
const response = working
  ? streamingResponseRaw || responseRaw
  : !hasSteps && completedTextParts.length > 0
    ? completedTextParts.join('\n\n')
    : responseRaw.trim() || abortedTextFallback;
  return {
    working,
    agentWorking,
    openText,
    blocks,
    hasSteps,
    hasReasoning,
    response,
  };
}

/**
 * The one text block still being written: the last block of a reply with no
 * completion stamp. Only it streams (KRTX-2932). An earlier block ended when
 * the next block began, and a completed reply ended with it, even while the
 * turn still works. Exported for its test.
 */
export function openTextBlock(
  working: boolean,
  message: SessionLogTurn['assistant'][number] | undefined,
): { block: TextBlock; messageId: string } | null {
  if (!working || !message || message.completed_at !== null) return null;
  const last = message.blocks[message.blocks.length - 1];
  return last?.type === 'text' ? { block: last, messageId: message.message_id } : null;
}

/** The turn's reply blocks, each call in its open shape (`sessionLogOpenCall`). One array per turn object. */
const openBlocks = new WeakMap<SessionLogTurn, SessionLogBlock[]>();
function turnBlocks(turn: SessionLogTurn): SessionLogBlock[] {
  let list = openBlocks.get(turn);
  if (!list) {
    list = turn.blocks.map((b) => (b.type === 'tool_call' ? sessionLogOpenCall(b) : b));
    openBlocks.set(turn, list);
  }
  return list;
}

/** A block that renders inside the steps section: a snapshot, a patch or a
 *  compaction, or a visible call other than the plan write, a sub-agent and a
 *  question (each rendered elsewhere). */
function isStepBlock(block: SessionLogBlock): boolean {
  if (block.type === 'compaction') return true;
  if (block.type === 'harness') return block.kind === 'compaction' || block.kind === 'snapshot' || block.kind === 'patch';
  if (block.type !== 'tool_call') return false;
  // `isPlanWriteTool` — NOT a bare `=== 'todowrite'`. The runtime emits
  // both spellings, and the plan card owns both (see plan-anchor.ts).
  if (isPlanWriteTool(block.name) || toolKind(block.name) === 'task' || isQuestionTool(block.name)) return false;
  return shouldShowToolPart(block);
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
      notice: turnEndNotice(turnOutcome, turn.id, {
        hasError: Boolean(turnError),
        isAbort: turnErrorIsAbort,
      }),
    }),
  [turnError, turnErrorIsAbort, turnOutcome, turn.id],
);

// The gateway's structured fields (provider/suggestion/request_id) for
// `turnError`, when recoverable — lets TurnErrorDisplay render WHICH
// provider failed and WHAT to do about it instead of only the raw message.
const turnErrorDetails = turn.error?.details;
// The provider's own text behind the sentence, folded under it. Only for the
// transcript error itself: a named end cause replaced that text, so the raw
// text no longer describes what the row says.
const turnErrorRaw = turnErrorRow.text === turnError ? turn.error?.raw : undefined;
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

/** Which question calls of this turn count as answered, and with which
 *  answers. It reads and cleans the optimistic answers cache, so it stays
 *  keyed on the same inputs. A call answered without server-confirmed
 *  answers (optimistic cache, parsed output, or a placeholder) is rebuilt by
 *  `sessionLogAnsweredQuestionCall`, so the card reads that copy, not the
 *  raw store call. Calls are read in their open shape (`sessionLogOpenCall`). */
function collectAnsweredQuestions(
  replies: readonly SessionLogMessage[],
  questions: QuestionRequest[],
  sessionId: string,
): { call: ToolCallBlock; messageId: string }[] {
  const pendingCallIds = new Set(
    questions.flatMap((q) =>
      q.sessionID === sessionId && q.tool?.callID ? [q.tool.callID] : [],
    ),
  );

  // Collect ALL question calls first so we can determine which ones
  // were implicitly answered (i.e. the assistant continued past them).
  const questionInfos: {
    call: ToolCallBlock;
    msgId: string;
    msgIndex: number;
    blockIndex: number;
  }[] = [];
  for (let mi = 0; mi < replies.length; mi++) {
    const msg = replies[mi];
    for (let bi = 0; bi < msg.blocks.length; bi++) {
      const block = msg.blocks[bi];
      if (block.type !== 'tool_call' || !isQuestionTool(block.name)) continue;
      questionInfos.push({ call: sessionLogOpenCall(block), msgId: msg.message_id, msgIndex: mi, blockIndex: bi });
    }
  }

  const result: { call: ToolCallBlock; messageId: string }[] = [];
  for (const { call, msgId, msgIndex, blockIndex } of questionInfos) {
    // Check if there are subsequent blocks/messages AFTER this question
    // in the turn. If the assistant continued, this question was answered.
    const hasSubsequentContent = (() => {
      // Check for later blocks in the same message
      const msg = replies[msgIndex];
      for (let bi = blockIndex + 1; bi < msg.blocks.length; bi++) {
        if (msg.blocks[bi].type === 'step') continue;
        return true;
      }
      // Check for later messages in the turn
      return msgIndex < replies.length - 1;
    })();

    const isPending = pendingCallIds.has(call.call_id);

    // Skip only if it IS the currently-pending question AND there's no
    // evidence it was already answered (no subsequent content).
    if (isPending && !hasSubsequentContent) continue;

    const serverAnswers = toolCallMetadata(call).answers as unknown[] | undefined;
    const cached = optimisticAnswersCache.get(call.id);
    const toolOutput = call.status === 'complete' ? resultText(call) : undefined;
    const input = call.input as { questions?: Array<{ question: string }> } | null;

    if (serverAnswers && serverAnswers.length > 0) {
      // Server has real answers — clean up cache if present
      if (cached) optimisticAnswersCache.delete(call.id);
      result.push({ call, messageId: msgId });
    } else if (cached) {
      // Server hasn't confirmed yet — use cached answers, so
      // AnsweredQuestionCard can render.
      result.push({ call: sessionLogAnsweredQuestionCall(call, cached.answers, cached.input), messageId: msgId });
    } else if (toolOutput && hasSubsequentContent) {
      // Question was answered (output exists and assistant continued)
      // but metadata.answers was never set (e.g. after page reload).
      // Parse answers from the output string as a fallback.
      const parsed = parseAnswersFromOutput(toolOutput, input ?? undefined);
      if (parsed) result.push({ call: sessionLogAnsweredQuestionCall(call, parsed), messageId: msgId });
    } else if (!toolOutput && hasSubsequentContent) {
      // Question was implicitly answered (assistant continued past it)
      // but neither metadata.answers nor output is available.
      // Show a minimal answered card using the input questions
      // with placeholder answers.
      const questionsList: { question: string }[] = Array.isArray(input?.questions)
        ? input.questions
        : [];
      if (questionsList.length > 0) {
        const placeholderAnswers = questionsList.map(() => ['Answered']);
        result.push({ call: sessionLogAnsweredQuestionCall(call, placeholderAnswers), messageId: msgId });
      }
    }
  }
  return result;
}

/** The turn's answered questions: which calls render as answered cards, the
 *  id → call map, and whether text and questions render inline in natural
 *  order instead of the settled response block. */
function useAnsweredQuestionState({
  turn,
  questions,
  sessionId,
  blocks,
  hasSteps,
}: {
  turn: SessionLogTurn;
  questions: QuestionRequest[];
  sessionId: string;
  blocks: TurnModelState['blocks'];
  hasSteps: boolean;
}) {
  const answeredQuestionCalls = useMemo(
    () => collectAnsweredQuestions(turn.assistant, questions, sessionId),
    [turn.assistant, questions, sessionId],
  );
  // Inline content — interleaves text and answered question calls in natural order.
  // When a turn contains answered questions, we need to render text and questions
  // in their original order rather than extracting the last text as a separate "response".
  // This works both during streaming and after completion so that answered questions
  // stay in the correct position while the AI continues responding.
  // Important: for question calls we use the (possibly synthetic) call from
  // answeredQuestionCalls — NOT the raw store call — so that optimistic
  // answers from the cache are included even if the server hasn't confirmed yet.
const answeredQuestionCallsById = useMemo(
  () => new Map(answeredQuestionCalls.map(({ call }) => [call.id, call])),
  [answeredQuestionCalls],
);
const inlineContentParts = useMemo(() => {
  if (answeredQuestionCalls.length === 0) return null;
  const items: Array<
    | { type: 'text'; block: TextBlock; id: string }
    | { type: 'question'; call: ToolCallBlock; id: string }
  > = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      items.push({ type: 'text', block, id: block.id });
    } else if (
      block.type === 'tool_call' &&
      isQuestionTool(block.name) &&
      answeredQuestionCallsById.has(block.id)
    ) {
      // Use the answered call (may be synthetic with cached answers)
      items.push({
        type: 'question',
        call: answeredQuestionCallsById.get(block.id)!,
        id: block.id,
      });
    }
  }
  // Only use inline rendering if there are both text and question items
  const hasText = items.some((i) => i.type === 'text');
  const hasQuestion = items.some((i) => i.type === 'question');
  if (!hasText || !hasQuestion) return null;
  return items;
}, [blocks, answeredQuestionCallsById, answeredQuestionCalls.length]);
  const shouldUseInlineContent = !hasSteps && !!inlineContentParts;
  return { answeredQuestionCalls, answeredQuestionCallsById, inlineContentParts, shouldUseInlineContent };
}

type PromptText = { text: string; synthetic: boolean; ignored: boolean };

/**
 * A user message's text as its v1 text parts held it: a text block, or an
 * `ignored` text (a model-invisible `harness` block whose data is the part).
 */
export function promptTexts(message: SessionLogMessage): PromptText[] {
  return message.blocks.flatMap((b): PromptText[] => {
    if (b.type === 'text') return [{ text: b.text, synthetic: b.synthetic === true, ignored: false }];
    if (b.type !== 'harness' || b.kind !== 'text') return [];
    const data = b.data as { text?: unknown; synthetic?: unknown } | null;
    return typeof data?.text === 'string' ? [{ text: data.text, synthetic: data.synthetic === true, ignored: true }] : [];
  });
}

/** The user side of the turn: the worker-run report, the system pills, the
 *  bubble's visibility, and the command pill. */
function useTurnUserContent({
  turn,
  commandMessages,
  commands,
}: Pick<SessionTurnProps, 'turn' | 'commandMessages' | 'commands'>) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
const texts = useMemo(() => promptTexts(turn.user), [turn.user]);
// Whether the user message has any visible content (non-synthetic, non-ignored
// text, or attachments). Background task notifications inject synthetic-only
// user messages that should not render a user bubble.
// Extract session report from user message (if present)
const sessionReport = useMemo<SessionReport | null>(() => {
  for (const t of texts) {
    const report = extractSessionReport(t.text || '');
    if (report) return report;
  }
  return null;
}, [texts]);
// Extract kortix_system messages for inline rendering (goal continuations, etc.)
const systemMessages = useMemo<KortixSystemMessage[]>(() => {
  const msgs: KortixSystemMessage[] = [];
  for (const t of texts) {
    if (t.text) msgs.push(...extractKortixSystemMessages(t.text, tI18nComplete));
  }
  return msgs;
}, [tI18nComplete, texts]);

const hasVisibleUserContent = useMemo(() => {
  // Session reports render as their own card — don't show as user bubble
  if (sessionReport) return false;
  // The prompt is not loaded (a long run's tail): its stand-in has no blocks
  // and must not render as the empty bubble a loading prompt would.
  if (turn.partial) return false;
  // Blocks not loaded yet (bridging / transient state) — assume visible
  // to prevent a flash where the bubble disappears momentarily.
  if (turn.user.blocks.length === 0) return true;
  // Has any non-synthetic, non-ignored text (including notification XML)?
  const hasVisibleText = texts.some(
    (t) => !t.synthetic && !t.ignored && !!stripKortixSystemTags(t.text || '').trim(),
  );
  if (hasVisibleText) return true;
  // Has any attachment (image/PDF)?
  if (turn.attachments.length > 0) return true;
  // Has any agent mention?
  if (turn.user.blocks.some((b) => b.type === 'harness' && b.kind === 'agent')) return true;
  return false;
}, [turn.partial, turn.user.blocks, turn.attachments, texts, sessionReport]);

// User message text — for copy action
const userMessageText = useMemo(() => {
  const out: string[] = [];
  for (const t of texts) {
    if (t.synthetic || t.ignored) continue;
    const text = stripSystemPtyText(t.text);
    if (text.trim()) out.push(text);
  }
  return out.join('\n').trim();
}, [texts]);

const commandForTurn = useMemo(() => {
  const mapped = commandMessages?.get(turn.id);
  if (mapped) return mapped;
  if (!userMessageText) return undefined;
  return detectCommandFromText(userMessageText, commands);
}, [commandMessages, turn.id, userMessageText, commands]);
// A skill run as `/name` answers like any chat turn; only a real command's output sits in the command card.
const commandOutput = useMemo(() => {
  if (!commandForTurn) return undefined;
  const source = Array.isArray(commands) ? commands.find((c) => c.name === commandForTurn.name)?.source : undefined;
  return source === 'skill' ? undefined : commandForTurn;
}, [commandForTurn, commands]);
  return { sessionReport, systemMessages, hasVisibleUserContent, userMessageText, commandForTurn, commandOutput };
}

/** The throttled working status of the working turn: one status change per
 *  2.5 s, keyed on the turn's parts. */
function useThrottledTurnStatus({
  turn,
  blocks,
}: {
  turn: SessionLogTurn;
  blocks: TurnModelState['blocks'];
}) {
// ---- Status throttling (2.5s) ----
const [statusThrottleStart] = useState(() => Date.now());
const lastStatusChangeRef = useRef(statusThrottleStart);
const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
// A turn the agent has not started has no status to report, and
// `sessionLogActivityText` says so with its fallback phrase — "Figuring out what's
// next…", which is a claim about a turn already under way. On a turn with no
// assistant message at all it is simply untrue, and the 2.5s throttle below
// then swaps the waiting row's honest "Thinking" for it while the prompt is
// still queued at the server (dev, 2026-09-06, on video).
//
// Gated at the SOURCE, not at the prop: the throttle ignores an empty status
// (`if (!newStatus) return`), so `throttledStatus` stays '' — the row keeps
// the default word AND grows no elapsed clock — until real content arrives,
// and the first real status then applies immediately.
const hasAssistantContent = turn.assistant.length > 0;
const rawStatus = useMemo(
  () => (hasAssistantContent ? sessionLogActivityText({ blocks }) : ''),
  [blocks, hasAssistantContent],
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
      setThrottledStatus(sessionLogActivityText({ blocks }));
      lastStatusChangeRef.current = Date.now();
    }, 2500 - elapsed);
  }
  return () => clearTimeout(statusTimeoutRef.current);
}, [blocks, rawStatus, throttledStatus]);
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
// The clock also covers the silent start of a turn (KRTX-1872). The status
// phrase stays empty until the turn's first assistant message, and the label
// used to be gated on it — so the provisioning/queue phase of a fresh
// account's first turn, which can hold ~5 minutes, kept a bare "Thinking"
// with no clock and read as frozen. The phrase stays empty (it must not
// claim content exists); the elapsed label runs on `agentWorking` alone.
const statusElapsedLabel =
  agentWorking && statusElapsedMs >= STATUS_STALL_AFTER_MS
    ? formatDuration(statusElapsedMs)
    : undefined;
  return { statusPhrase, statusElapsedLabel };
}

/** The busy row's status line and elapsed clock, composed from the throttle
 *  and the clock. */
function useTurnLiveStatus({
  turn,
  blocks,
  agentWorking,
}: {
  turn: SessionLogTurn;
  blocks: TurnModelState['blocks'];
  agentWorking: boolean;
}) {
  const throttledStatus = useThrottledTurnStatus({ turn, blocks });
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
}: {
  working: boolean;
  turn: SessionLogTurn;
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
// Cost info (only when not working): the turn's cost, priced by the
// transcript's `sessionLogTurns` call with the model pricing lookup.
const costInfo = !working ? (turn.cost ?? undefined) : undefined;
  return { turnEndedAt, turnDurationMs, costInfo };
}

/** The turn's blocks, segmented into bursts / standalone tools / text for the
 *  steps section. */
function useTurnSegments({
  blocks,
  answeredQuestionCallsById,
  shouldUseInlineContent,
  permissions,
  sessionId,
}: {
  blocks: TurnModelState['blocks'];
  answeredQuestionCallsById: TurnAnsweredState['answeredQuestionCallsById'];
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
 * The turn's blocks, cut into bursts / standalone tools / text.
 *
 * This ran INLINE in the JSX below, which meant a `map`, a `filter` and the
 * whole segmentation on every render of this turn — and, worse, a brand
 * new `segment.blocks` array for every burst every time. `ActivityBurst` keys
 * its `useMemo`s on `blocks`, so a fresh array identity per render made every
 * one of them a guaranteed miss: the burst steps, the summary and the step
 * labels recomputed for every burst in the turn on every frame, and no
 * `React.memo` below could ever hold. A turn re-renders for reasons that have
 * nothing to do with its blocks — a hover, a permission arriving, the parent's
 * state — and each of those paid the full price.
 *
 * Memoised, the arrays keep their identity until the blocks actually change,
 * which is what makes the memo boundaries downstream able to bite.
 */
const segments = useMemo(() => {
  const list: SessionLogBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_call' && isPlanWriteTool(block.name)) continue;
    if (block.type === 'tool_call' && isQuestionTool(block.name)) {
      // Keep only answered questions, and only if not rendering inline.
      if (!answeredQuestionCallsById.has(block.id) || shouldUseInlineContent) continue;
      // A kept question rides into its burst as the ANSWERED call — the
      // one from answeredQuestionCalls, possibly synthetic with
      // optimistically-cached or output-parsed answers the raw store call
      // does not carry yet. Without this substitution the burst row would
      // show "0 answered" until the server confirms.
      list.push(answeredQuestionCallsById.get(block.id) ?? block);
      continue;
    }
    list.push(block);
  }
  // Consecutive `show` calls render as one carousel card (`show-group`).
  return sessionLogTurnSegments(list, { standaloneCallIds });
}, [blocks, answeredQuestionCallsById, shouldUseInlineContent, standaloneCallIds]);
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
    call: ToolCallBlock;
    working: boolean;
    errors: TurnErrorState;
    connectProviderOpen: boolean;
    onConnectProviderOpenChange: (open: boolean) => void;
  },
) {
  const {
    call, working, providers, errors, connectProviderOpen, onConnectProviderOpenChange,
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
          call={call}
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
    compactionInfo: SessionLogCompaction;
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
  onOpenCompactionSummary?.(turn.id, response);
}, [onOpenCompactionSummary, turn.id, response]);
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
  // left a stack of near-empty screens with one error line each. The turn
  // error and its abort verdict read the compaction marker first: it carries
  // its summary's error.
  return (
    <div className="group/turn">
      <CompactionFailedRow error={turnError} isAbort={turnErrorIsAbort} />
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
  props: Pick<SessionTurnProps, 'turn' | 'author' | 'showAuthor' | 'pending' | 'interruptedBeforeRun' | 'pendingPrompt' | 'onRetryQueued' | 'onRemoveQueued' | 'queuedPromptViewer' | 'pendingAttachments' | 'uploadStatus' | 'pendingText' | 'agentNames' | 'commandMessages' | 'commands' | 'sessionId' | 'ownsPlan' | 'onRewind' | 'rewindDisabled' | 'editingText' | 'editPending' | 'onEditCancel' | 'onEditSend' | 'onOpenPastedContent'> & {
    model: TurnModelState;
    queueTone: TurnQueueTone;
    userContent: TurnUserContentState;
  },
) {
  const { userContent } = props;
  const { sessionReport, systemMessages, hasVisibleUserContent } = userContent;
  // P5.6: the note a partial restore left for the agent is a notice, not a person's prompt.
  if (isSessionLogRestoreNote(props.turn.user)) return <RestoreNoteMarker />;
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
  props: Pick<SessionTurnProps, 'turn' | 'author' | 'showAuthor' | 'pending' | 'interruptedBeforeRun' | 'pendingPrompt' | 'onRetryQueued' | 'onRemoveQueued' | 'queuedPromptViewer' | 'pendingAttachments' | 'uploadStatus' | 'pendingText' | 'agentNames' | 'commandMessages' | 'commands' | 'sessionId' | 'ownsPlan' | 'onRewind' | 'rewindDisabled' | 'editingText' | 'editPending' | 'onEditCancel' | 'onEditSend' | 'onOpenPastedContent'> & {
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
    onRetryQueued, onRemoveQueued, queuedPromptViewer, onOpenPastedContent,
  } = props;
  const { queueState, queuedStatus } = props.queueTone;
  const promptActions =
    pendingPrompt && queuedPromptViewer
      ? sessionPromptActions(pendingPrompt, queuedPromptViewer)
      : { own: true, removable: true };
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
          message={turn.user}
          author={author}
          showAuthor={showAuthor}
          pendingAttachments={pendingAttachments}
          uploadStatus={uploadStatus}
          pendingText={pendingText}
          agentNames={agentNames}
          commandInfo={commandMessages?.get(turn.id)}
          commands={commands}
          sessionId={sessionId}
          ownsPlan={ownsPlan}
          onRewind={onRewind}
          rewindDisabled={rewindDisabled || pending || interruptedBeforeRun}
          editingText={editingText}
          editPending={editPending}
          onEditCancel={onEditCancel}
          onEditSend={onEditSend}
          onOpenPastedContent={onOpenPastedContent}
          deliveryStatus={
            queuedStatus === 'failed' ? (
              <QueuedPromptFailure
                lastError={pendingPrompt?.last_error}
                onRetry={
                  pendingPrompt && onRetryQueued && promptActions.own
                    ? () => onRetryQueued(pendingPrompt.prompt_id)
                    : undefined
                }
                onRemove={
                  pendingPrompt && onRemoveQueued && promptActions.removable
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
    /** False keeps today's flat render (inline text-and-questions mode). */
    fold: boolean;
    durationMs: number | null;
  },
) {
  const {
    turn, sessionId, permissions, onPermissionReply, disableToolNavigation,
    model, segments, conversationDensity, fold, durationMs,
  } = props;
  const { working, hasSteps, hasReasoning } = model;
  // KRTX-2113: a settled turn folds its work behind one "Worked for" row and
  // keeps the `show` deliverables and the final text below it. Segments that
  // render nothing (a hidden tool, a plumbing-only burst) are dropped first,
  // so they can neither be the only "work" nor stand between the final text
  // and the end of the turn.
  // Settled turns only: while working the split is null anyway, and the
  // filter re-runs the burst steps on every SSE frame.
  const split = useMemo(
    () => (fold && !working ? splitSessionLogTurnWork(segments.filter(segmentRendersSomething), { working }) : null),
    [fold, segments, working],
  );
  const renderSegment = (segment: TurnSegments[number]) => {
    const key = turnSegmentKey(segment);
    if (key === null) return null;
    return (
      <TurnSegment
        key={key}
        segment={segment}
        isTrailing={segment === segments[segments.length - 1]}
        working={working}
        openText={model.openText}
        hasSteps={hasSteps}
        sessionId={sessionId}
        permissions={permissions}
        onPermissionReply={onPermissionReply}
        disableNavigation={disableToolNavigation}
        conversationDensity={conversationDensity}
      />
    );
  };
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
    {(working || hasSteps || hasReasoning) && turn.assistant.length > 0 && (
      // Every tool row below — the bursts' rows and the standalone ones —
      // reads this to tell a call that has not spoken YET from one that never
      // will. Provided here rather than per-row because `working` is a fact
      // about the TURN, and this block is the turn's whole part tree.
      // See `TurnLiveContext`.
      <TurnLiveContext.Provider value={working}>
        <div className="space-y-3">
          {/* One keyed array in both states, so the hoisted deliverables and
              the final text keep their instances at settle: a `show` iframe
              does not reload and the final markdown does not re-parse. While
              working (or settled with nothing to fold) it is the plain stream.
              Settled, the work leaves for the "Worked for" row, which mounts
              closed. The cost: the work disappears at once, not in a fold. */}
          {split
            ? [
                <TurnWorkAccordion key="turn-work" durationMs={durationMs}>
                  {split.work.map(renderSegment)}
                </TurnWorkAccordion>,
                ...split.hoisted.map(renderSegment),
                ...split.final.map(renderSegment),
              ]
            : segments.map(renderSegment)}
        </div>
      </TurnLiveContext.Provider>
    )}
    </>
  );
}

/** One segment of the turn's steps section: a burst, a show group, a
 *  standalone deliverable, or prose between bursts. Keyed by the first
 *  block's id (`turnSegmentKey`). */
function turnSegmentKey(segment: SessionLogSegment): string | null {
  if (segment.kind === 'burst') return `burst-${segment.blocks[0]?.id ?? 'empty'}`;
  if (segment.kind === 'standalone') {
    return shouldShowToolPart(segment.block) ? segment.block.id : null;
  }
  if (segment.kind === 'show-group') {
    const visible = segment.blocks.filter(shouldShowToolPart);
    return visible.length > 0 ? visible[0].id : null;
  }
  return segment.block.id;
}

function segmentRendersSomething(segment: SessionLogSegment): boolean {
  if (segment.kind === 'burst') return sessionLogBurstSteps(segment.blocks).length > 0;
  return turnSegmentKey(segment) !== null;
}

function TurnSegment({
  segment,
  isTrailing,
  working,
  openText,
  hasSteps,
  sessionId,
  permissions,
  onPermissionReply,
  disableNavigation,
  conversationDensity,
}: {
  segment: SessionLogSegment;
  isTrailing: boolean;
  working: boolean;
  openText: TurnModelState['openText'];
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
        blocks={segment.blocks}
        sessionId={sessionId}
        working={working}
        isTrailing={isTrailing}
        disableNavigation={disableNavigation}
        density={conversationDensity}
      />
    );
  }
  if (segment.kind === 'show-group') {
    const visible = segment.blocks.filter(shouldShowToolPart);
    if (visible.length === 1) {
      return (
        <ToolPartRenderer call={visible[0]} sessionId={sessionId} disableNavigation={disableNavigation} />
      );
    }
    return <ShowGroupRenderer calls={visible} sessionId={sessionId} disableNavigation={disableNavigation} />;
  }
  if (segment.kind === 'standalone') {
    if (!shouldShowToolPart(segment.block)) return null;
    return (
      <ToolPartRenderer
        call={segment.block}
        sessionId={sessionId}
        disableNavigation={disableNavigation}
        permission={getPermissionForTool(permissions, segment.block.call_id)}
        onPermissionReply={onPermissionReply}
      />
    );
  }
  if (!hasSteps) return null;
  const text = segment.block.text.trim();
  if (!text) return null;
  const open = openText?.block === segment.block;
  return (
    <div className="min-w-0 text-sm">
      <ThrottledMarkdown
        content={text}
        isStreaming={open}
        revealKey={open ? `${openText.messageId}:${segment.block.id}` : undefined}
      />
    </div>
  );
}

/** What the turn says: the completion announce, the streaming text, and
 *  either the inline text-and-questions flow or the settled response. Exported for its test. */
export function TurnAssistantBlock(
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
      {shouldUseInlineContent ? (
        <TurnInlineContent openText={model.openText} parts={inlineContentParts!} />
      ) : (
        <TurnSettledResponse
          working={working}
          openText={model.openText}
          hasSteps={hasSteps}
          hasReasoning={hasReasoning}
          response={response}
          commandForTurn={userContent.commandOutput}
          answeredQuestionCalls={answered.answeredQuestionCalls}
        />
      )}
    </>
  );
}

/** Inline content: text and answered questions in natural order, while the
 *  turn streams around them. */
function TurnInlineContent({
  openText,
  parts,
}: {
  openText: TurnModelState['openText'];
  parts: NonNullable<TurnAnsweredState['inlineContentParts']>;
}) {
  return (
      <div className="space-y-3">
        {parts.map((item) => {
          if (item.type === 'text') {
            const isStreaming = item.block === openText?.block;
            const text = isStreaming ? item.block.text : item.block.text.trim();
            // One component across the turn's end, so the generative UI blocks in the text keep their state.
            return (
              <div key={item.id} className="min-w-0 text-sm">
                <ThrottledMarkdown
                  content={text}
                  isStreaming={isStreaming}
                  revealKey={isStreaming ? `${openText!.messageId}:${item.block.id}` : undefined}
                  response
                />
              </div>
            );
          }
          return <AnsweredQuestionCard key={item.id} call={item.call} />;
        })}
      </div>
  );
}

/** The settled response: the text (or command pill) plus the answered
 *  question cards that no upstream renderer has already shown. */
function TurnSettledResponse({
  working,
  openText,
  hasSteps,
  hasReasoning,
  response,
  commandForTurn,
  answeredQuestionCalls,
}: {
  working: boolean;
  openText: TurnModelState['openText'];
  hasSteps: boolean;
  hasReasoning: boolean;
  response: string;
  commandForTurn: TurnUserContentState['commandForTurn'];
  answeredQuestionCalls: TurnAnsweredState['answeredQuestionCalls'];
}) {
  return (
      <>
        {/* Response text for text-only turns (no tools/steps content). One element from the first streamed
            word to the settled turn, so the generative UI blocks in it do not remount when the turn ends. */}
        {!hasSteps && response && (working || !commandForTurn) ? (
          <div className={working ? 'min-w-0 text-sm' : 'text-sm'}>
            <ThrottledMarkdown
              content={response}
              isStreaming={openText !== null}
              revealKey={openText ? `${openText.messageId}:response` : undefined}
              response
            />
          </div>
        ) : null}
        {/* A command's output settles into its card. */}
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
                  <SandboxUrlDetector content={response} isStreaming={false} genui />
                </ExpandableOutput>
              </div>
              <CodeBlockEndpoints content={response} />
            </div>
          ) : null)}

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
        {!hasSteps && !working && !hasReasoning && answeredQuestionCalls.length > 0 && (
          <div className="mt-3 space-y-2">
            {answeredQuestionCalls.map(({ call }) => (
              <AnsweredQuestionCard key={call.id} call={call} />
            ))}
          </div>
        )}
      </>
  );
}

/** A turn someone else stopped names them, quietly, in the activity lane. */
function TurnStoppedBy({ name }: { name: string }) {
  const t = useTranslations('threads');
  return (
    <div role="note" className="flex w-full items-center gap-3 text-left text-sm">
      <StopCircleIcon className="text-muted-foreground size-4 flex-none" />
      <span className="text-muted-foreground min-w-0 wrap-anywhere">{t('stoppedBy', { name })}</span>
    </div>
  );
}

/** The automatic retries an ended failure chain ran, under its terminal row
 *  (KRTX-2597): the transcript renders one failure row, not one per retry,
 *  and this quiet line records what the harness already spent on it. */
function TurnAutoRetryNote({ count }: { count: number }) {
  const t = useTranslations('sessionUi.turn');
  return (
    <p className="text-muted-foreground mt-1 text-xs" data-auto-retry-note>
      {t('autoRetried', { count })}
    </p>
  );
}

/** The turn's footer: the working row, the error banner, the outcomes, the
 *  action bar, the connect-provider dialog, and who stopped the turn. */
function TurnFooter(
  props: Pick<SessionTurnProps, 'turn' | 'sessionId' | 'suppressBusyIndicator' | 'awaitingUser' | 'providers' | 'servedModel' | 'stoppedBy' | 'modelOptions'> & {
    /** The row's floating toolbar draws the action bar instead (`TranscriptRowsContext`). */
    hideActionBar?: boolean;
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
    connectProviderOpen, onConnectProviderOpenChange, servedModel, stoppedBy, modelOptions,
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
    {/* ── Error (abort / failure banner) ──
        An automatic provider-error recovery chain (KRTX-2597) renders ONE
        terminal row: a turn whose failure the harness already continued
        (`turn.autoRetry?.continued`) yields its row to the continuation's
        outcome, and the chain's end annotates how many automatic retries
        already ran. */}
    {turnErrorRow.text && !turn.autoRetry?.continued && (
      <TurnErrorDisplay
        errorText={turnErrorRow.text}
        errorDetails={turnErrorRowDetails}
        errorRaw={turnErrorRaw}
        isAbort={turnErrorRow.isAbort}
        modelOptions={modelOptions}
      />
    )}
    {turnErrorRow.text && !turnErrorRow.isAbort && !turn.autoRetry?.continued && !!turn.autoRetry?.retries && (
      <TurnAutoRetryNote count={turn.autoRetry.retries} />
    )}
    {/* ── Who stopped it, when it was someone else: an own stop is not news ── */}
    {!working && stoppedBy && <TurnStoppedBy name={stoppedBy} />}
    {/* ── Outcomes — what this turn left behind ──
        Always visible, unlike the hover-revealed action bar below. A hidden
        record of a change request is a trust bug: the point of
        the card is that a durable side effect cannot happen quietly.

        Gated on `!working` for the same reason the action bar is — an
        outcome is a settled fact, and a card that appears mid-stream would
        claim a change request exists before the server has one. */}
      {!working && <TurnOutcomes turnKey={turn.id} />}

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
      {!working && !props.hideActionBar && (
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
  inToolbar = false,
}: {
  /** Inside a message row's toolbar, which owns the hover reveal. */
  inToolbar?: boolean;
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
          const text = item.block.text.trim();
          return text ? [text] : [];
        })
        .join('\n\n')
    : response;
  if (!textToCopy) return;
  try {
    await copyGenuiText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    // The browser refused the write; `copied` stays false.
  }
};
  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        !inToolbar &&
          'duration-normal opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100',
      )}
    >
      {response ? (
          <Button
            variant="ghost"
            size={inToolbar ? 'icon-md' : 'icon-sm'}
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
          // A toolbar button is 33px (`icon-md`), the same as its neighbours.
          className={cn('flex items-center justify-center', inToolbar && 'size-9')}
        />
    </div>
  );
}

/** A row's time: "1:44 AM" beside the name, the full date on hover. Null without a stamp. */
function rowTime(at: number, locale: string): Parameters<typeof MessageRow>[0]['time'] {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  return {
    iso: date.toISOString(),
    label: date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
    title: date.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' }),
  };
}

function SessionTurnImpl(props: SessionTurnProps) {
  const {
    turn, turnOutcome, sessionId, sessionStatus, permissions, questions,
    sessionWorking, isWorkingTurn, awaitingUser,
    pending, pendingPrompt, interruptedBeforeRun, isCompaction,
    providers, commandMessages, commands,
  } = props;
  const tHardcodedUi = useTranslations('hardcodedUi');
  const locale = useLocale();
  const afterFirstPrompt = useContext(AfterFirstPromptContext);
  const rows = useContext(TranscriptRowsContext);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );

  const model = useTurnModelState({ turn, isWorkingTurn, sessionWorking, awaitingUser });
  const queueTone = useTurnQueueTone({ pending, pendingPrompt, interruptedBeforeRun });
  const errors = useTurnErrorState({ turn, turnOutcome });
  const answered = useAnsweredQuestionState({ turn, questions, sessionId, blocks: model.blocks, hasSteps: model.hasSteps });
  const userContent = useTurnUserContent({ turn, commandMessages, commands });
  const status = useTurnLiveStatus({ turn, blocks: model.blocks, agentWorking: model.agentWorking });
  const retry = useTurnRetryState({ sessionStatus, isWorkingTurn });
  const meta = useTurnSettledMeta({ working: model.working, turn });
  const segments = useTurnSegments({
    blocks: model.blocks,
    answeredQuestionCallsById: answered.answeredQuestionCallsById,
    shouldUseInlineContent: answered.shouldUseInlineContent,
    permissions,
    sessionId,
  });
  // A compaction turn's message-state — `inFlight` (the marker still
  // streams its summary) is the half of "is this compaction running" the
  // working projection cannot see, because it deliberately knows nothing
  // about compaction.
  const compactionInfo = isCompaction ? turn.compaction : null;
  // genui_block telemetry: one scope per turn, shared by the streaming and the settled render.
  // Keyed on strings, not on `turn`, so a streaming frame does not re-render every block of the turn.
  const genuiModel = turn.assistant.at(-1)?.model?.model;
  const genuiScope = turn.id;
  const genuiTelemetry = useMemo(
    () => ({ scope: genuiScope, ...(genuiModel ? { model: genuiModel } : {}) }),
    [genuiScope, genuiModel],
  );

  // Shell mode: a synthetic prompt answered by one bare `bash` call.
  if (turn.shell) {
    return (
      <TurnShellMode
        {...props}
        call={sessionLogOpenCall(turn.shell)}
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
        // The summary is the compaction block's: as it streams while the
        // turn works, trimmed once it landed.
        response={model.working ? (compactionInfo.block?.summary ?? '') : (compactionInfo.block?.summary ?? '').trim()}
        turnError={errors.turnError}
        turnErrorIsAbort={errors.turnErrorIsAbort}
      />
    );
  }
  if (rows) {
    const userAt = Date.parse(turn.user.created_at);
    const answerAt = Date.parse(turn.assistant[0]?.created_at ?? '');
    const author = props.author;
    // Another session's agent wrote this prompt (a spawned thread's first
    // message, a coordinator): its agent's row, not the thread owner's.
    const sender =
      author?.kind === 'session'
        ? (author.agent ? agentDisplayLabel([], author.agent) : author.name) || rows.unknownAuthor
        : null;
    const person = author?.kind === 'member'
      ? { name: author.name, email: author.email, avatarUrl: author.avatar_url ?? null }
      : rows.owner;
    const personName = person ? participantLabel(person) : '';
    const showAnswer = turn.assistant.length > 0 || model.working || !!errors.turnErrorRow.text;
    return (
      <div className="text-factor-[2]">
        {userContent.hasVisibleUserContent || userContent.sessionReport || userContent.systemMessages.length > 0 ? (
          <MessageRow
            className="group/turn"
            avatar={
              sender ? (
                <EntityAvatar icon={RobotIcon} label={sender} size="lg" />
              ) : (
                <UserAvatar email={person?.email ?? ''} name={personName} avatarUrl={person?.avatarUrl} size="lg" />
              )
            }
            name={sender ?? (personName || rows.unknownAuthor)}
            time={rowTime(userAt, locale)}
          >
            <TurnUserBlock {...props} model={model} queueTone={queueTone} userContent={userContent} />
          </MessageRow>
        ) : null}
        {props.isFirstTurn ? afterFirstPrompt : null}
        {showAnswer ? (
          <MessageRow
            className="group/turn"
            avatar={<EntityAvatar icon={RobotIcon} label={rows.agent} size="lg" />}
            name={rows.agent}
            time={rowTime(answerAt, locale)}
            toolbar={
              model.working ? null : (
                <TurnActionBar
                  inToolbar
                  response={model.response}
                  inlineContentParts={answered.inlineContentParts}
                  turnEndedAt={meta.turnEndedAt}
                  turnDurationMs={meta.turnDurationMs}
                  costInfo={meta.costInfo}
                  servedModel={props.servedModel}
                  tHardcodedUi={tHardcodedUi}
                />
              )
            }
          >
            <div className="mt-0.5 space-y-2.5">
              <TurnFallbackRows working={model.working} events={props.servedModel?.fallbacks} />
              <GenuiTelemetryContext.Provider value={genuiTelemetry}>
                <TurnToolBlocks
                  {...props}
                  model={model}
                  segments={segments}
                  conversationDensity={conversationDensity}
                  fold={!answered.shouldUseInlineContent}
                  durationMs={meta.turnDurationMs}
                />
                <TurnAssistantBlock {...props} model={model} answered={answered} userContent={userContent} tHardcodedUi={tHardcodedUi} />
              </GenuiTelemetryContext.Provider>
              <TurnFooter {...props} hideActionBar model={model} errors={errors} answered={answered} status={status} retry={retry} meta={meta} tHardcodedUi={tHardcodedUi} connectProviderOpen={connectProviderOpen} onConnectProviderOpenChange={setConnectProviderOpen} />
            </div>
          </MessageRow>
        ) : null}
      </div>
    );
  }
  return (
    <div className="group/turn text-factor-[2] space-y-2.5">
      <TurnUserBlock {...props} model={model} queueTone={queueTone} userContent={userContent} />
      {props.isFirstTurn ? afterFirstPrompt : null}
      {/* Model switches happened while the turn worked, so they sit above
          its work and its answer, not under the answer. */}
      <TurnFallbackRows working={model.working} events={props.servedModel?.fallbacks} />
      <GenuiTelemetryContext.Provider value={genuiTelemetry}>
        <TurnToolBlocks
          {...props}
          model={model}
          segments={segments}
          conversationDensity={conversationDensity}
          fold={!answered.shouldUseInlineContent}
          durationMs={meta.turnDurationMs}
        />
        <TurnAssistantBlock {...props} model={model} answered={answered} userContent={userContent} tHardcodedUi={tHardcodedUi} />
      </GenuiTelemetryContext.Provider>
      <TurnFooter {...props} model={model} errors={errors} answered={answered} status={status} retry={retry} meta={meta} tHardcodedUi={tHardcodedUi} connectProviderOpen={connectProviderOpen} onConnectProviderOpenChange={setConnectProviderOpen} />
    </div>
  );
}

/**
 * The boundary that stops the transcript re-rendering with the stream.
 *
 * `messages` is rebuilt on every SSE frame, so this component used to re-render
 * for every turn in the session ~60 times a second — and each of those renders
 * re-ran ~28 `useMemo`s (all keyed on `turn`), a plan-anchor scan of the
 * whole transcript, the segmentation, and every tool renderer beneath it.
 * `content-visibility: auto` on the wrapper hid the layout cost of that, not the
 * JavaScript.
 *
 * The default shallow compare is correct here ONLY because three things were
 * fixed first, and each is load-bearing: `turn` keeps its identity when its
 * messages have not changed (`sessionLogTurns`), the `allMessages` array prop is
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
  /** P5.6: the harness the session continued with from this turn on (`harness.history`). */
  continuedWith?: string;
  /** P5.6: this turn's full-text load, for the texts it shows as a preview. */
  fullTextState: FullTextState;
  onLoadFullText: (turnId: string, refs: readonly SessionLogReferencedText[]) => void;
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
  continuedWith,
  fullTextState,
  onLoadFullText,
  ...turnProps
}: TranscriptTurnRowProps) {
  return (
    <TurnViewport
      turnId={turnId}
      className={viewportClassName}
      continues={turnProps.turn.compaction !== null || turnProps.turn.continues !== null}
    >
      {continuedWith && (
        <div className="mb-6">
          <HarnessSwitchMarker harness={continuedWith} />
        </div>
      )}
      {/* No separate divider for compaction turns — the
      CompactionMarker rendered by SessionTurn IS the
      divider (rule–pill–rule), through every phase. */}
      {suppressed ? null : <SessionTurn {...turnProps} />}
      {!suppressed && <TurnFullText turn={turnProps.turn} state={fullTextState} onLoad={onLoadFullText} />}
      {/* Queued bubbles follow this turn. The waiting
          row stays above them, where the working turn
          draws its own, so it never jumps. */}
      {showBusyRow && <SessionBusyIndicator sessionId={turnProps.sessionId} className="mt-2.5" />}
    </TurnViewport>
  );
});
TranscriptTurnRow.displayName = 'TranscriptTurnRow';

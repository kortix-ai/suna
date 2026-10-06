'use client';


import { isQuestionTool } from './session-activity-groups';
import { SessionApprovalPrompt } from '@/features/session/session-approval-prompt';
import { childSessionHref } from '@/features/session/tool/tools/session-spawn-urls';
import { SessionPermissionPrompt } from '@/features/session/session-permission-prompt';
import { useSessionWallpaperLayer } from '@/features/session/session-wallpaper-layer';
import { useTranslations } from '@/i18n/use-translations';
import { errorMessageOf, isDeliveredButDisconnected } from '@/lib/delivered-but-disconnected';
import { useQueuedDraftStore, useQueuedDrafts } from '@/stores/queued-draft-store';
import {
  type SandboxLifecycle,
  type SessionPrompt,
  type SessionPromptDelivery,
  type SessionPromptPart,
  hasRetryingAssistantTurn,
  isTextPart,
  isToolPart,
  listSessionPrompts,
  projectSessionConnection,
} from '@kortix/sdk';
import { useProjectSession, useSessionMessageAuthors, useSessionModelUsage, useSessionParticipants } from '@kortix/sdk/react';
import { ArrowBendUpLeftIcon, CaretDownIcon, StackIcon as Layers } from '@phosphor-icons/react';
import { m } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AUTHOR_RETRY_DELAYS_MS,
  authorForTurn,
  awaitsAgent,
  missingAuthorKey,
  resolveTranscriptAuthors,
  showAuthorName,
} from './turn/message-author';
import { useAuth } from '@/features/providers/auth-provider';
import { QueuedPromptList } from './composer/queued-prompt-list';
import { runtimePermissionLocksComposer } from './composer/send-blockers';
import { SessionPrintHeader } from './print/session-print-header';
import { useSessionPrint } from './print/use-session-print';
import {
  COMPOSER_EDITOR_SELECTOR,
  SUGGESTION_MENU_SELECTOR,
  shouldCountEscape,
} from './esc-to-stop';
import { composerSendDelivery, isFirstPromptRow, projectQueueRows } from './queue-projection';
import { useQueuedPromptEdit } from './queued-prompt-edit';
import { createQueueUndoAction } from './queued-message-restore';
import { CompactionMarker, CompactionSummaryBody } from './turn/compaction-card';
import { compactionTurnInfo } from './turn/compaction-state';
import { chatPlanAnchorId } from './turn/plan-anchor';
import { stabilizeTurns } from './turn/stable-turns';
import { ThrottledMarkdown } from './turn/throttled-markdown';
import { TurnViewport } from './turn/turn-viewport';
import { UserMessage } from './turn/user-message';
import {
  fallbackBusyRowAfterTurnId,
  freshSendHint,
  resolveWorkingTurn,
  shouldSuppressWorkingTurnBusy,
  turnIsConfirmedActive,
  workingTurnDrawsBusyRow,
} from './turn/working-turn';

import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useOptionalSessionPanel } from '@/features/session/action-panel/session-panel-provider';
import {
  COMPOSER_SHELL_CLASS,
  Composer as SessionChatInput,
} from '@/features/session/composer/composer';
import { resolveComposerAgent } from '@/features/session/composer/composer-agent-access';
import {
  acknowledgeQuoteRequests,
  type QuoteRequest,
} from '@/features/session/composer/composer-logic';
import { sessionSlashFiles } from '@/features/session/composer/menus/slash-files';
import {
  resolveFirstPromptHandover,
  transcriptCarriesFirstPrompt,
} from '@/features/session/first-prompt-handover';
import { CompactModal } from '@/features/session/header/compact-modal';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { claimFirstTurnRow } from '@/features/session/inbox-row-claims';
import { type ModelDefaultControls } from '@/features/session/model-selector';
import { OptimisticTurn } from '@/features/session/optimistic-turn';
import { inboxHoldsLivePrompt } from '@/features/session/inbox-live-prompt';
import { type TurnSpan } from '@/features/session/outcomes/anchor-outcomes';
import type { Outcome } from '@/features/session/outcomes/outcome-types';
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
import { TurnErrorDisplay } from '@/features/session/session-error-banner';
import {
  deliverAfterPaint,
  sentFailureMessage,
  type AttachmentSubmission,
} from '@/features/session/composer/attachment-submission';
import { SessionWelcome } from '@/features/session/session-welcome';
import { showTurnBusyIndicator } from '@/features/session/turn-busy-visibility';
import {
  editResendAttachments,
  type AttachmentUploadStatus,
  type NormalizedAttachment,
} from '@/features/session/turn/user-message';
import { SessionBusyIndicator } from './session-busy-indicator';
import { useSessionBaseRef } from './session-changes-shared';
import { resolveEffectiveBusy } from './session-chat-busy';
import { MODEL_USAGE_SETTLE_MS, servedModelNotice, sessionBilledCost, turnServedModelResolver } from './turn/served-model';
import { sessionTurnSpan } from './session-turn-meta-rows';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { dismissToast, errorToast, infoToast } from '@/components/ui/toast';
// billingApi / invalidateAccountState / useQueryClient removed — billing is handled server-side by the router
import { ChatMinimap } from '@/features/session/chat-minimap';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import { usePlanInChat } from '@/features/session/plan-surface';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { ToolActivateContext } from '@/features/session/tool/tool-renderers';
import {
  firstPromptAttachments,
  retainSentAttachmentPreviews,
  sentAttachmentsForTurn,
  type SentAttachment,
} from '@/features/session/sent-attachment-previews';
import {
  buildOptimisticPromptTextWithUploads,
  promptFileParts,
  sentAttachmentsOf,
} from '@/features/session/uploaded-file-refs';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import {
  type AgentRefLike,
  type FileRefLike,
  appendSessionRefs,
  buildAgentRefsBlock,
  buildFileRefsBlock,
} from '@/lib/project-preamble';
import { playSound } from '@/lib/sounds';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useChatSendStore } from '@/stores/chat-send-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import {
  retryHeldSend,
  useFirstPromptPreviewStore,
  useHeldSendFailureStore,
  type HeldSend,
} from '@/stores/session-composer-handoff-store';
import {
  useAttachRequest,
  useSessionComposerPrefillStore,
  useSessionPrefill,
} from '@/stores/session-composer-prefill-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { projectSessionHref } from '@/lib/navigation/session-href';
import {
  type Command,
  type QuestionRequest,
  type ToolPart,
  type Turn,
  getRetryInfo,
  getWorkingState,
  groupMessagesIntoTurns,
} from '@/ui';
import { isAbortError, turnEndNotice } from '@kortix/sdk';
import { failureShownByTurn, persistedFailureText } from '@/features/session/persisted-turn-failure';
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
  useRuntimeSupports,
  useSessionModelSelection,
  useSessionPrompts,
  useSessionStateStore,
  useSessionMessages,
  useSessionSync,
  useSessionTurnOutcome,
  useSessionWorking,
  useSessionWorkingStore,
} from '@kortix/sdk/react';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useReloadForensics } from './reload-forensics';
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

import { TranscriptTurnRow, optimisticAnswersCache, resolveTurnError } from './session-chat/transcript';
export { SessionReportCard, deriveTurnErrorAbortState, deriveTurnErrorPresentation } from './session-chat/transcript';

// ============================================================================
// Sub-Session Breadcrumb
// ============================================================================

// SubSessionBar removed — subsessions show their parent as the header breadcrumb


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
// Message parsing exported to message-parsing.tsx
// ============================================================================

/** How long Stop will wait for the inbox hold before it issues the cancel
 *  anyway. The hold going first is a preference — it saves a stopped prompt
 *  from coming back a reaper pass later — while the abort is the thing the user
 *  pressed the button for, and a stalled request must never hold it hostage
 *  with the agent still running. One round-trip's worth, no more. */
const STOP_HOLD_DEADLINE_MS = 1500;


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
  /**
   * Drawn in the composer's slot, in flow, when `readOnly`: a terminal
   * session state (stopped with no computer, lost computer, failed start)
   * that says why nothing can be sent and offers the one action.
   */
  inputReplacement?: React.ReactNode;
  /** Start scrolled to the top instead of the bottom (e.g. sub-session modal viewer) */
  initialScrollTop?: boolean;
  /**
   * The Kortix session (`<projectId>/<sessionId>`) a read-only sub-agent
   * session runs inside. With it, the sub-agent's saved transcript paints while
   * the computer is off; without it, only the running computer can answer.
   */
  savedHistoryScope?: string;
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

/**
 * Transcript delivery cadence while a turn streams. Everything this component
 * derives from the rows (turn grouping, per-turn props, the O(messages) memos)
 * re-runs per delivery, and the streaming text itself is paced at 80 ms by
 * `ThrottledMarkdown`, so delivering faster than this buys no visible update.
 * The first change after a quiet interval still shows at once.
 */
const TRANSCRIPT_THROTTLE_MS = 50;

/** `useSessionMessages` input when no `useSession` owns this chat: reads nothing. */
const DETACHED_SESSION_MESSAGES = { projectId: '', sessionId: '', runtimeSessionId: null };

export function SessionChat({
  sessionId,
  projectSessionId,
  sessionState,
  projectId,
  boundAgentName,
  headerLeadingAction,
  hideHeader,
  readOnly,
  inputReplacement,
  initialScrollTop,
  savedHistoryScope,
  onContentReady,
  deferComposerFocus,
}: SessionChatProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tQueue = useTranslations('threads');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
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

  // ---- Reply quotes (text selection → the composer's quote list) ----
  // Each "Reply" asks the composer to add one quote to the card above its
  // input. The composer owns the list from then on and writes each quote as a
  // leading `<reply_context>` line on send, so there is no reply state to
  // hold here — only the id-keyed requests, each removed once the composer
  // has applied it. A FIFO: two "Reply" clicks in one render keep both, in
  // order.
  const [quoteRequests, setQuoteRequests] = useState<QuoteRequest[]>([]);
  const quoteRequestIdRef = useRef(0);
  const handleQuoteRequestsApplied = useCallback((requestIds: number[]) => {
    setQuoteRequests((current) => acknowledgeQuoteRequests(current, requestIds));
  }, []);

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
    quoteRequestIdRef.current += 1;
    const request = { id: quoteRequestIdRef.current, text: selectionPopup.text };
    setQuoteRequests((current) => [...current, request]);
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
  const allowSendBeforeReady = !!projectSessionId && !runtimeReady;
  // "The health poller GAVE UP", which `!runtimeReady` does not say — that is
  // also every ordinary boot. Only the composer notice reads it, to tell a probe
  // that has not answered yet from one that keeps failing.
  const runtimeUnreachable = useRuntimeConnectionStore((s) => s.status === 'unreachable');
  // E1: the features this session's runtime serves. A pi session has no
  // rewind and no on-demand compaction, so their controls do not render.
  const runtimeCanRewind = useRuntimeSupports('session.rewind');
  const runtimeCanCompact = useRuntimeSupports('session.compact');
  const { data: session, isFetched: sessionFetched } = useRuntimeSession(sessionId);
  // useSessionSync is the SINGLE source of truth for messages (matches OpenCode SolidJS).
  // It fetches on first access, then SSE events keep it up to date.
  // No React Query fallback — prevents stale refetches from overwriting live data.
  const localSync = useSessionSync(
    sessionState ? '' : sessionId,
    savedHistoryScope ? { kortixSessionScope: savedHistoryScope, savedChild: true } : undefined,
  );
  // The page's `useSession` runs with `subscribeMessages: false`, so its
  // `messages` is a render-time snapshot and the page does not re-render per
  // streamed delta. The live rows are read HERE, where they are drawn.
  const liveSessionMessages = useSessionMessages(sessionState ?? DETACHED_SESSION_MESSAGES, {
    throttleMs: TRANSCRIPT_THROTTLE_MS,
  });
  const {
    messages: hookMessages,
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
  const syncMessages = sessionState ? liveSessionMessages : hookMessages;
  const messages = syncMessages.length > 0 ? syncMessages : undefined;
  const messagesLoading = syncMessagesLoading;
  // Who wrote each user message. A one-person session stays unlabelled.
  const { user: viewer } = useAuth();
  // Only a user message adds an author, so only user messages key the refetch.
  const userMessageIds = useMemo(
    () => (messages ?? []).filter((m) => m.info.role === 'user').map((m) => m.info.id),
    [messages],
  );
  const newestUserMessageId = userMessageIds.at(-1) ?? '';
  const { data: messageAuthors, refetch: refetchMessageAuthors } = useSessionMessageAuthors(
    projectId,
    projectSessionId,
    newestUserMessageId,
  );
  const transcriptAuthors = useMemo(
    () => resolveTranscriptAuthors(userMessageIds, messageAuthors),
    [userMessageIds, messageAuthors],
  );
  // A session two or more people can open reads as a group chat from its first
  // prompt: every author shows, the viewer included. Same cache as the header.
  const { data: sessionParticipants } = useSessionParticipants(projectId, projectSessionId);
  const groupChat = transcriptAuthors.multiAuthor || !!sessionParticipants?.multi_user;
  // Project sessions use the server-side project agent roster. Non-project
  // sessions fall back to OpenCode's directory-scoped runtime discovery.
  const { data: agents } = useRuntimeAgents({ directory: session?.directory, projectId });
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
  // A `no_reply` prompt runs no turn: it draws no Sending/Queued chip and no
  // Thinking row. Its bubble still comes from `queuedSyntheticMessages`.
  const agentPrompts = useMemo(() => promptInbox.prompts.filter(awaitsAgent), [promptInbox.prompts]);
  // Every user message and queued prompt on screen wants an author. The ledger
  // records a delivered id a moment after the runtime shows it, and a prompt
  // someone else just queued is newer than the cached answer: while any id is
  // unattributed, ask again on a short backoff (`AUTHOR_RETRY_DELAYS_MS`).
  const missingAuthors = missingAuthorKey(messageAuthors, [
    ...userMessageIds,
    ...promptInbox.prompts.flatMap((prompt) => [prompt.message_id, prompt.wire_message_id ?? '']),
  ]);
  const authorRetry = useRef<{ key: string; count: number }>({ key: '', count: 0 });
  useEffect(() => {
    if (!missingAuthors) return;
    if (authorRetry.current.key !== missingAuthors) authorRetry.current = { key: missingAuthors, count: 0 };
    const delay = AUTHOR_RETRY_DELAYS_MS[authorRetry.current.count];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      authorRetry.current.count += 1;
      void refetchMessageAuthors();
    }, delay);
    return () => clearTimeout(timer);
  }, [missingAuthors, messageAuthors, refetchMessageAuthors]);
  /**
   * What the first prompt's attachment strip should say before runtime delivery.
   *
   * Browser upload completes before prompt acceptance. The undelivered row
   * carries names and reports a real failed send through `last_error`.
   */
  const firstPromptUploadStatus = useMemo((): AttachmentUploadStatus | undefined => {
    const row = promptInbox.prompts.find((p) => (p.attachments?.length ?? 0) > 0);
    if (!row) return undefined;
    // `state`, never `last_error` alone: the API writes `last_error` on rows
    // it keeps `queued` and retries, and never clears it on success — read
    // as a failure it turned every transient retry into "upload failed"
    // (review finding, 2026-09-05).
    return row.state === 'failed'
      ? { state: 'failed', ...(row.last_error ? { message: row.last_error } : {}) }
      : undefined;
  }, [promptInbox.prompts]);

  /**
   * The one place that issues a stop/cancel for this session's run, whether
   * through the mounted `sessionState` hook or the fallback raw mutation.
   * Both branches resolve a real `AbortSettlement` (never throwing — see
   * `awaitAbortSettlement`).
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
    void settlement.then((result) => {
      useSessionWorkingStore.getState().settleAbortReceipt(projectSessionId ?? '', Date.now(), result.status);
      if (result.status === 'timed-out' || result.status === 'failed') {
        errorToast(tQueue('stopUnconfirmed'));
      }
    });
    return settlement;
  }, [sessionId, projectSessionId, sessionState, abortSession, tQueue]);

  // ---- Unified model/agent/variant state (1:1 port of SolidJS local.tsx) ----
  const local = useSessionModelSelection({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.default_agent ?? projectConfig?.open_code_default_agent,
  });
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
    defaultAgent: projectConfig?.default_agent ?? projectConfig?.open_code_default_agent,
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
  // The lazy editor acknowledges application. A parent effect can run before
  // that editor mounts and erase a queued edit during the startup handoff.
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
        ...(sessionPrefill.files ? { files: sessionPrefill.files } : {}),
        mode: sessionPrefill.mode ?? ('merge' as const),
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
  const turnOutcome = useSessionTurnOutcome(projectId ?? '', projectSessionId ?? '');

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

  // Read by `handleSend` for its ANCHORING decision only (a send into a running
  // turn must not yank the viewport). Refs, not the values: `handleSend` is a stable callback
  // that a dozen surfaces hold, and adding busy state to its deps would rebuild
  // it on every turn transition. Written in an EFFECT, never during render — a
  // render-phase ref write is what deadlocked the session shell once already.
  const isBusyRef = useRef(false);
  useEffect(() => {
    isBusyRef.current = effectiveBusy;
  }, [effectiveBusy]);

  // Which model answered each turn, and what Kortix billed for it, from the
  // gateway's request record. The transcript and the model selector name the
  // model a turn ASKED for; a fallback chain decides what answers. A request's
  // row is written as the request ends: read again on each new assistant
  // message and at the end of a turn, then once more for its last request.
  const newestAssistantMessageId = useMemo(
    () => (messages ?? []).findLast((m) => m.info.role === 'assistant')?.info.id ?? '',
    [messages],
  );
  const { data: modelUsage, refetch: refetchModelUsage } = useSessionModelUsage(projectId, projectSessionId);
  useEffect(() => {
    if (!newestAssistantMessageId) return;
    // `cancelRefetch: false`: a read already in flight (the mount's own) is the read.
    void refetchModelUsage({ cancelRefetch: false });
    if (effectiveBusy) return;
    const timer = setTimeout(() => void refetchModelUsage(), MODEL_USAGE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [newestAssistantMessageId, effectiveBusy, refetchModelUsage]);
  const servedNotice = useMemo(
    () => servedModelNotice(modelUsage, local.model.currentKey, local.model.list),
    [modelUsage, local.model.currentKey, local.model.list],
  );
  // Not gated on the composer's selection: the modal reports the session.
  const sessionServedModel = useMemo(
    () => servedModelNotice(modelUsage, null, local.model.list),
    [modelUsage, local.model.list],
  );
  const servedModelOfTurn = useMemo(() => turnServedModelResolver(local.model.list), [local.model.list]);

  // WHICH INBOX ROWS ARE ALREADY ON SCREEN — the queued list above the composer
  // (`projectQueueRows`, `QueuedPromptList`) lists only the rest.
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
  /**
   * The transcript's ONE user message, when there is exactly one and this tab
   * did not paint it — the only shape in which a row can be claimed by
   * elimination. See `claimFirstTurnRow`.
   *
   * Whether it has been ANSWERED does not matter, and briefly requiring that it
   * had not was wrong: the stale cached row this exists for outlives the start
   * of the answer by exactly the window the user can see (the row is gone from
   * the server the moment the turn is accepted; the tab learns that one poll
   * later), so the claim has to hold through the first tokens.
   */
  const onlyUserMessage = useMemo(() => {
    const store = useSessionStateStore.getState();
    let only: { id: string; text: string } | null = null;
    let users = 0;
    for (const message of messages ?? []) {
      if (message.info.role !== 'user') continue;
      users += 1;
      if (store.isOptimisticMessage(sessionId, message.info.id)) {
        only = null;
        continue;
      }
      // The bubble's own words: the non-synthetic text parts, joined.
      const text = message.parts
        .filter((part) => isTextPart(part) && !(part as { synthetic?: boolean }).synthetic)
        .map((part) => (part as { text?: string }).text ?? '')
        .join('\n');
      only = { id: message.info.id, text };
    }
    return users === 1 ? only : null;
  }, [messages, sessionId]);
  /**
   * The row whose message is on screen under an id the row has not reported
   * yet — the re-mint window. Claimed by elimination, never by id; every
   * refusal is documented in `claimFirstTurnRow`.
   */
  const firstTurnClaim = useMemo(
    () =>
      claimFirstTurnRow({
        prompts: promptInbox.prompts,
        onlyUserMessage,
        claimedIds: transcriptUserMessageIds,
      }),
    [promptInbox.prompts, onlyUserMessage, transcriptUserMessageIds],
  );
  /**
   * The claim's row ids folded into the SAME set every id-matching consumer
   * reads, so one decision reaches all of them: `queuedSyntheticMessages` stops
   * minting a second bubble, and `projectQueueRows` stops listing the row.
   * Nothing downstream needed changing.
   */
  const transcriptClaimedIds = useMemo(() => {
    if (!firstTurnClaim) return transcriptUserMessageIds;
    const ids = new Set(transcriptUserMessageIds);
    ids.add(firstTurnClaim.rowMessageId);
    if (firstTurnClaim.rowWireMessageId) ids.add(firstTurnClaim.rowWireMessageId);
    if (firstTurnClaim.rowClientMessageId) ids.add(firstTurnClaim.rowClientMessageId);
    return ids;
  }, [transcriptUserMessageIds, firstTurnClaim]);
  // The row names the re-minted id, and it is the ONLY thing that does: the
  // runtime's echo carries no client id, and this tab strips the part ids that
  // would otherwise correlate it. So every prompt in the inbox announces its
  // pairing here — which lets the echo supersede ITS OWN bubble rather than the
  // oldest one in flight, and (when the echo already landed unmatched, which a
  // burst makes the common case) retires that bubble on the spot.
  //
  // An EFFECT, not the memo below that reads the result: `registerOptimisticEcho`
  // writes to the sync store, and a store write during render re-renders every
  // subscriber mid-render. It ran inside the memo until the retire-on-late-alias
  // rule gave it something to write.
  useEffect(() => {
    const store = useSessionStateStore.getState();
    for (const prompt of promptInbox.prompts) {
      if (!prompt.message_id || !prompt.wire_message_id) continue;
      if (prompt.wire_message_id === prompt.message_id) continue;
      store.registerOptimisticEcho(sessionId, prompt.wire_message_id, prompt.message_id);
    }
  }, [promptInbox.prompts, sessionId]);
  // WHAT THE QUEUED LIST ABOVE THE COMPOSER RENDERS — see `projectQueueRows`.
  // This tab's own queued sends add the text as typed, the original files, and
  // a row for the upload window (`queued-draft-store.ts`).
  const queuedDrafts = useQueuedDrafts(sessionId);
  // Inbox rows keyed by the transcript id they will confirm under — the
  // original wire id AND, after a re-mint, the echo — so a painted bubble can
  // find its own row and draw the files that row carries.
  const inboxRowsByMessageId = useMemo(() => {
    const store = useSessionStateStore.getState();
    const byId = new Map<string, SessionPrompt>();
    for (const prompt of promptInbox.prompts) {
      if (!prompt.message_id) continue;
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
    // The bubble claimed by elimination carries its row's files too: hiding the
    // duplicate must not cost the surviving copy what the row alone reports.
    if (firstTurnClaim) {
      const claimed = promptInbox.prompts.find((p) => p.prompt_id === firstTurnClaim.promptId);
      if (claimed) byId.set(firstTurnClaim.messageId, claimed);
    }
    return byId;
    // `messages` is a dependency because the aliases this reads are registered
    // by the effect above, i.e. AFTER the render that first sees a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptInbox.prompts, sessionId, messages, firstTurnClaim]);
  const queueRows = useMemo(
    () =>
      projectQueueRows({
        prompts: promptInbox.prompts,
        transcriptMessageIds: transcriptClaimedIds,
        drafts: queuedDrafts,
      }),
    [promptInbox.prompts, transcriptClaimedIds, queuedDrafts],
  );
  // A posted draft whose row the inbox no longer lists was delivered or
  // removed; nothing reads it again.
  useEffect(() => {
    const listed = new Set<string>();
    for (const prompt of promptInbox.prompts) {
      if (prompt.client_message_id) listed.add(prompt.client_message_id);
    }
    useQueuedDraftStore.getState().prune(sessionId, listed);
  }, [promptInbox.prompts, queuedDrafts, sessionId]);
  // Read by `handleSend` and the queue edit, which are stable callbacks.
  // Written in an effect, never during render — the same rule as `isBusyRef`.
  const queueRowsRef = useRef(queueRows.rows);
  useEffect(() => {
    queueRowsRef.current = queueRows.rows;
  }, [queueRows.rows]);
  const canTakeBackQueue = queueRows.rows.some((row) => row.takeBackEligible);

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
            ? (detail ?? tHardcodedUi.raw('i18nComplete.text3e739b3b4329'))
            : status === 404
              ? tHardcodedUi.raw('i18nComplete.text128773c76940')
              : (detail ?? tHardcodedUi.raw('i18nComplete.text42fcd9dda5f6')),
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
      infoToast(tHardcodedUi.raw('i18nComplete.text2c6041fda32c'), {
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
              onError: () => errorToast(tHardcodedUi.raw('i18nComplete.text8af21acebf14')),
            })}
          >
            {tHardcodedUi.raw('i18nComplete.texta737e54996f8')}
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
      void promptInbox
        .retry(id)
        .catch(() => errorToast(tHardcodedUi.raw('i18nComplete.text4869b2a820dd')));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promptInbox.retry],
  );

  // "Stop and send": the waiting row becomes Quick Queue. The running turn
  // ends after its running tool, then this row runs.
  const handleStopAndSendQueuedMessage = useCallback(
    (id: string) => {
      void promptInbox.interrupt(id).catch(() => errorToast(tQueue('stopAndSendFailed')));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promptInbox.interrupt],
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
  // Cmd/Ctrl+P prints the WHOLE conversation. The shortcut is intercepted
  // because neither half of what printing needs can be done in CSS: the
  // transcript is paged (so the tail would print alone) and its ancestors clip
  // (so one viewport would print). See `use-session-print.ts`.
  const { isPreparing: isPreparingPrint } = useSessionPrint({
    scrollRef,
    hasOlder,
    isLoadingOlder,
    loadOlder,
    enabled: !hideHeader,
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
  /**
   * The runtime is parked on an answer only the user can give.
   *
   * Both lists are already session-scoped above. Either one means OpenCode has
   * stopped inside the turn and is blocked on a reply — the `question` tool, or
   * a tool asking for permission — so the turn row stays `active` and every
   * observer keeps reporting `working` with nothing to bound it but the reader.
   * The shimmer and its clock read that as progress; see
   * `showTurnBusyIndicator` for the measurement.
   *
   * The RAW question list, not `renderedQuestion`: that one is held an extra
   * 320ms past the answer to let the card fade out, and the waiting row must
   * come back the instant the agent is running again, not a third of a second
   * later.
   */
  const awaitingUserInput = pendingQuestions.length > 0 || pendingPermissions.length > 0;
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
  // Quick Queue entries share the turn renderer. The inbox marks their IDs as
  // pending until delivery; a client-minted wire ID does not place a message.
  const queuedSyntheticMessages = useMemo(() => {
    const out: NonNullable<typeof messages> = [];
    for (const prompt of promptInbox.prompts) {
      if (prompt.state === 'failed' && prompt.placement !== 'transcript') continue;
      // Enter sends appear before delivery. Composer entries stay above the input.
      if (!isFirstPromptRow(prompt) && prompt.placement !== 'transcript') continue;
      if (!(prompt.full_text ?? prompt.text).trim() && !prompt.attachments?.length) continue;
      if (prompt.message_id && transcriptClaimedIds.has(prompt.message_id)) continue;
      if (prompt.wire_message_id && transcriptClaimedIds.has(prompt.wire_message_id)) continue;
      const id = prompt.message_id || `queued-${prompt.prompt_id}`;
      const sentAt =
        typeof prompt.client_sent_at_ms === 'number'
          ? prompt.client_sent_at_ms
          : Date.parse(prompt.created_at);
      const createdMs = sentAt;
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
            text: prompt.full_text ?? prompt.text,
          },
        ],
      } as unknown as NonNullable<typeof messages>[number]);
    }
    return out;
  }, [promptInbox.prompts, transcriptClaimedIds, sessionId]);
  const pendingDisplayIds = useMemo(() => {
    const ids = new Set<string>();
    for (const prompt of agentPrompts) {
      if (prompt.message_id) ids.add(prompt.message_id);
      if (prompt.wire_message_id) ids.add(prompt.wire_message_id);
      ids.add(`queued-${prompt.prompt_id}`);
    }
    // A response is stronger evidence than a queue poll that has not caught up.
    for (const message of messages ?? []) {
      if (message.info.role === 'assistant' && message.info.parentID) {
        ids.delete(message.info.parentID);
      }
    }
    return ids;
  }, [agentPrompts, messages]);
  const rawTurns = useMemo(
    () =>
      messages || queuedSyntheticMessages.length > 0
        ? groupMessagesIntoTurns([...(messages ?? []), ...queuedSyntheticMessages], { pendingMessageIds: pendingDisplayIds })
        : [],
    [messages, queuedSyntheticMessages, pendingDisplayIds],
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
  // Two different questions, and they used to be one.
  //
  // WHEN DOES THE STAND-IN STEP ASIDE? The frame the transcript shows the
  // text. Holding it past that stacked a second bubble on top of the real one
  // for the whole text-first window (review finding, 2026-09-05).
  //
  // WHEN IS THE PREVIEW FORGOTTEN? Only once the transcript's message carries
  // the attachments it promised — the runtime streams the text part first and
  // the file parts seconds later, and forgetting on text alone was what left
  // the real bubble with no tiles for those seconds. Until then the preview's
  // file identities and names are handed to the real turn, which draws them as
  // finished tiles with no upload chrome, so the strip never blinks out. See
  // `first-prompt-handover.ts`.
  const transcriptShowsFirstPrompt = useMemo(
    () => transcriptCarriesFirstPrompt(turns, 0),
    [turns],
  );
  const previewAttachmentCount = firstPromptPreview?.files.length ?? 0;
  const transcriptCarriesFirstPromptFiles = useMemo(
    () => transcriptCarriesFirstPrompt(turns, previewAttachmentCount),
    [turns, previewAttachmentCount],
  );
  // A RELEASE IS A LATCH. The transcript's first message briefly has no parts
  // while the store swaps the optimistic copy for the runtime's echo (~176 ms
  // as the file parts land, on video 2026-09-06); a live boolean brought the
  // stand-in back at full opacity over the dimmed real turn for those frames.
  // Once released, the real turn owns the prompt — see
  // `resolveFirstPromptHandover`.
  const [firstPromptReleased, setFirstPromptReleased] = useState(false);
  /**
   * THIS COMPONENT'S OWN COPY of the first prompt, kept past the store's.
   *
   * Two things read `useFirstPromptPreviewStore`, and they need it for
   * different lengths of time. The BOOT SHELL (and the route, which pins the
   * shell while a preview exists) needs it only until the transcript shows the
   * prompt — one frame longer and the shell's copy dissolves over the real
   * bubble during the crossfade, two bubbles for the length of the fade
   * (measured 2026-09-08: both stand-ins at full opacity, ~200 ms). This
   * component needs the TEXT for longer: the runtime's echo arrives as an info
   * frame with its text part following separately, and on the project-home
   * path nothing bridges the two (the producer POSTed a durable row, not an
   * optimistic message), so the bubble drew nothing for that gap — the blank
   * thread on the 2026-09-06 recording.
   *
   * So the store keeps its original, short life — cleared the frame the
   * transcript carries the prompt — and the longer life is local: a snapshot
   * this component holds until the prompt is SETTLED (answered, or the session
   * is finished with it: idle, nothing left in the inbox). Local state cannot
   * pin the route's shell, cannot outlive a navigation, and is invisible to
   * every other reader of the store.
   */
  // SETTLED: answered, or the session is finished with it (idle, nothing left
  // in the inbox — Stop, a failure, a delivery that never ran).
  const firstPromptSettled =
    turns.length > 0 &&
    (turns[0].assistantMessages.length > 0 || (!isBusy && promptInbox.prompts.length === 0));
  // Guarded render-phase updates, the same shape as `contentPainted` below:
  // mirror the store's copy while the prompt is live, drop it once settled. The
  // mirror is suppressed once settled, or the two would re-adopt and re-drop
  // each other on every render.
  const [firstPromptKeep, setFirstPromptKeep] = useState<typeof firstPromptPreview>(null);
  if (firstPromptSettled) {
    if (firstPromptKeep) setFirstPromptKeep(null);
  } else if (firstPromptPreview && firstPromptKeep !== firstPromptPreview) {
    setFirstPromptKeep(firstPromptPreview);
  }
  const firstPromptSource = firstPromptPreview ?? firstPromptKeep;
  const handover = resolveFirstPromptHandover({
    hasPreview: !!firstPromptSource,
    transcriptShowsText: transcriptShowsFirstPrompt,
    transcriptCarriesFiles: transcriptCarriesFirstPromptFiles,
    releasedBefore: firstPromptReleased,
    transcriptEmpty: turns.length === 0,
  });
  useEffect(() => {
    if (handover.released && !firstPromptReleased) setFirstPromptReleased(true);
  }, [handover.released, firstPromptReleased]);
  const showFirstPromptPreview = handover.showStandIn;
  // The STORE's copy is forgotten the frame the transcript carries the prompt —
  // the original rule, and the one the shell's crossfade depends on.
  useEffect(() => {
    if (!projectSessionId || !firstPromptPreview) return;
    if (transcriptCarriesFirstPromptFiles) clearFirstPromptPreview(projectSessionId);
  }, [
    projectSessionId,
    firstPromptPreview,
    transcriptCarriesFirstPromptFiles,
    clearFirstPromptPreview,
  ]);

  /** What the real first turn is handed once the stand-in has stepped aside:
   *  the prompt's text and its files' identities and names, so it keeps
   *  drawing the bubble and its tiles through any frame where its own parts
   *  are still streaming. Nothing once the transcript carries the files itself. */
  const firstTurnHandover = useMemo(
    (): { text: string; attachments: ReadonlyArray<SentAttachment> } | undefined => {
      if (!firstPromptSource || !handover.handOverToRealTurn) return undefined;
      return {
        text: firstPromptSource.text,
        attachments: sentAttachmentsOf(firstPromptSource.files),
      };
    },
    [firstPromptSource, handover.handOverToRealTurn],
  );

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
  const pendingPromptsByMessageId = useMemo(() => {
    const byId = new Map<string, SessionPrompt>();
    for (const prompt of agentPrompts) {
      if (prompt.message_id) byId.set(prompt.message_id, prompt);
      if (prompt.wire_message_id) byId.set(prompt.wire_message_id, prompt);
    }
    return byId;
  }, [agentPrompts]);
  // Every id a prompt the inbox is delivering right now can render under,
  // including the synthetic `queued-` id a bubble with no message id uses.
  const deliveringPromptIds = useMemo(() => {
    const ids = new Set<string>();
    for (const prompt of agentPrompts) {
      if (prompt.state !== 'delivering') continue;
      if (prompt.message_id) ids.add(prompt.message_id);
      if (prompt.wire_message_id) ids.add(prompt.wire_message_id);
      ids.add(`queued-${prompt.prompt_id}`);
    }
    return ids;
  }, [agentPrompts]);
  const unrunTurnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const prompt of agentPrompts) {
      if (prompt.message_id) ids.add(prompt.message_id);
      if (prompt.wire_message_id) ids.add(prompt.wire_message_id);
    }
    // …and the id the claimed row is actually on screen under, or the surviving
    // bubble would read as running while the server still holds the prompt.
    if (firstTurnClaim) ids.add(firstTurnClaim.messageId);
    return ids;
  }, [agentPrompts, firstTurnClaim]);
  // The idle send this tab made last (`handleSend`), scoped to its session.
  // While its turn is unanswered it is the working turn even where the
  // projection names none — see `freshSendHint` for the double jump it removes.
  const [freshSend, setFreshSend] = useState<{ sessionId: string; messageId: string } | null>(null);
  const freshSendTurnId = useMemo(() => {
    if (!freshSend || freshSend.sessionId !== sessionId) return null;
    return freshSendHint(
      turns,
      (id) =>
        id === freshSend.messageId || optimisticOriginOf(sessionId, id) === freshSend.messageId,
    );
  }, [freshSend, sessionId, turns, optimisticOriginOf]);
  const workingTurn = useMemo(
    () =>
      resolveWorkingTurn({
        turns,
        hintMessageId: working.turnId ?? freshSendTurnId,
        unrunTurnIds,
      }),
    [turns, working.turnId, freshSendTurnId, unrunTurnIds],
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
   * A completed assistant message can also be an intermediate step. When the
   * working projection still names this turn, its indicator stays here.
   */
  const suppressWorkingTurnBusy = useMemo(() => {
    if (workingTurn.pendingTurnIds.length === 0) return false;
    const wt = turns.find((t) => t.userMessage.info.id === workingTurn.workingTurnId);
    if (!wt || wt.assistantMessages.length === 0) return false;
    const newest = wt.assistantMessages[wt.assistantMessages.length - 1];
    return shouldSuppressWorkingTurnBusy({
      hasPendingTurns: true,
      newestAssistantCompleted: !!(newest.info as { time?: { completed?: number } }).time?.completed,
      workingTurnId: wt.userMessage.info.id,
      activeTurnId: working.turnId,
      pendingDelivery: !!working.pendingDelivery,
      deliveringBelow: workingTurn.pendingTurnIds.some((id) => deliveringPromptIds.has(id)),
    });
  }, [turns, workingTurn, working.turnId, working.pendingDelivery, deliveringPromptIds]);
  /**
   * Is ANY turn going to draw the waiting row?
   *
   * `resolveWorkingTurn` deliberately declines to name a turn in two states,
   * and both are states in which the session is very much working:
   *
   *  - every prompt on screen is still held by the server AND no turn has
   *    assistant content yet — the fresh-session case, where rule 4 has no
   *    "newest turn with content" to fall back to and returns null;
   *  - the fallback landed on a turn whose answer is COMPLETE while queued
   *    prompts wait below it (`suppressWorkingTurnBusy`).
   *
   * Neither is wrong: the shimmer must not sit on a prompt the agent has not
   * reached, nor on a finished answer. But nothing else drew the row either,
   * so the whole surface read as idle while the composer showed Stop — the
   * user's session going INACTIVE with their prompt in flight (dev,
   * 2026-09-06, on video: ~11s of it on the first prompt, ~1s on the second).
   *
   * The row below is that missing fallback. It is the same element and the
   * same wording every other surface uses, and it is already what a session
   * with no turns at all shows.
   */
  // The one working answer the LAST turn card renders (its shimmer). Resolved
  // here, once, so the card never reads the raw slot for a Kortix session —
  // see `resolveLastTurnWorking` for the split and the defect it removes.
  const lastTurnWorking = resolveLastTurnWorking({
    isChildSession,
    // The delay-hidden projection, so the card and the composer settle on the
    // same frame instead of the card flickering 300ms earlier. It is the SAME
    // value the composer's Stop reads: while Stop shows, a Thinking row shows.
    projectionBusy: isBusy,
    rawSlotBusy: getWorkingState(sessionStatus, true),
  });
  const workingTurnHasError = useMemo(() => {
    const wt = turns.find((t) => t.userMessage.info.id === workingTurn.workingTurnId);
    return !!wt && !!resolveTurnError(wt);
  }, [turns, workingTurn.workingTurnId]);
  const someTurnDrawsBusyRow = workingTurnDrawsBusyRow({
    lastTurnWorking,
    workingTurnId: workingTurn.workingTurnId,
    suppressed: suppressWorkingTurnBusy,
    workingTurnHasError,
    isRetrying: !!getRetryInfo(sessionStatus),
    awaitingUser: awaitingUserInput,
  });
  const showFallbackBusyRow =
    lastTurnWorking &&
    !someTurnDrawsBusyRow &&
    // The fallback exists so a busy session never shows zero rows. A session
    // parked on a question is the one case where zero rows is the right
    // answer, so it is excluded here rather than catching the row the working
    // turn just declined to draw.
    !awaitingUserInput &&
    !(
      showFirstPromptPreview &&
      firstPromptSource &&
      queuedSyntheticMessages.length === 0 &&
      turns.length === 0
    );
  const fallbackBusyRowTurnId = useMemo(
    () =>
      fallbackBusyRowAfterTurnId({
        turns,
        pendingTurnIds,
        pendingPromptIds: pendingPromptsByMessageId,
        deliveringPromptIds,
      }),
    [turns, pendingTurnIds, pendingPromptsByMessageId, deliveringPromptIds],
  );
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
              isToolPart(p) &&
              isQuestionTool((p as ToolPart).tool) &&
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
      errorToast(tHardcodedUi.raw('i18nComplete.text8f43efcd9139'), {
        description: formatCommandError(error),
      });
    }
  }, [sessionState, tHardcodedUi]);

  // ============================================================================
  // Send / Stop / Command handlers
  // ============================================================================

  /**
   * The files each send carried, by the message id its bubble was painted
   * under. Its turn draws them by identity until each delivered part renders
   * (`mergeSentAttachments`), so the strip never shrinks while the echo streams.
   */
  const [sentAttachmentsByMessage, setSentAttachmentsByMessage] = useState<
    Record<string, SentAttachment[]>
  >({});
  // A mounted session holds the sent pictures; the last one to unmount revokes them.
  useEffect(() => retainSentAttachmentPreviews(), []);
  const handleSend = useCallback(
    async (
      rawText: string,
      files?: AttachedFile[],
      mentions?: TrackedMention[],
      attachments?: AttachmentSubmission,
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
        /**
         * The inline edit's send. It commits the rewind it staged, so it POSTs
         * at once and never waits behind an earlier Send of this session.
         */
        commitsRewind?: boolean;
        /** Quick Queue paints a transcript bubble; Queue List adds a row above the composer. */
        placement?: 'transcript' | 'composer';
        /** How the prompt reaches a running turn (`composerSendDelivery`). */
        delivery?: SessionPromptDelivery;
      },
    ) => {
      setCommandError(null);

      // Reply quotes are already in `rawText`: the composer prepends each
      // quote as its own `<reply_context>` line (`withReplyQuotes`).
      const text = rawText;

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
      optimisticText = appendSessionRefs(
        optimisticText,
        allOptimisticSessionMentions.map((m) => ({ id: m.value ?? '', title: m.label })),
      );
      if (fileMentionRefs.length > 0) {
        const block = buildFileRefsBlock(fileMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }
      if (agentMentionRefs.length > 0) {
        const block = buildAgentRefsBlock(agentMentionRefs);
        if (block) optimisticText = `${optimisticText}\n\n${block}`;
      }

      // ENTER NEVER INTERRUPTS, AND A QUEUED MESSAGE IS NOT IN THE TRANSCRIPT.
      //
      // While a turn runs — or while anything is already queued, so FIFO holds —
      // the prompt goes to the queued list above the composer
      // (`QueuedPromptList`) and nothing is painted here. It enters the
      // transcript as a normal user message when the runtime echoes it. The
      // draft is written NOW, before the uploads below, so the list shows the
      // message from the keypress.
      //
      // Idle with an empty queue, the bubble is in the transcript from THIS
      // frame, under the wire id the inbox row carries, and the turn runs at
      // once.
      // The files this Send carried, by identity, so the bubble draws finished
      // tiles from the browser's own bytes the moment it paints — the upload
      // already completed (`whenReady`), and the runtime echo merges into the
      // same strip (`mergeSentAttachments`) instead of replacing it.
      if (attachedFiles.length > 0) {
        setSentAttachmentsByMessage((current) => ({
          ...current,
          [messageID]: sentAttachmentsOf(attachedFiles),
        }));
      }
      const placement = overrides?.placement ?? 'transcript';
      const delivery = overrides?.delivery;
      // Placement decides WHERE the send waits: Quick Queue paints its bubble in
      // the transcript now, Queue List draws a row above the composer. Busy
      // state or earlier live rows decide only whether it waits at all.
      const willQueue =
        isBusyRef.current || promptInbox.prompts.some((prompt) => prompt.state !== 'failed');
      const paintTranscript = placement === 'transcript';
      if (!paintTranscript) {
        useQueuedDraftStore.getState().add(sessionId, {
          clientMessageId,
          placement,
          ...(delivery ? { delivery } : {}),
          text: rawText,
          files: attachedFiles,
          createdAtMs: sentAtMs,
          posted: false,
        });
      } else {
        beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);
        // Inbox-backed from THIS tick, before the first `await` below: the row
        // it becomes is durable, and this send's own failure paths are the ONLY
        // things allowed to take the bubble away.
        markOptimisticSendInboxBacked(sessionId, messageID);
        if (!willQueue) {
          // Until this turn has an answer it is the working turn
          // (`freshSendHint`). The bubble glides ONCE to the top of the screen.
          setFreshSend({ sessionId, messageId: messageID });
          anchorTurn(messageID);
        }
      }
      const receiptTurnId = willQueue ? workingTurnIdRef.current : messageID;

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

      // Parts: the text first, then each attachment as a handle-only file part
      // from `whenReady`. The runtime receives files by reference, never bytes.
      const textPrompt = { id: textPartId, type: 'text' as const, text };
      // A Retry of a kept send (`resendHeldSend`, the one caller that passes the
      // send's `clientMessageId`) has no composer draft to return to either.
      const retryingKeptSend = overrides?.clientMessageId !== undefined;
      const markHeldSendFailed = (error: unknown) => {
        const classified = classifySessionError(error);
        // A refusal with a remedy (a plan, a connector) also shows its card.
        if (classified.kind === 'billing' || classified.kind === 'connector') {
          setCommandError(classified);
        }
        useHeldSendFailureStore.getState().setHeldSendFailure(sessionId, messageID, {
          message: sentFailureMessage(error, tComposerAttachments, classified.message),
          send: {
            text,
            files,
            mentions,
            attachments: attachments!,
            overrides: { ...overrides, clientMessageId },
          },
        });
      };
      // `clientMessageId` is the POST's idempotency key, so the row is
      // addressable by exactly the thing this send already holds. A `failed`
      // row with that key is a refusal, never proof the send landed.
      const inboxRowExists = async () => {
        if (!projectId || !projectSessionId) return false;
        const { prompts } = await listSessionPrompts(projectId, projectSessionId);
        return inboxHoldsLivePrompt(prompts, clientMessageId);
      };

      const deliver = async (detached: boolean): Promise<string> => {
        // A detached send (uploads, or an earlier send of this session still
        // delivering) is never taken back after this paint: no composer waits
        // for it, so an upload or POST failure keeps the message, marked failed,
        // with Retry.
        const keepsPainted = detached || retryingKeptSend;
        // The POST waits here until every handed-off upload is ready. The
        // message above is already painted.
        let attachmentParts: SessionPromptPart[] = [];
        if (attachments) {
          try {
            attachmentParts = await attachments.whenReady();
          } catch (err) {
            // An upload failed after the message was painted. Retry restarts the
            // failed uploads and sends again under the same id; finished uploads
            // are not sent again (`retryHeldSend`).
            markHeldSendFailed(err);
            return messageID;
          }
        }
        const parts: SessionPromptPart[] = [textPrompt];
        try {
          parts.push(...promptFileParts(attachedFiles, attachmentParts));
        } catch (err) {
          if (keepsPainted) {
            markHeldSendFailed(err);
            return messageID;
          }
          // Never reached the network — nothing to rehydrate from the server,
          // so just clear busy and drop the optimistic message outright.
          abandonOptimisticSend(sessionId, messageID);
          // The composer puts the draft back in the editor; the list row goes.
          if (!paintTranscript) useQueuedDraftStore.getState().remove(sessionId, [clientMessageId]);
          const classified = classifySessionError(err);
          setCommandError(classified);
          throw err instanceof Error ? err : new Error(classified.message);
        }

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
        textPrompt.text = appendSessionRefs(
          textPrompt.text,
          allSessionMentions.map((m) => ({ id: m.value ?? '', title: m.label })),
        );
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
              attachment_id: p.attachment_id,
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
        // A queued send was never painted into the transcript, so there is no
        // optimistic message to mark dispatched — its row lives in the list
        // above the composer until the runtime echoes it.
        if (paintTranscript) markOptimisticSendDispatched(sessionId, messageID);

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
              placement,
              ...(delivery ? { delivery } : {}),
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
            attachments?.release();
            // The durable row now carries this prompt, so the tab-local draft
            // that held its place in the queued list can stop standing in.
            if (!paintTranscript)
              useQueuedDraftStore.getState().markPosted(sessionId, clientMessageId);
            return { ok: true } as const;
          } catch (cause) {
            // A kept send is settled below: its painted message stays.
            if (keepsPainted) return { ok: false, cause, error: null } as const;
            // Ask the INBOX, not the runtime. This prompt's home is a durable
            // control-plane row; OpenCode's transcript cannot see it until the
            // admission gate delivers it, so a rehydrate always reports it
            // missing and the recovery used to delete the bubble on that answer —
            // while the row was already running. Reported from a live self-host:
            // "it queues the message and starts running it, but doesn't show in
            // the frontend."
            const error = recoverFromSendFailure(sessionId, messageID, cause, {
              classify: classifySessionError,
              inboxRowExists,
            });
            return { ok: false, cause, error } as const;
          }
        })();
        if (!result.ok) {
          if (!result.error) {
            // The message stays. A row the inbox holds means the POST landed and
            // only its response was lost: the send succeeded after all.
            clearSendReceipt(messageID);
            if (await inboxRowExists().catch(() => false)) {
              noteSendReceipt(messageID, receiptTurnId);
              acceptSendReceipt(messageID);
              attachments?.release();
              return messageID;
            }
            markHeldSendFailed(result.cause);
            return messageID;
          }
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
          // The composer puts the draft back in the editor; the list row goes.
          if (!paintTranscript) useQueuedDraftStore.getState().remove(sessionId, [clientMessageId]);
          setCommandError(result.error);
          throw result.cause instanceof Error ? result.cause : new Error(result.error.message);
        }
        return messageID;
      };
      // Every POST of this session leaves in Send order, through the session's
      // delivery chain, keyed by the Kortix session id like the boot shell and
      // project home. A send with uploads, or one behind an earlier send, returns
      // right after its paint, so the composer is free for the next Send. Any
      // other send awaits its POST, and a refusal returns the draft. The inline
      // edit's send (`commitsRewind`) POSTs at once, outside the chain.
      return deliverAfterPaint(projectSessionId ?? sessionId, attachments, deliver, messageID, {
        immediate: overrides?.commitsRewind === true,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionId,
      projectId,
      projectSessionId,
      promptInbox.enqueue,
      promptInbox.prompts,
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
      messages,
      sessionState,
      tComposerAttachments,
    ],
  );

  /**
   * Sends painted here whose uploads failed before the POST, by message id.
   * The message stays in the transcript, marked failed; its Retry sends it
   * again through this mounted instance (`retryHeldSend`, at click time). The
   * store outlives this component, as the painted bubble does.
   */
  const heldSendFailures = useHeldSendFailureStore((state) => state.failuresBySession[sessionId]);
  const resendHeldSend = useCallback(
    (send: HeldSend) =>
      handleSend(send.text, send.files, send.mentions, send.attachments, send.overrides),
    [handleSend],
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
    async (messageId: string, text: string, kept: NormalizedAttachment[] = []) => {
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
            removed === 1
              ? tHardcodedUi.raw('i18nComplete.textcd165519e204')
              : tHardcodedUi('i18nComplete.textba6a7b88050c', { value0: removed }),
            {
              description: tHardcodedUi.raw('i18nComplete.text8190a722b30a'),
            },
          );
        }
        setRewindTarget(null);
        // handleSend surfaces its own failures (commandError card + receipt
        // clear), so a refused send must not wear the rewind toast below —
        // its rejection is swallowed here, not ignored.
        let sendOk = true;
        // This send commits the rewind staged above, so it POSTs at once: it never
        // waits behind an earlier Send still in the session's delivery chain.
        const editSend = { commitsRewind: true };
        // The kept attachments go again: a saved copy as a URL part, a path-only upload as its ref.
        const { files, text: sendText } = editResendAttachments(kept, text);
        const resend = files.length ? files : undefined;
        await handleSend(sendText, resend, undefined, undefined, editSend).catch(() => {
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
        if (sendOk && sessionState.runtimeSessionId) {
          useSessionStateStore.getState().commitSessionRevert(sessionState.runtimeSessionId);
        }
      } catch (error) {
        errorToast(tHardcodedUi.raw('i18nComplete.text810b28e5110c'), {
          description: formatCommandError(error),
        });
      } finally {
        setEditSendPending(false);
      }
    },
    [sessionState, promptInbox.prompts, promptInbox.remove, handleSend, tHardcodedUi],
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
        errorToast(tHardcodedUi.raw('i18nComplete.text57a524b52549'), {
          description: tHardcodedUi.raw('i18nComplete.text45eca4a01ff2'),
        });
      }),
      new Promise((resolve) => setTimeout(resolve, STOP_HOLD_DEADLINE_MS)),
    ]);

    issueSessionCancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, abortSession, issueSessionCancel, promptInbox.hold]);

  // Release the Stop hold for the WHOLE queue at once. `hold(false)` un-pauses
  // every held row on the server (shared across tabs), and the hook clears the
  // paused state on the click (`releaseHeldPrompts`). `resumePending` disables
  // Resume while the release is in flight. A failed release is surfaced: the
  // user has to know the queue is still paused.
  const [resumePending, setResumePending] = useState(false);
  const handleResumeQueue = useCallback(async () => {
    setResumePending(true);
    try {
      await promptInbox.hold(false);
    } catch (error) {
      console.warn('[session-chat] failed to release the prompt inbox hold', error);
      errorToast(tHardcodedUi.raw('i18nComplete.text06619384104c'), {
        description: tHardcodedUi.raw('i18nComplete.text29cc3339fce9'),
      });
    } finally {
      setResumePending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptInbox.hold]);

  // Edit (the pencil) and Up open a queued message in the composer; Submit
  // saves the new words into the same row. Shared with the boot shell, which
  // may hand over an open edit: see `queued-prompt-edit.ts`.
  const queueEdit = useQueuedPromptEdit({
    key: projectSessionId ?? sessionId,
    rows: () => queueRowsRef.current,
    editPrompt: promptInbox.edit,
    setComposerText: (text) =>
      useSessionComposerPrefillStore.getState().setPrefill(sessionId, text, undefined, 'replace'),
    forgetLocalDraft: (clientMessageId) =>
      useQueuedDraftStore.getState().remove(sessionId, [clientMessageId]),
  });

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

  // The parent crumb's destination, resolved the moment the
  // parent session loads. It is a route-cache miss on the `?rs=` branch, so it
  // is warmed below instead of being fetched cold on the click.
  const backToParentHref = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return null;
    const projectRoute = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
    if (!projectRoute) return null;
    const [, projectId, projectSessionId] = projectRoute;
    return parentSessionData.parentID
      ? childSessionHref(`/projects/${projectId}/sessions/${projectSessionId}`, parentSessionData.id)
      : `/projects/${projectId}/sessions/${projectSessionId}`;
  }, [session?.parentID, parentSessionData, pathname]);

  useEffect(() => {
    if (backToParentHref) router.prefetch(backToParentHref);
  }, [backToParentHref, router]);

  // The header breadcrumb's "Home" crumb: the parent session, for a subsession.
  const parentCrumb = useMemo(() => {
    if (!session?.parentID || !parentSessionData) return undefined;
    return {
      onOpen: () => {
        if (backToParentHref) {
          // nav-contract: prefetch-only — the header crumb's contract carries
          // an opaque `onOpen: () => void`, so it cannot render an anchor
          // until that contract carries the href.
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
  const handleOpenCompactionSummary = useCallback(
    (turnId: string, summary: string) => {
      panelRef.current?.openDetail({
        key: `compaction:${turnId}`,
        title: tHardcodedUi.raw('i18nComplete.text9859804cb618'),
        icon: <Layers weight="duotone" className="size-4" />,
        padded: true,
        body: <CompactionSummaryBody summary={summary} />,
      });
    },
    [tHardcodedUi],
  );

  // Stable identities for every handler a memoized `SessionTurn` receives.
  // Several of these close over the live transcript (`handleEditSend` →
  // `handleSend` → `messages`), so their `useCallback` identity changed on
  // every streamed delta and re-rendered every settled turn with it.
  const stableRetryQueued = useStableCallback(handleRetryQueuedMessage);
  const stableRemoveQueued = useStableCallback(handleRemoveQueuedMessage);
  const stableOpenCompactionSummary = useStableCallback(handleOpenCompactionSummary);
  const stablePermissionReply = useStableCallback(handlePermissionReply);
  const stableRewind = useStableCallback(handleRewind);
  const stableEditCancel = useStableCallback(handleEditCancel);
  const stableEditSend = useStableCallback(handleEditSend);

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

  // The queued messages and the one Resume while a Stop holds the queue: their
  // own full-width card above the composer stack, not inside the strip.
  const chatAboveSlot = useMemo(
    () => (
      <QueuedPromptList
        rows={queueRows.rows}
        heldCount={queueRows.heldCount}
        resumePending={resumePending}
        onResume={() => void handleResumeQueue()}
        onEdit={(id) => {
          queueEdit.takeBack(id);
        }}
        onRemove={(id) => void handleRemoveQueuedMessage(id)}
        onRetry={handleRetryQueuedMessage}
        onStopAndSend={effectiveBusy ? handleStopAndSendQueuedMessage : undefined}
        editing={queueEdit.editing}
        onCancelEdit={queueEdit.cancel}
      />
    ),
    [
      queueEdit.editing,
      queueEdit.cancel,
      queueEdit.takeBack,
      queueRows,
      resumePending,
      handleResumeQueue,
      handleRemoveQueuedMessage,
      handleRetryQueuedMessage,
      handleStopAndSendQueuedMessage,
      effectiveBusy,
    ],
  );

  const chatInputSlot = useMemo(
    () => (
      <>
        {/* Connector actions a policy gated for approval — pauses the run
            until the human decides. Self-hides when nothing's pending. */}
        <SessionApprovalPrompt />
        {/* Runtime tool permissions (bash/edit/…) awaiting a decision —
            the turn is blocked inside the runtime and resumes the moment
            a reply lands. Self-hides when nothing's pending. */}
        <SessionPermissionPrompt
          sessionId={sessionId}
          agentName={sessionScopeAgentName}
          permissions={pendingPermissions}
          onReply={handlePermissionReply}
        />
        {renderedQuestion ? (
          <div
            className={cn(
              'w-full overflow-hidden transition-[max-height,opacity,transform] ease-in-out',
              questionPromptVisible
                ? 'duration-slow max-h-130 translate-y-0 opacity-100'
                : 'duration-slow pointer-events-none max-h-0 -translate-y-1 opacity-0',
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
      tHardcodedUi,
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
  // Classify an involuntary page load (discarded tab, or a chunk 404 after a
  // deploy) so the next "my session randomly disconnected" report arrives with
  // its cause attached instead of a shrug. An actionable cause reports to
  // Sentry; a routine browser tab discard only leaves a breadcrumb.
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
    pendingPrompt: allowSendBeforeReady && working.state === 'working',
    pendingDelivery: working.pendingDelivery,
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
    // The route's `/start` is bringing the computer up (or has not answered):
    // the same fact the boot pill above the thread shows.
    starting:
      !!sessionState &&
      (sessionState.stage == null ||
        sessionState.stage === 'provisioning' ||
        sessionState.stage === 'starting'),
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
            <p className="text-muted-foreground text-sm">
              {tHardcodedUi.raw('i18nComplete.text8d0cef2d3405')}
            </p>
            <Button variant="outline" size="sm" onClick={() => retryTranscript()}>
              {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
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
        {/* Cmd+P drains the whole history before the print dialog opens. On a
            long session that is a visible pause, and a keystroke that appears
            to do nothing reads as broken — so it says what it is doing. Hidden
            from the printed page itself (`data-print-hide`). */}
        {isPreparingPrint && (
          <div
            data-print-hide
            role="status"
            className="bg-popover text-muted-foreground fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-4 py-2 text-xs shadow-lg"
          >
            <Loading className="size-3.5 shrink-0" />
            {tHardcodedUi.raw('i18nComplete.text7dac2ca010fe')}
          </div>
        )}

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
            parent={parentCrumb}
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
          servedModel={sessionServedModel}
          billedCost={sessionBilledCost(modelUsage)}
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
                    {/* Print only — `print.css` keeps this hidden on screen.
                        It lives inside the transcript column so a printed PDF
                        opens with the title of the conversation it contains
                        (`session-print-header.tsx`). */}
                    <SessionPrintHeader
                      title={session?.title || 'Untitled'}
                      agentName={composerAgentName}
                    />
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
                            {tHardcodedUi.raw('i18nComplete.text85bf890776a7')}
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
                              {tHardcodedUi.raw('i18nComplete.textf17671d83db0')}
                            </Button>
                          )}
                        {olderPullFailed && !showOlderLoading && (
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-xs">
                              {tHardcodedUi.raw('i18nComplete.textb03a0041ce33')}
                            </span>
                            <Button
                              type="button"
                              variant="outline-ghost"
                              size="sm"
                              onClick={() => void handleLoadOlder()}
                            >
                              {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
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
                          firstPromptSource &&
                          queuedSyntheticMessages.length === 0 && (
                            <OptimisticTurn
                              text={buildOptimisticPromptTextWithUploads(
                                firstPromptSource.text,
                                firstPromptSource.files,
                              )}
                              // Preserve a real failed-send status through the
                              // boot-shell handover without inventing upload progress.
                              // A first prompt held on its uploads carries its own.
                              uploadStatus={firstPromptSource.uploadStatus ?? firstPromptUploadStatus}
                              agentNames={agentNames}
                              onFileClick={openFileInComputer}
                              sessionId={sessionId}
                              busy={turns.length === 0 && lastTurnWorking}
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

                          const confirmedActive = turnIsConfirmedActive({
                            isTurnWorking,
                            turnId: turn.userMessage.info.id,
                            activeTurnId: working.turnId,
                            pendingDelivery: !!working.pendingDelivery,
                          });
                          const pendingPrompt =
                            !confirmedActive && turn.assistantMessages.length === 0
                              ? pendingPromptsByMessageId.get(turn.userMessage.info.id)
                              : undefined;
                          // A queued prompt is not in the runtime transcript yet;
                          // its author still shows (`authorForTurn`).
                          const turnAuthor = authorForTurn(
                            transcriptAuthors,
                            messageAuthors,
                            turn.userMessage.info.id,
                            pendingPrompt?.wire_message_id,
                          );
                          return (
                            <TranscriptTurnRow
                              // ONE element per prompt: keyed by the id the
                              // bubble was FIRST painted under, so the swap to a
                              // re-minted echo id re-renders this node instead
                              // of mounting a new one (opacity keeps animating,
                              // hover state survives, nothing jumps).
                              key={turnRenderKeys.get(turn.userMessage.info.id)}
                              turnId={turn.userMessage.info.id}
                              suppressed={suppressedFailedCompaction}
                              showBusyRow={
                                showFallbackBusyRow &&
                                fallbackBusyRowTurnId === turn.userMessage.info.id
                              }
                              // Queued bubbles STACK: a pending turn right after
                              // another pending turn sits close to it, like a
                              // list of what is waiting — not a turn's width
                              // apart as if each had been answered in between.
                              // (Failed compaction rows need no stacking rule any
                              // more — at most one is visible at a time.)
                              viewportClassName={
                                turnIndex === 0
                                  ? ''
                                  : lastTurnWorking &&
                                      pendingTurnIds.has(turn.userMessage.info.id) &&
                                      pendingTurnIds.has(turns[turnIndex - 1].userMessage.info.id)
                                    ? 'mt-3'
                                    : 'mt-12'
                              }
                              turn={turn}
                              author={turnAuthor}
                              showAuthor={showAuthorName(turnAuthor, groupChat, viewer?.id)}
                              servedModel={servedModelOfTurn(modelUsage, turn.userMessage.info.id)}
                              turnOutcome={turnOutcome}
                              isLast={turn.userMessage.info.id === lastUserMessageId}
                              ownsPlan={turn.userMessage.info.id === planAnchorId}
                              sessionId={sessionId}
                              sessionStatus={sessionStatus}
                              permissions={pendingPermissions}
                              questions={pendingQuestions}
                              agentNames={agentNames}
                              isFirstTurn={turnIndex === 0}
                              // Handed over only once the stand-in has stepped
                              // aside — while it is up it draws these itself.
                              pendingText={turnIndex === 0 ? firstTurnHandover?.text : undefined}
                              pendingAttachments={sentAttachmentsForTurn({
                                sentByMessage: sentAttachmentsByMessage,
                                messageId: turn.userMessage.info.id,
                                originId: optimisticOriginOf(sessionId, turn.userMessage.info.id),
                                isFirstTurn: turnIndex === 0,
                                firstTurnHandover: firstTurnHandover?.attachments,
                                firstTurnSent: firstPromptAttachments(projectSessionId),
                                queuedRowAttachments: inboxRowsByMessageId.get(
                                  turn.userMessage.info.id,
                                )?.attachments,
                              })}
                              uploadStatus={
                                heldSendFailures?.[turn.userMessage.info.id]
                                  ? {
                                      state: 'failed',
                                      message: heldSendFailures[turn.userMessage.info.id].message,
                                      onRetry: () =>
                                        retryHeldSend(
                                          sessionId,
                                          turn.userMessage.info.id,
                                          resendHeldSend,
                                          (error) => classifySessionError(error).message,
                                        ),
                                    }
                                  : turnIndex === 0 && firstTurnHandover?.attachments.length
                                    ? firstPromptUploadStatus
                                    : undefined
                              }
                              sessionWorking={lastTurnWorking}
                              isWorkingTurn={
                                turn.userMessage.info.id === workingTurn.workingTurnId
                              }
                              suppressBusyIndicator={suppressWorkingTurnBusy}
                              awaitingUser={awaitingUserInput}
                              pending={
                                !confirmedActive &&
                                (Boolean(pendingPrompt) ||
                                  pendingTurnIds.has(turn.userMessage.info.id))
                              }
                              pendingPrompt={pendingPrompt}
                              onRetryQueued={stableRetryQueued}
                              onRemoveQueued={stableRemoveQueued}
                              interruptedBeforeRun={interruptedTurnIds.has(
                                turn.userMessage.info.id,
                              )}
                              isCompaction={hasCompaction}
                              onOpenCompactionSummary={
                                panel ? stableOpenCompactionSummary : undefined
                              }
                              providers={providers}
                              commandMessages={commandMessagesRef.current}
                              commands={commands}
                              disableToolNavigation={disableToolNavigation}
                              onPermissionReply={stablePermissionReply}
                              onRewind={stableRewind}
                              editingText={
                                rewindTarget?.messageId === turn.userMessage.info.id
                                  ? rewindTarget.text
                                  : null
                              }
                              editPending={editSendPending || !!sessionState?.rewindPending}
                              onEditCancel={stableEditCancel}
                              onEditSend={stableEditSend}
                              rewindDisabled={
                                !!readOnly ||
                                !runtimeCanRewind ||
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

                    {/* Persisted failures can precede any transcript message (for
                        example, a marketplace install rejected at admission). */}
                    {[
                      ...(turnOutcome.recent_failures ?? []),
                      ...(turnOutcome.last_ended?.end_reason === 'failed' &&
                      !turnOutcome.recent_failures?.some(
                        (failure) => failure.message_id === turnOutcome.last_ended?.message_id,
                      )
                        ? [turnOutcome.last_ended]
                        : []),
                    ].filter((failure) =>
                      !isAbortError(failure.error) &&
                      !failureShownByTurn(failure, turns) &&
                      (!failure.error?.message || failure.error.message !== commandError?.message),
                    ).map((failure) => {
                      const messageId = failure.message_id ?? 'persisted-turn-failure';
                      // Use the SDK's settle window for a cause that may arrive
                      // one frame later, including an unnamed failed last turn.
                      const notice = turnEndNotice({
                        ...turnOutcome,
                        recent_failures: [{ ...failure, message_id: messageId, error: failure.error ?? null }],
                      }, messageId, { hasError: false, isAbort: false });
                      return notice ? (
                        <TurnErrorDisplay
                          key={messageId}
                          errorText={notice.kind === 'unexplained'
                            ? tHardcodedUi.raw('i18nComplete.text73112526c03a')
                            : persistedFailureText(failure.error)}
                          className="mt-2"
                        />
                      ) : null;
                    })}

                    {/* Busy indicator when no turns yet but session is busy */}
                    {commandError && (
                      <TurnErrorDisplay
                        error={commandError}
                        isAbort={isAbortError(commandError.cause)}
                        className="mt-2"
                      />
                    )}
                    {/* Active runtime work can precede its transcript turn. Pending
                        delivery already has a queued status and shows no thinking row. */}
                    {showFallbackBusyRow && fallbackBusyRowTurnId === null && (
                        <SessionBusyIndicator
                          sessionId={sessionId}
                          // Matches the stand-in's row spacing under a bubble
                          // (`OptimisticTurn`), so the crossfade into the real
                          // transcript does not move it. Nothing above it when
                          // the transcript is empty, so no margin there.
                          className={turns.length === 0 ? undefined : 'mt-6'}
                        />
                      )}
                  </div>
                  {/* Spacer — the transcript's anchor space. It is sized from
                      the scroll container so the newest turn
                      can sit at the TOP of the viewport with the answer
                      streaming in beneath it, and it keeps that height when the
                      turn ends — nothing shifts on idle. Height is written
                      directly by use-auto-scroll.ts. */}
                  {/* `data-scroll-spacer`: this box is sized to the viewport so
                      the last turn can sit at the top of it. On paper that is a
                      blank page, so `print.css` removes it by this hook. */}
                  <div ref={spacerElRef} data-scroll-spacer />
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
                    className="animate-in fade-in-0 zoom-in-95 duration-normal origin-bottom px-3 text-xs ease-out has-[>svg]:px-3"
                  >
                    {tHardcodedUi.raw('i18nComplete.textc253f451bdd5')}
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
                      ? 'duration-normal scale-100 opacity-100'
                      : 'duration-fast scale-[0.97] opacity-0',
                  )}
                  onClick={smoothScrollToAbsoluteBottom}
                >
                  <CaretDownIcon className="size-4" />
                </Button>
              </div>
            </div>
          )}

          {readOnly && inputReplacement ? (
            <div className={cn(COMPOSER_SHELL_CLASS, 'pb-4')}>{inputReplacement}</div>
          ) : null}

          {/* Input — hidden in read-only mode (sub-session modal) */}
          {!readOnly && (
            <>
              <SessionChatInput
                // `undefined`, not `true`, once released: the composer's own
                // viewport rule (>= 640px) still decides, so this never forces
                // focus onto a phone keyboard.
                autoFocus={deferComposerFocus ? false : undefined}
                onSend={async (text, files, mentions, attachments, placement) => {
                  if (await queueEdit.save(text)) return;
                  // Enter while a turn runs steers it (D9.1); Cmd/Ctrl+Enter is Queue List.
                  await handleSend(
                    text,
                    files,
                    mentions,
                    attachments,
                    composerSendDelivery(placement ?? 'transcript', isBusyRef.current),
                  );
                }}
                prefill={composerPrefill}
                onPrefillApplied={(id) => {
                  useSessionComposerPrefillStore.getState().clearPrefill(sessionId, id);
                }}
                // Up from the first row takes the queue back; the placeholder
                // says so while there is something to take.
                onArrowUpAtStart={() => queueEdit.takeBack()}
                hint={
                  canTakeBackQueue ? tHardcodedUi.raw('i18nComplete.text03a01dd53ffa') : undefined
                }
                // Editing a queued message: the send saves it back into the
                // queue, so the control says Submit, never Stop.
                submitLabel={queueEdit.editing ? tQueue('submitEdit') : null}
                draftScope={composerDraftScope}
                draftActive={!deferComposerFocus}
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
                modelRequired={!allowSendBeforeReady}
                modelsLoading={providersLoading}
                onContextClick={handleContextClick}
                onCompactClick={runtimeCanCompact ? handleCompactClick : undefined}
                quoteRequests={quoteRequests}
                onQuoteRequestsApplied={handleQuoteRequestsApplied}
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
                lockForApproval={runtimePermissionLocksComposer(pendingPermissions.length, isBusy)}
                onCustomAnswer={handleCustomAnswer}
                questionButtonLabel={renderedQuestion ? questionAction.label : null}
                questionCanAct={questionAction.canAct}
                onQuestionAction={handleQuestionAction}
                aboveSlot={chatAboveSlot}
                inputSlot={chatInputSlot}
                toolbarSlot={chatToolbarSlot}
                servedModel={servedNotice}
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

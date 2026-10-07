/**
 * SessionPage — the full session chat view.
 *
 * The transcript, the runtime's status and the pending questions come from
 * `@kortix/sdk`'s session store (`useSessionSync` reads it, the live stream
 * keeps it current); this page only reads them and adds its optimistic sends.
 *
 * A send goes through the server prompt inbox (`createSessionPrompt`) with
 * agent/model/variant and the upload handles of any files (COR-185): the inbox
 * records the sender, which the shared-session avatars read. A sub-agent's
 * thread sends to that sub-agent's own runtime session.
 */

import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import {
  View,
  FlatList,
  ScrollView,
  Animated,
  Easing,
  Platform,
  RefreshControl,
  StyleSheet,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import {
  KeyboardAvoidingView,
  KeyboardController,
  KeyboardEvents,
  KeyboardGestureArea,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { XIcon, CaretUpIcon, CaretDownIcon } from '@/lib/icons';
import type { SheetRef } from '@/components/kortix/sheet';
import { FLOATING_MENU_CLEARANCE, FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import { ConnectProviderSheet } from '@/components/session/ConnectProviderSheet';
import { ConnectorAuthSheet } from '@/components/session/ConnectorAuthSheet';
import {
  ConnectorHandoffContext,
  type ConnectorHandoffRequest,
} from '@/components/session/tool/shared/connector-handoff-context';
import { ProjectHeaderActions } from '@/components/session/ProjectHeaderActions';
import { SessionThreadTitle } from '@/components/session/SessionThreadTitle';
import { SessionParticipantStack } from '@/components/session/SessionParticipantStack';
import { SessionParticipantsSheet } from '@/components/session/SessionParticipantsSheet';
import { SubAgentHeaderChip } from '@/components/session/SubAgentHeaderChip';
import { SubAgentListSheet } from '@/components/session/SubAgentListSheet';
import { useComposerModels, useProjectDetail, useSessionMessageAuthors, useSessionParticipants } from '@/lib/projects/hooks';
import { messageAvatarPerson, type AvatarPerson } from '@/lib/session/participants';
import { ParticipantAvatar } from '@/components/session/ParticipantAvatar';
import { latestAssistantAgent, threadAgents } from '@/lib/session/composer-config';
import { isModelUnavailable } from '@/lib/session/composer-model';
import { offeredModelCount } from '@/lib/session/model-picker';
import type { SubAgentRelation } from '@/lib/session/sub-agents';
import type { ProjectSession } from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';
import { playSound } from '@/lib/sounds';
import { SessionChangeRequests } from '@/components/session/SessionChangeRequests';
import { requestPushPermissionOnce } from '@/lib/notifications/registration';
import { Icon } from '@/components/ui/icon';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';
import { LinearGradient } from 'expo-linear-gradient';

import {
  addOptimisticMessage,
  markOptimisticAccepted,
  removeOptimisticMessage,
  removeSessionMessage,
  sessionMessageIds,
  sessionRows,
  sessionStatus as readSessionStatus,
  setLocalSessionStatus,
  usePendingPermissions,
  usePendingQuestions,
  useSessionStatus,
} from '@/lib/session/session-store';
import { useSessionRuntime } from '@/components/session/SessionRuntime';
import {
  abortRuntimeSession,
  answerPermission,
  answerQuestion,
  executeRuntimeCommand,
  extractSendErrorMessage,
  promptRuntimeMessage,
  rejectQuestion,
  usePermissionSelfHeal,
  useQuestionSelfHeal,
  useSessionPrompts,
  useSessionStreamConnected,
  useRuntimeCommands,
  useRuntimeConfig,
  useRuntimeSession,
  useRuntimeSessions,
  useSessionMessages,
  useSessionSync,
  useSessionWorkingStore,
} from '@kortix/sdk/react';
import {
  compactionTurnInfo,
  createSessionPrompt,
  deleteSessionPrompt,
  groupMessagesIntoTurns,
  listSessionPrompts,
  retrySessionPrompt,
  sessionPromptActions,
  type SessionPrompt,
  type SessionPromptDelivery,
  resolveWorkingTurn,
} from '@kortix/sdk';
import * as Crypto from 'expo-crypto';
import { promptParts } from '@/lib/session/prompt-parts';
import type { Turn, QuestionRequest, MessageWithParts, Session } from '@/lib/session/types';
import {
  reuseStableTurns,
  shouldFollowNewTurn,
  shouldReleaseStickOnTouch,
} from '@/lib/session/stable-turns';
import {
  GLIDE_MAX_MS,
  GLIDE_QUIET_MS,
  OWN_SCROLL_MS,
  SEND_GLIDE_ARM_MS,
  TURN_TOP_OFFSET,
  anchorSpan,
  chevronVisible,
  distanceFromEnd,
  isAtEnd,
  momentumFollows,
  nextFollow,
  pickAnchorIndex,
  roomUnderNewestTurn,
  scrollEnd,
  settleMotion,
  turnTopGap,
} from '@/lib/session/auto-scroll';
import { mintWireMessageId } from '@/lib/session/wire-message-id';
import { failedSendRows, sendIdsFor, useFailedSendStore, useFailedSends, type SendIds } from '@/lib/session/failed-sends';
import { optimisticUserParts } from '@/lib/session/optimistic-parts';
import { draftKey } from '@/lib/session/composer-draft';
import {
  buildSessionRefsBlock,
  editResendAttachments,
  interruptedTurnIds,
  rewindHiddenMessageIds,
  webSpace,
  type MessageAttachment,
} from '@/lib/session/user-message';
import {
  hasCompactionTurn as findCompactionTurn,
  isSuppressedFailedCompaction,
  lastCompactionTurnIndex as findLastCompactionTurnIndex,
  suppressWorkingTurnBusy as findSuppressWorkingTurnBusy,
  transcriptBusyRowVisible,
  type TurnBodyTurn,
} from '@/lib/session/turn-body';
import { unsupportedFeatureMessage, useRuntimeSupports } from '@/lib/session/runtime-capabilities';
import { useToast } from '@/components/kortix/toast-provider';
import { pinnedPermission } from '@/lib/session/permission-prompt';
import { useTabStore } from '@/stores/tab-store';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import { queueHeaderLabel, queueRowCaption } from '@/lib/session/queue-undo';
import { useSessionPromptRequestStore } from '@/stores/session-prompt-request-store';
import { useSandboxContext } from '@/contexts/SandboxContext';
import type { Command } from '@/lib/session/runtime-data';
import { useResolvedConfig } from '@/lib/session/local-config';
import { log } from '@/lib/logger';

import {
  SessionChatInput,
  type PromptOptions,
  type SendAttachments,
  type TrackedMention,
} from './SessionChatInput';
import { SandboxHealthPill } from './SandboxHealthPill';
import { LiveUpdatesPausedPill } from './LiveUpdatesPausedPill';
import { useLiveUpdates } from '@/hooks/useLiveUpdates';
import { OLDER_HOLD_POSITION_MS, olderHistoryControl } from '@/lib/session/older-history';
import { useRouter } from 'expo-router';
import { SessionTurn } from './SessionTurn';
import { SessionBusyIndicator } from './session-busy-indicator';
import { CompactionMarker } from './turn/compaction-divider';
import { QuestionPrompt } from './QuestionPrompt';
import { PermissionPromptCard } from './PermissionPromptCard';
import { MarkdownActionsProvider } from '@/components/markdown/inline-code';
import { ToolFilePreviewHost, useToolFilePreviewStore } from '@/components/session/tool/shared/navigation';
import { SandboxPreviewSheet } from '@/components/session/SandboxPreviewSheet';
import { ActivitySheetHost } from '@/components/session/turn/activity-sheet';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';
import { ProjectHero } from '@/components/session/ProjectHero';

interface SessionPageProps {
  sessionId: string;
  /** The session's project: its model catalog is the thread's model list. */
  projectId?: string;
  /** The project session row's id: a send with files posts to its prompt inbox (COR-185). */
  projectSessionId?: string;
  onBack: () => void;
  onOpenDrawer?: () => void;
  /** Opens the session actions sheet (floating chrome's `···`). */
  onOpenRightDrawer?: () => void;
  /**
   * Opens the same sheet, straight to its Rename view (COR-140) — what the
   * header's title tap uses, so there is exactly one rename implementation.
   * Omit while the sheet has nowhere to open yet (the project session row
   * has not resolved) — the same guard `onOpenRightDrawer` already needs.
   */
  onRenamePress?: () => void;
  /**
   * The title to show in the header (COR-140): `sessionDisplayTitle` of the
   * project session, when the caller has resolved one. Falls back to the
   * runtime session's own `title` — the only signal available for a
   * sub-agent thread, which has no project-session row of its own.
   */
  sessionTitle?: string;
  /**
   * The open session's sub-agent relation (COR-162): `subAgentRelation` over
   * the project session rows — the relation the session list nests by. The
   * caller computes it; this page only renders it.
   */
  subAgentRelation?: SubAgentRelation | null;
  /** The project sessions this session spawned (`subAgentsOf`), for the "N sub-agents" sheet. */
  subAgents?: ProjectSession[];
  /** Opens a project session — the parent, or a sub-agent picked in the sheet. */
  onOpenProjectSession?: (session: ProjectSession) => void;
  /** The model sheet's Agent tab `+`: starts a new session that creates an agent. */
  onCreateAgent?: () => void;
  /** The agent the project session was created with (`agent_name`): the composer's agent until a pick. */
  boundAgentName?: string | null;
  /** True when the right drawer is currently open — swaps the grid icon for an X */
  isRightDrawerOpen?: boolean;
}

// Module-level empty values: a `?? []` default creates a new array on every
// render and defeats every memo downstream.
function frozenEmpty<T>(): T[] {
  return Object.freeze([]) as unknown as T[];
}
const EMPTY_QUESTIONS = frozenEmpty<QuestionRequest>();
const EMPTY_TURNS = frozenEmpty<Turn>();
const EMPTY_SESSIONS = frozenEmpty<Session>();
const EMPTY_COMMANDS = frozenEmpty<Command>();
const EMPTY_IDS = frozenEmpty<string>();
const EMPTY_PROJECT_SESSIONS = frozenEmpty<ProjectSession>();
const EMPTY_PROMPTS = frozenEmpty<SessionPrompt>();

/** Returns the previous array while its elements are reference-equal to `next`. */
function useShallowStableArray<T>(next: T[]): T[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev !== next && (prev.length !== next.length || prev.some((item, i) => item !== next[i]))) {
    ref.current = next;
  }
  return ref.current;
}

// FlatList window. The render unit is a whole turn, so the window is kept
// small. The first `INITIAL_TURNS_TO_RENDER` cells stay mounted for the life
// of the list (VirtualizedList keeps its initial region), so that count stays
// low; opening a thread jumps to the end instead of rendering every turn.
const INITIAL_TURNS_TO_RENDER = 4;

/** The transcript re-renders at most once per this interval while a reply streams. */
const TRANSCRIPT_RENDER_INTERVAL_MS = 64;

/** A keyboard motion with no end event ends after this (a keyboard animation takes ~250 ms). */
const KEYBOARD_MOTION_MAX_MS = 1000;

/** How long a pull-to-refresh shows its spinner: the re-read is one bounded tail page. */
const PULL_REFRESH_SPINNER_MS = 800;

/** Keeps the first visible turn in place while older turns prepend (COR-144). */
const MAINTAIN_FIRST_VISIBLE = { minIndexForVisible: 0 } as const;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 } as const;
/**
 * iOS: the list draws past its bottom edge. The keyboard is Liquid Glass and
 * shows what lies under it; the list ends at the keyboard, so without this
 * only the flat page is under the keyboard and it reads as a solid panel.
 * The later rows now draw under the keyboard, as in Messages. Layout and
 * scroll geometry do not change.
 */
const LIST_DRAWS_UNDER_KEYBOARD = Platform.OS === 'ios' ? ({ overflow: 'visible' } as const) : undefined;

function readSavedScrollOffset(sessionId: string): number {
  const saved = useTabStore.getState().tabStateById[sessionId] as { scrollOffset?: number } | undefined;
  return typeof saved?.scrollOffset === 'number' ? saved.scrollOffset : 0;
}

function SessionPageImpl({ sessionId, projectId, projectSessionId, onBack, onOpenDrawer, onOpenRightDrawer, onRenamePress, sessionTitle, subAgentRelation: subAgentRelationValue, subAgents, onOpenProjectSession, onCreateAgent, boundAgentName, isRightDrawerOpen }: SessionPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;
  const insets = useSafeAreaInsets();
  // Top inset for the message list. The chrome is the floating menu button
  // only (the static header bar is gone, COR-140): the list would start under
  // the status bar and that button — inset it below them
  // (FLOATING_MENU_CLEARANCE, where the top fade ends).
  const listTopInset = insets.top + FLOATING_MENU_CLEARANCE;
  // The bottom area rests above the home indicator (`insets.bottom`). While
  // the keyboard is up the indicator is covered, so the inset collapses with
  // the keyboard's progress: the composer then sits its own 12pt (`pb-3`) above
  // the keyboard, the same gap as the project home composer (design.md §5).
  const bottomInset = insets.bottom;
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomAreaStyle = useAnimatedStyle(() => ({
    paddingBottom: bottomInset * (1 - keyboardProgress.value),
  }));
  // Height of the composer (or the question card), without the inset above.
  // It is the offset of the list's drag-to-dismiss: the keyboard starts to
  // follow the finger at the top of the composer, as in Messages, not at the
  // top of the keyboard. It changes on every line wrap of the draft, so it is
  // not this page's state: only `ComposerGestureArea` renders again.
  const bottomAreaHeightRef = useRef(0);
  const setGestureOffsetRef = useRef<((height: number) => void) | null>(null);
  // Per session: two threads can be mounted in the stack at once, and the
  // offset is registered under this id.
  const composerInputNativeID = `composer-input-${sessionId}`;
  const handleBottomAreaLayout = useCallback((e: LayoutChangeEvent) => {
    const height = Math.round(e.nativeEvent.layout.height);
    bottomAreaHeightRef.current = height;
    setGestureOffsetRef.current?.(height);
  }, []);
  // The composer floats over the list: the list runs to the bottom edge and
  // scrolls behind it. The list's end padding is the height the composer
  // covers: the composer area (pill, queue, chips, input) plus the inset
  // under it, the same expression as `bottomAreaStyle`. It runs on the UI
  // thread: a line wrap or a keyboard frame renders nothing.
  const composerAreaHeight = useSharedValue(0);
  const composerAreaHeightRef = useRef(0);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  const endPaddingStyle = useAnimatedStyle(() => ({
    height: composerAreaHeight.value + bottomInset * (1 - keyboardProgress.value),
  }));
  // The project drawer's bottom-bar fade (`ProjectLeftDrawer` `fadeHeight`:
  // inset + 16pt gap + 44pt controls + 36pt above them), at half its height.
  const composerFadeHeight = (insets.bottom + DRAWER_FADE_HEIGHT) * COMPOSER_FADE_SCALE;
  /** The end padding as the room reads it (the UI thread's last value). */
  const endPaddingNow = useCallback(
    () => composerAreaHeightRef.current + bottomInsetRef.current * (1 - keyboardProgress.value),
    [keyboardProgress],
  );
  const { sandboxUrl } = useSandboxContext();
  // Declared early: `handleStop` (below) needs it for a failed-abort toast.
  const toast = useToast();
  const flatListRef = useRef<FlatList>(null);
  // Saved scroll offset: read once per session, not subscribed. Subscribing
  // re-rendered the whole thread on every persisted offset write.
  const savedScrollOffset = useMemo(() => readSavedScrollOffset(sessionId), [sessionId]);
  const lastSavedOffsetRef = useRef(savedScrollOffset);
  const currentOffsetRef = useRef(savedScrollOffset);
  const restoredSessionIdRef = useRef<string | null>(null);




  // The bound session's runtime (`SessionRuntimeProvider`): the SDK confirmed
  // it ready, points every runtime call at it and keeps its live stream open.
  // Null for a frame after the sandbox switches in, and on the debug screens.
  const runtime = useSessionRuntime();
  // `useSession` returns a new object on every render. Event handlers read the
  // latest one here, so they keep their identity and the memoized transcript
  // and composer do not render again. Render output reads `runtime` itself.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const runtimeReady = !!runtime?.switched;
  // This thread shows a sub-agent of the session, in its own runtime session.
  // Unknown root (still resolving) reads as the root thread.
  const rootSessionId = runtime?.runtimeSessionId ?? null;
  const isSubThread = rootSessionId !== null && rootSessionId !== sessionId;
  // A sub-agent whose runtime refused a message (it takes prompts on the
  // session's root only): the thread stays readable, its composer is off.
  const [subThreadReadOnly, setSubThreadReadOnly] = useState(false);
  useEffect(() => setSubThreadReadOnly(false), [sessionId]);

  // Session metadata
  const { data: session } = useRuntimeSession(runtimeReady ? sessionId : '');
  const { data: allSessions = EMPTY_SESSIONS } = useRuntimeSessions(runtimeReady);

  // The transcript, from the SDK: the saved copy first, one tail read once the
  // runtime is bound, then the live stream. The newest page only: `loadOlder`
  // pulls the next older page (COR-144).
  const kortixSessionScope = projectId && projectSessionId ? `${projectId}/${projectSessionId}` : undefined;
  // The session stream (R5.3): while it is up, the SDK's tail and ask polls
  // stand down — the box's ring replays what a reconnect missed.
  const streamConnected = useSessionStreamConnected(projectId ?? '', projectSessionId ?? '');
  const { hasOlder, isLoadingOlder, loadOlder, retryTranscript } = useSessionSync(sessionId, {
    kortixSessionScope,
    streamConnected,
    networkEnabled: runtimeReady,
    savedChild: isSubThread,
    // The rows are read below, paced: a streamed delta does not re-render this hook.
    subscribeMessages: false,
  });
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // Live stream health (COR-144): "Last update … ago" in the header and the
  // "Live updates paused · Reconnect" pill above the composer.
  const liveUpdates = useLiveUpdates();

  // Pull to refresh (Jay, 2026-09-23): re-reads this session's transcript
  // (the SDK's tail reconcile) — the chat refreshes, the page does not
  // remount. Only a pull shows the spinner.
  const [pulling, setPulling] = useState(false);
  const pullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePullRefresh = useCallback(() => {
    haptics.tap();
    setPulling(true);
    retryTranscript();
    if (pullTimerRef.current) clearTimeout(pullTimerRef.current);
    pullTimerRef.current = setTimeout(() => setPulling(false), PULL_REFRESH_SPINNER_MS);
  }, [retryTranscript]);
  useEffect(
    () => () => {
      if (pullTimerRef.current) clearTimeout(pullTimerRef.current);
    },
    [],
  );

  // The rows, at most once per 64 ms: applying every 16 ms stream batch
  // saturated the JS thread and blocked tab switches and drawer opens while
  // the assistant was streaming.
  const storeMessages = useSessionMessages(
    { projectId: projectId ?? '', sessionId: projectSessionId ?? '', runtimeSessionId: sessionId },
    { throttleMs: TRANSCRIPT_RENDER_INTERVAL_MS },
  );
  // A failed send is not in the transcript (the server never had it): it
  // stays in the thread from its own store, with "Not sent · Try again".
  const failedSends = useFailedSends(sessionId);
  const safeMessages = useMemo(() => {
    const failed = failedSendRows(sessionId, failedSends);
    return failed.length > 0 ? [...storeMessages, ...failed] : storeMessages;
  }, [sessionId, storeMessages, failedSends]);
  const sessionStatus = useSessionStatus(sessionId);
  const pendingQuestions = usePendingQuestions(sessionId);
  const pendingPermissions = usePendingPermissions(sessionId);

  // Is the thread working? The session's own thread reads the SDK's projection
  // over the server's turn (`useSession().isBusy`, the rule web uses): a status
  // frame lost while the app was in the background cannot leave it working. A
  // sub-agent thread has no turn of its own, so its stream status decides, as
  // it does before the runtime is bound.
  const streamBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const isBusy = runtime && !isSubThread ? runtime.isBusy : streamBusy;
  // The SDK tracks compaction for the session's root (a compaction this device
  // started, or one the runtime reports).
  const isCompacting = !isSubThread && !!runtime?.isCompacting;

  // ── Self-heal: restore pending requests after a reload or a missed event ──
  // A `question.asked` or `permission.asked` frame sent while no stream was up
  // is lost, and the agent then waits on a blocked tool call with nothing
  // above the composer. The SDK re-reads the runtime's pending lists while a
  // question tool (or a gated tool) runs with nothing pending in the store.
  useQuestionSelfHeal(sessionId, safeMessages, { enabled: runtimeReady && !streamConnected });
  usePermissionSelfHeal(sessionId, safeMessages, { enabled: runtimeReady && !streamConnected });

  // ── Message Queue ──────────────────────────────────────────────────────
  const [queuedMessages, setQueuedMessages] = useState<SessionPrompt[]>(EMPTY_PROMPTS);
  // A read with the same rows keeps the previous array, so a poll that finds
  // nothing new renders nothing.
  const setQueueRows = useCallback((prompts: SessionPrompt[]) => {
    setQueuedMessages((prev) => (JSON.stringify(prev) === JSON.stringify(prompts) ? prev : prompts));
  }, []);
  const refreshQueue = useCallback(async () => {
    if (!projectId || !projectSessionId) { setQueueRows(EMPTY_PROMPTS); return; }
    try {
      const { prompts } = await listSessionPrompts(projectId, projectSessionId);
      setQueueRows(prompts);
    } catch (error) {
      log.error('[SessionPage] Could not read prompt inbox:', error);
    }
  }, [projectId, projectSessionId, setQueueRows]);

  // Move pre-upgrade local rows into the durable inbox before removing them.
  useEffect(() => {
    if (!projectId || !projectSessionId) return;
    let cancelled = false;
    void (async () => {
      await useMessageQueueStore.getState().hydrate();
      for (const row of useMessageQueueStore.getState().getSessionMessages(sessionId)) {
        if (cancelled) break;
        try {
          const result = await createSessionPrompt(projectId, projectSessionId, {
            clientMessageId: row.id, messageId: mintWireMessageId({ nowMs: row.timestamp, knownMessageIds: [] }),
            parts: [{ type: 'text', text: row.text }], placement: 'composer',
            clientSentAtMs: row.timestamp, remintOnDelivery: true,
          });
          if (result.state === 'failed') break;
          useMessageQueueStore.getState().remove(row.id);
          void refreshQueue();
        } catch { break; } // Keep this and later rows for the next attempt, in order.
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, projectSessionId, sessionId, refreshQueue]);

  // The SDK's queue (R5.3): every inbox write arrives on the session stream
  // as a `kortix.control.queue` frame, and it polls only while that stream is
  // down. A send and a queue action still read the list at once.
  const sdkQueue = useSessionPrompts(projectId, projectSessionId);
  useEffect(() => {
    setQueueRows(sdkQueue.prompts);
  }, [sdkQueue.prompts, setQueueRows]);
  // One read when the page opens, so the queue paints with the page.
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  // The composer calls this while a turn runs: the running turn reads the
  // message at its next step (`steer`, D9.1). A prompt request from another
  // screen waits for the turn (`queue`).
  const handleEnqueue = useCallback(async (
    text: string,
    options: PromptOptions,
    mentions?: TrackedMention[],
    delivery: SessionPromptDelivery = 'steer',
  ) => {
    if (!projectId || !projectSessionId) {
      toast.error('No project session to queue a prompt');
      throw new Error('No project session to queue a prompt');
    }
    const nowMs = Date.now();
    const clientMessageId = Crypto.randomUUID();
    const messageId = mintWireMessageId({
      nowMs,
      knownMessageIds: sessionMessageIds(sessionId),
    });
    const sessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value);
    const finalText = sessionMentions?.length
      ? `${text}\n\n${buildSessionRefsBlock(sessionMentions.map((m) => ({ id: m.value ?? '', title: m.label })))}`
      : text;
    try {
      const result = await createSessionPrompt(projectId, projectSessionId, {
        clientMessageId, messageId, parts: [{ type: 'text', text: finalText }],
        delivery, clientSentAtMs: nowMs,
        overrides: { agent: options.agent ?? null, model: options.model ?? null, variant: options.variant ?? null },
      });
      if (result.state === 'failed') throw new Error('Prompt delivery was refused');
      void refreshQueue();
    } catch (error) {
      log.error('[SessionPage] Could not queue prompt:', error);
      toast.error('Could not queue the message. Try again.');
      throw error;
    }
  }, [projectId, projectSessionId, sessionId, refreshQueue, toast]);

  // Queue expanded/collapsed state
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [savedInputText, setSavedInputText] = useState('');
  const inputTextRef = useRef('');

  // The first pending question for this session (if any)
  const activeQuestion: QuestionRequest | undefined = pendingQuestions[0];
  const hasQuestion = !!activeQuestion;

  // The bottom area swaps the composer for the question card and back. The
  // swap keeps the keyboard as it was: the new field takes the focus only when
  // the keyboard was up at the swap. So a question never raises the keyboard
  // on its own, and never drops it under a user who is typing. Read during
  // render, before the old field unmounts. False at the first mount.
  const bottomFieldId = activeQuestion?.id ?? null;
  const [bottomSwap, setBottomSwap] = useState({ id: bottomFieldId, keepKeyboard: false });
  if (bottomSwap.id !== bottomFieldId) {
    setBottomSwap({ id: bottomFieldId, keepKeyboard: KeyboardController.isVisible() });
  }

  // Save input text when question appears, clear after it's restored
  useEffect(() => {
    if (hasQuestion) {
      setSavedInputText(inputTextRef.current);
    } else {
      // Question dismissed — savedInputText will be consumed by SessionChatInput's initialText
      // Clear it after a tick so it doesn't persist across future mounts
      const t = setTimeout(() => setSavedInputText(''), 100);
      return () => clearTimeout(t);
    }
  }, [hasQuestion]);

  // The server inbox owns admission and drain, including after an app restart.
  const userSentRef = useRef(false);

  // ── Send / Stop handlers (defined early so queue drain logic can reference them) ──

  const handleSend = useCallback(
    async (
      text: string,
      options: PromptOptions,
      mentions?: TrackedMention[],
      attachments?: SendAttachments,
      /** A retry's ids (`FailedSend`): the same prompt keeps the same ids. */
      retryIds?: Partial<SendIds>,
    ) => {
      // No early return when the runtime is not bound yet: the composer has
      // already cleared its draft and files, so a dropped send would lose
      // them. A root send goes to the prompt inbox, which holds it until the
      // computer is ready; a sub-agent send fails visibly.

      // Clear the tracked input text so it isn't saved when a question appears
      inputTextRef.current = '';
      // The turn this send creates scrolls into view with an animation; the
      // thread then sticks to its end again.
      userSentRef.current = true;

      // Process session mentions — append XML refs (same as frontend)
      let finalText = text;
      const sessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value);
      if (sessionMentions && sessionMentions.length > 0) {
        const block = buildSessionRefsBlock(
          sessionMentions.map((m) => ({ id: m.value ?? '', title: m.label })),
        );
        finalText = `${text}\n\n${block}`;
      }

      // Optimistic user message
      // Wire-format id: the thread sorts messages by id as a string, so the
      // optimistic message must sort after the real ones already present.
      // A retry reuses the failed attempt's ids: the prompt inbox dedupes on
      // `clientMessageId`, so a prompt that already landed does not run twice.
      const { clientMessageId, messageId } = sendIdsFor(retryIds, () => ({
        clientMessageId: Crypto.randomUUID(),
        messageId: mintWireMessageId({ nowMs: Date.now(), knownMessageIds: sessionMessageIds(sessionId) }),
      }));
      // The text part (none for an image-only send), then one part per picked
      // file with its device URI: the bubble shows the local thumbnail until
      // the server echo replaces the message.
      const sentAtMs = Date.now();
      addOptimisticMessage(sessionId, {
        info: { id: messageId, role: 'user', sessionID: sessionId, time: { created: sentAtMs } },
        parts: optimisticUserParts(finalText, attachments?.files ?? [], sentAtMs),
      } as unknown as MessageWithParts);
      setLocalSessionStatus(sessionId, { type: 'busy' });
      // The receipt holds the session's thread on "working" from this instant
      // until the server's turn answers for the send (`useSession().isBusy`).
      const receiptSessionId = isSubThread ? null : (projectSessionId ?? null);
      if (receiptSessionId) {
        useSessionWorkingStore.getState().noteSendReceipt(receiptSessionId, { messageId, turnId: messageId, atMs: sentAtMs });
      }
      void playSound('send');

      // The prompt never reached the runtime: the message leaves the
      // transcript and stays in the thread from the failed-send store, dimmed,
      // with "Not sent · Try again" (COR-143).
      const markFailed = () => {
        userSentRef.current = false;
        setLocalSessionStatus(sessionId, { type: 'idle' });
        if (receiptSessionId) useSessionWorkingStore.getState().clearSendReceipt(receiptSessionId, messageId);
        removeOptimisticMessage(sessionId, messageId);
        useFailedSendStore.getState().markFailed(sessionId, messageId, {
          text,
          options,
          mentions,
          fileParts: attachments?.fileParts,
          localFiles: attachments?.files,
          clientMessageId,
          messageId,
          failedAtMs: sentAtMs,
        });
      };

      // A sub-agent's thread: the prompt inbox delivers to the session's root
      // only, so this prompt goes to the sub-agent's runtime session directly.
      // A runtime that takes prompts on its root only (pi) refuses it: the
      // thread then reads as view-only, with the runtime's own words.
      if (isSubThread) {
        try {
          await promptRuntimeMessage({
            sessionId,
            parts: [{ type: 'text', text: finalText }],
            options: {
              ...(options.model ? { model: options.model } : {}),
              ...(options.agent ? { agent: options.agent } : {}),
              ...(options.variant ? { variant: options.variant } : {}),
            },
            messageID: messageId,
            clientMessageId,
          });
          log.log('[SessionPage] Sub-agent prompt sent');
        } catch (err: any) {
          log.error('[SessionPage] Sub-agent prompt failed:', err?.message || err);
          const status = typeof err?.status === 'number' ? err.status : undefined;
          if (status === 501 || status === 409) {
            // Not a retry-able failure: the runtime never takes it.
            userSentRef.current = false;
            setLocalSessionStatus(sessionId, { type: 'idle' });
            removeOptimisticMessage(sessionId, messageId);
            setSubThreadReadOnly(true);
            toast.error(extractSendErrorMessage(err) || 'This sub-agent takes no messages.');
            return;
          }
          markFailed();
        }
        return;
      }

      // The server prompt inbox, carrying the upload handles of any files. The
      // optimistic message's id is the prompt's `messageId`, so the echo
      // replaces the bubble. The server delivers it once the runtime is ready.
      try {
        if (!projectId || !projectSessionId) throw new Error('No project session to send to');
        const result = await createSessionPrompt(projectId, projectSessionId, {
          clientMessageId,
          messageId,
          parts: promptParts(finalText, attachments?.fileParts ?? []),
          overrides: {
            agent: options.agent ?? null,
            model: options.model ?? null,
            variant: options.variant ?? null,
          },
          clientSentAtMs: sentAtMs,
        });
        if (result.state === 'failed') throw new Error('Prompt delivery was refused');
        // The inbox holds it: the bubble stays until the delivered echo.
        markOptimisticAccepted(sessionId, messageId);
        useSessionWorkingStore.getState().acceptSendReceipt(projectSessionId, messageId, Date.now());
        log.log('[SessionPage] Prompt accepted');
        // The first send asks for notification permission, once per install.
        void requestPushPermissionOnce();
      } catch (err: any) {
        log.error('[SessionPage] Prompt failed:', err?.message || err);
        markFailed();
      }
    },
    [sessionId, projectId, projectSessionId, isSubThread, toast],
  );

  // "Try again" on a failed send: the failed copy leaves the thread and the
  // same text, options and mentions go out again under the same ids.
  const handleRetrySend = useCallback(
    (messageId: string) => {
      const failed = useFailedSendStore.getState().take(sessionId, messageId);
      if (!failed) return;
      const mentions = failed.mentions as TrackedMention[] | undefined;
      if (failed.fileParts?.length) {
        // Re-posts the same upload handles; nothing uploads again.
        void handleSend(
          failed.text,
          failed.options as PromptOptions,
          mentions,
          { fileParts: failed.fileParts, files: failed.localFiles ?? [] },
          failed,
        );
        return;
      }
      void handleSend(failed.text, failed.options as PromptOptions, mentions, undefined, failed);
    },
    [sessionId, handleSend],
  );

  const handleStop = useCallback(async () => {
    if (!runtimeReady) return;
    // Optimistic idle, same as the success path always showed. On failure
    // (network error or a refused abort) the session is still running on the
    // server — roll the status back and say so, instead of leaving the UI
    // idle for work that never stopped (COR-146).
    const previousStatus = readSessionStatus(sessionId);
    setLocalSessionStatus(sessionId, { type: 'idle' });
    const failed = (reason: unknown) => {
      log.error('[SessionPage] Abort failed:', reason instanceof Error ? reason.message : reason);
      if (previousStatus) setLocalSessionStatus(sessionId, previousStatus);
      toast.error("Couldn't stop. Kortix is still working.");
    };
    try {
      const current = runtimeRef.current;
      if (isSubThread || !current) {
        // A sub-agent's own run: abort that runtime session.
        await abortRuntimeSession(sessionId);
        return;
      }
      // The session's turn: the SDK holds the prompt inbox first, so a queued
      // prompt does not start the next turn, then aborts the run.
      const settlement = await current.cancel();
      if (settlement.status === 'failed') failed(settlement.error);
    } catch (err) {
      failed(err);
    }
  }, [runtimeReady, isSubThread, sessionId, toast]);

  const handleQueueSendNow = useCallback(async (promptId: string) => {
    if (!projectId || !projectSessionId) return;
    try {
      await retrySessionPrompt(projectId, projectSessionId, promptId);
      await refreshQueue();
    } catch (error) {
      log.error('[SessionPage] Could not prioritize prompt:', error);
      toast.error('Could not send this message now. Try again.');
    }
  }, [projectId, projectSessionId, refreshQueue, toast]);

  // Agent/model/variant config — web's inputs, `@kortix/sdk`'s rules.
  // Agents: the project's own, from the Kortix project config (`threadAgents`,
  // the SDK's `selectableProjectAgents`, #8007) — never the sandbox's `/agent`
  // list, which adds the runtime's built-ins. Ready before the sandbox is.
  const projectDetailQuery = useProjectDetail(projectId ?? null);
  const projectConfig = projectDetailQuery.data?.config;
  const rawAgents = useMemo(
    () => (projectConfig ? threadAgents(projectConfig) : undefined),
    [projectConfig],
  );
  // No roster yet (the project config or the sandbox still loading).
  const agentsLoading = !rawAgents;
  // Web defaults the picker to the agent of the latest assistant turn.
  const latestAgent = useMemo(() => latestAssistantAgent(storeMessages), [storeMessages]);
  // Models: the project's list (`useComposerModels`), the same one project home
  // and web show; the sandbox's `/provider` joins it off-gateway.
  const {
    gatewayEnabled,
    providers,
    models,
    modelDefaults,
    isLoading: modelsLoading,
    refetchModelCount,
  } = useComposerModels(projectId ?? null);
  // A gateway project that offers no model: Send opens the connect sheet
  // instead of posting (KRTX-251). Gateway off never blocks.
  const modelUnavailable = isModelUnavailable({
    hasCatalog: gatewayEnabled,
    loading: modelsLoading,
    modelCount: offeredModelCount(models),
  });
  const connectSheetRef = useRef<SheetRef>(null);
  const handleConnectModel = useCallback(() => {
    if (projectId) connectSheetRef.current?.open();
  }, [projectId]);
  // The in-chat connector hand-off (COR-158): one `ConnectorAuthSheet`
  // instance, shared by every `ConnectorConnectRow` in the transcript — same
  // "one shared sheet" shape as `connectSheetRef` above.
  const connectorAuthSheetRef = useRef<SheetRef>(null);
  const [connectorHandoffRequest, setConnectorHandoffRequest] =
    useState<ConnectorHandoffRequest | null>(null);
  const requestConnectorConnect = useCallback((request: ConnectorHandoffRequest) => {
    setConnectorHandoffRequest(request);
    connectorAuthSheetRef.current?.open();
  }, []);
  const connectorHandoffApi = useMemo(
    () => ({ projectId: projectId ?? null, requestConnect: requestConnectorConnect }),
    [projectId, requestConnectorConnect],
  );
  // Only a runtime with a config document (OpenCode) is asked for it; pi
  // has none, and the project's model defaults cover the composer.
  // (the SDK asks only a runtime that lists `session.config`).
  const { data: config } = useRuntimeConfig();
  // A runtime without slash commands (pi) gets no list: no "/" or "#"
  // suggestions and no AutoContinue, so nothing dispatches to /command (E1).
  const canRunCommands = useRuntimeSupports(sandboxUrl, 'session.commands');
  const canRewind = useRuntimeSupports(sandboxUrl, 'session.rewind');
  const { data: runtimeCommands = EMPTY_COMMANDS } = useRuntimeCommands();
  const commands = canRunCommands ? runtimeCommands : EMPTY_COMMANDS;

  const resolved = useResolvedConfig({
    agents: rawAgents,
    boundAgent: boundAgentName,
    latestAgent,
    defaultAgent: projectConfig?.default_agent ?? projectConfig?.open_code_default_agent,
    models,
    providers,
    modelDefaults,
    configModel: config?.model,
  });

  // useResolvedConfig returns new arrays, objects, and setters on every
  // render. Stabilize what the composer receives: arrays by content, setters
  // through a ref that always calls the latest resolved config.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  // A prompt the session actions sheet asks this thread to send (Open change
  // request): sent as the composer sends it — at once when idle, with the
  // composer's agent/model/variant; into the queue while the agent works or a
  // question waits.
  // Keyed by the runtime session id (the actions sheet, on the open thread) or by the
  // project session id (Review's Resolve conflicts, sent before this thread
  // has connected, when only that id is known).
  const promptRequest = useSessionPromptRequestStore((s) =>
    s.request && (s.request.sessionId === sessionId || (!!projectSessionId && s.request.sessionId === projectSessionId))
      ? s.request
      : null,
  );
  useEffect(() => {
    if (!promptRequest) return;
    const store = useSessionPromptRequestStore.getState();
    const request = store.take(sessionId) ?? (projectSessionId ? store.take(projectSessionId) : null);
    if (!request) return;
    if (isBusy || hasQuestion) {
      void handleEnqueue(request.text, {}, undefined, 'queue').catch(() => {});
      return;
    }
    const { agent, modelKey, variant } = resolvedRef.current;
    const options: PromptOptions = {};
    if (agent?.name) options.agent = agent.name;
    if (modelKey) options.model = modelKey;
    if (variant) options.variant = variant;
    void handleSend(request.text, options);
  }, [promptRequest, sessionId, projectSessionId, isBusy, hasQuestion, handleEnqueue, handleSend]);
  const resolvedAgents = useShallowStableArray(resolved.agents);
  const resolvedVariants = useShallowStableArray(resolved.variants);
  const resolvedModel = resolved.model;
  const resolvedProviderID = resolved.modelKey?.providerID;
  const resolvedModelID = resolved.modelKey?.modelID;
  const resolvedModelKey = useMemo(
    () =>
      resolvedProviderID && resolvedModelID
        ? { providerID: resolvedProviderID, modelID: resolvedModelID }
        : null,
    [resolvedProviderID, resolvedModelID],
  );
  const handleAgentChange = useCallback((name: string) => resolvedRef.current.setAgent(name), []);
  const handleModelChange = useCallback(
    (providerID: string, modelID: string) => resolvedRef.current.setModel(providerID, modelID),
    [],
  );
  const handleVariantSet = useCallback((v: string | null) => resolvedRef.current.setVariant(v), []);
  const handleTextChange = useCallback((t: string) => {
    inputTextRef.current = t;
  }, []);

  // Agent names for mention highlighting in user bubbles
  const agentNames = useMemo(() => resolvedAgents.map((a) => a.name), [resolvedAgents]);

  // Mention click handlers
  const handleSessionMention = useCallback((mentionedSessionId: string) => {
    useTabStore.getState().navigateToSession(mentionedSessionId);
  }, []);

  // A file mention or attachment tile opens the transcript's file preview
  // (`ToolFilePreviewHost`, the Recent files sheet), like a tool row's file.
  const handleFileMention = useCallback((path: string) => {
    useToolFilePreviewStore.getState().openPreview(path);
  }, []);

  // ── Edit a sent message ────────────────────────────────────────────────
  // Same mechanism as apps/web `session-chat.tsx` `handleEditSend`: rewind the
  // session to the message (`POST /session/:id/revert`, what the SDK's
  // `useSession().rewind` calls), then send the edited text. The server
  // stages the revert; that send commits it and deletes the reverted messages.
  const [rewindTarget, setRewindTarget] = useState<{ messageId: string; text: string } | null>(null);
  const [editPending, setEditPending] = useState(false);
  const editPendingRef = useRef(false);

  const handleEditStart = useCallback((messageId: string, text: string) => {
    setRewindTarget({ messageId, text });
  }, []);

  const handleEditCancel = useCallback(() => {
    if (editPendingRef.current) return;
    setRewindTarget(null);
  }, []);

  const handleEditSend = useCallback(
    async (messageId: string, text: string, kept: MessageAttachment[] = []) => {
      const current = runtimeRef.current;
      if (!current || !runtimeReady || editPendingRef.current) return;
      editPendingRef.current = true;
      setEditPending(true);
      try {
        await current.rewind(messageId);
      } catch (err: any) {
        // The editor stays open with the draft, so Send can be tried again.
        log.error('[SessionPage] Rewind failed:', err?.message || err);
        // A runtime without rewind answers in its own words.
        toast.error(unsupportedFeatureMessage(err) ?? "Couldn't edit the message. Try again.");
        editPendingRef.current = false;
        setEditPending(false);
        return;
      }
      // Hide the abandoned messages now; the resend below commits the revert
      // server-side.
      for (const id of rewindHiddenMessageIds(sessionRows(sessionId), messageId)) {
        removeSessionMessage(sessionId, id);
      }
      editPendingRef.current = false;
      setEditPending(false);
      setRewindTarget(null);
      const { agent, modelKey, variant } = resolvedRef.current;
      const options: PromptOptions = {};
      if (agent?.name) options.agent = agent.name;
      if (modelKey) options.model = modelKey;
      if (variant) options.variant = variant;
      // The kept attachments go again: a saved copy as a URL part, a path-only upload as its ref.
      const { fileParts, text: sendText } = editResendAttachments(kept, text);
      await handleSend(sendText, options, undefined, { fileParts, files: [] });
    },
    [runtimeReady, sessionId, handleSend, toast],
  );

  // Group messages into turns. Turns whose messages did not change keep their
  // previous object, so memoized SessionTurn rows skip stream renders.
  const prevTurnsRef = useRef<Turn[]>(EMPTY_TURNS);
  const turns = useMemo(
    () => reuseStableTurns(prevTurnsRef.current, groupMessagesIntoTurns(safeMessages)),
    [safeMessages],
  );
  useEffect(() => {
    prevTurnsRef.current = turns;
  }, [turns]);
  // Who can open this session, and who wrote each prompt. A new prompt with
  // no recorded author yet makes the authors hook ask once more.
  const participants = useSessionParticipants(projectId, projectSessionId).data;
  // Every user message and queued prompt on screen wants an author.
  const wantedAuthorIds = useMemo(
    () => [
      ...turns.map((turn) => turn.userMessage.info.id),
      ...queuedMessages.flatMap((prompt) => [prompt.message_id, ...(prompt.wire_message_id ? [prompt.wire_message_id] : [])]),
    ],
    [turns, queuedMessages],
  );
  const messageAuthors = useSessionMessageAuthors(projectId, projectSessionId, wantedAuthorIds).data;
  const viewerId = participants?.participants.find((person) => person.is_viewer)?.user_id;
  // The sender of a message, built once per message while the authors and the
  // participants stay the same: the same object each render keeps the memoized
  // rows from rendering again.
  const senderOf = useMemo(() => {
    const cache = new Map<string, AvatarPerson | null>();
    return (messageId: string) => {
      if (!cache.has(messageId)) {
        cache.set(messageId, messageAvatarPerson(messageAuthors, participants, viewerId, messageId));
      }
      return cache.get(messageId) ?? null;
    };
  }, [messageAuthors, participants, viewerId]);
  // A queued prompt is keyed by its own message id, or by the wire id it was
  // re-minted under; either finds its author.
  const queuedSender = useCallback(
    (prompt: SessionPrompt) =>
      senderOf(prompt.message_id) ?? (prompt.wire_message_id ? senderOf(prompt.wire_message_id) : null),
    [senderOf],
  );
  // A queued prompt runs as its author: only they send it now, and they or a
  // session manager remove it. The API answers 403 to anyone else. The
  // participants list puts the session's owner first; a project manager who is
  // not the owner keeps only their own rows here (the web offers them Remove).
  const managesSession = participants?.participants[0]?.is_viewer === true;
  const queuedActions = useCallback(
    (prompt: SessionPrompt) => sessionPromptActions(prompt, { userId: viewerId, managesSession }),
    [viewerId, managesSession],
  );
  // The last turn as displayed. Turns are sorted for display, and store order
  // can differ, so the spacer and pending questions follow this id.
  const lastTurnId = turns.length > 0 ? turns[turns.length - 1].userMessage.info.id : undefined;
  const isFreshSession = turns.length === 0;
  // User messages a Stop stranded before a step ran under them (web: `interruptedTurnIds`).
  // Stable by content: `turns` changes on every stream delta, and a new Set
  // would re-render every row.
  const interruptedIdList = useShallowStableArray(
    useMemo(() => [...interruptedTurnIds(turns, isBusy)], [turns, isBusy]),
  );
  const interruptedIds = useMemo(() => new Set(interruptedIdList), [interruptedIdList]);
  // Web refuses a rewind while the runtime is busy or prompts are still queued.
  // A runtime without rewind (pi) never offers Edit, and a sub-agent's thread
  // does not either: a rewind belongs to the session's own conversation.
  const rewindDisabled =
    !canRewind || isSubThread || isBusy || queuedMessages.length > 0 || editPending || !runtimeReady;
  const showFreshHero = isFreshSession && !hasQuestion && queuedMessages.length === 0 && !isBusy;
  const heroOpacity = useRef(new Animated.Value(showFreshHero ? 1 : 0)).current;
  // The hero stays mounted only while it shows or fades out: its logo shader
  // and tilt sensor run while mounted, even at opacity 0.
  const [heroMounted, setHeroMounted] = useState<boolean>(showFreshHero);
  if (showFreshHero && !heroMounted) setHeroMounted(true);

  useEffect(() => {
    Animated.timing(heroOpacity, {
      toValue: showFreshHero ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      // An interrupted fade-out (the hero shows again) keeps it mounted.
      if (finished && !showFreshHero) setHeroMounted(false);
    });
  }, [showFreshHero, heroOpacity]);

  // ── Transcript scroll physics ──────────────────────────────────────────
  // A port of apps/web `use-auto-scroll.ts`. The decisions are pure and tested
  // in `lib/session/auto-scroll.ts`; this block only feeds them geometry and
  // applies the result to the FlatList.
  //
  // FACT 1 — the room: the footer spacer under the newest reached turn is
  //   max(24, viewport − end padding − span(anchor turn → content end) −
  //   topOffset), so that turn can sit `topOffset` below the top of the list.
  //   The end padding is the height the floating composer covers.
  // FACT 2 — the end: because of the room, `content − viewport` IS that turn
  //   at the top while the answer fits, and the answer's tail once it does not.
  // THE RULE — follow: while on, every layout change puts the list at the end.
  //   Off: a drag; a foreign scroll away from the end (iOS status-bar tap); a
  //   touch on an idle thread (so a card the reader expands opens in place).
  //   On: coming to rest at the end; momentum arriving at the end; a send; the
  //   scroll-to-bottom button; a new turn while the thread was effectively at
  //   its end.
  // THE MOTION — a send or a newly reached turn moves the list in ONE animated
  //   scroll (≤ GLIDE_MAX_MS), re-aimed if the end moves in flight.
  const followRef = useRef(true);
  const draggingRef = useRef(false);
  // True while follow was released only by a touch on the idle thread (no
  // drag since). A new turn not sent by the reader then still scrolls into view.
  const releasedByTouchRef = useRef(false);
  // Whether the last user scroll came to rest at the end.
  const settledAtEndRef = useRef(false);

  // Scroll events inside this window are our own writes, not reader intent.
  const ownScrollUntilRef = useRef(0);
  const markOwnScroll = useCallback((durationMs: number) => {
    ownScrollUntilRef.current = Math.max(ownScrollUntilRef.current, Date.now() + durationMs);
  }, []);
  const isOwnScroll = useCallback(() => Date.now() < ownScrollUntilRef.current, []);

  // Geometry. Heights come from layout events; the offset from scroll events.
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const scrollGeometryRef = useRef({ contentHeight: 0, viewportHeight: 0 });
  const turnHeightsRef = useRef(new Map<string, number>());
  const footerContentHeightRef = useRef(0);
  // The spacer: `room` is the committed value, `roomRef` the latest computed
  // one, `renderedRoomRef` the height the spacer was last laid out at.
  const [room, setRoom] = useState(0);
  const roomRef = useRef(0);
  const renderedRoomRef = useRef(0);
  // The last room handed to `setRoom`. While the keyboard moves, the list's
  // height changes every frame (the `padding` of `KeyboardAvoidingView`), and a
  // room per frame is a page render per frame. A room that shrinks is blank
  // space the smaller list clips anyway, so it waits for the keyboard to stop.
  // A room that grows is set at once: the list cannot scroll past its content.
  const committedRoomRef = useRef(0);
  const keyboardMovingRef = useRef(false);
  const lastAnchorRef = useRef<{ id: string; reached: boolean } | null>(null);

  const glideRef = useRef<{
    target: number;
    quiet: ReturnType<typeof setTimeout> | null;
    cap: ReturnType<typeof setTimeout>;
  } | null>(null);
  const sendGlideUntilRef = useRef(0);

  const [showScrollButton, setShowScrollButton] = useState(false);
  const showScrollButtonRef = useRef(false);
  const setScrollButton = useCallback((visible: boolean) => {
    if (showScrollButtonRef.current === visible) return;
    showScrollButtonRef.current = visible;
    setShowScrollButton(visible);
  }, []);

  const reduceMotion = useReducedMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  // The working turn and the prompts the agent has not reached yet (web
  // `resolveWorkingTurn`). Only the working turn reads the session status.
  const workingTurn = useMemo(
    () => (isBusy ? resolveWorkingTurn({ turns, hintMessageId: null }) : null),
    [isBusy, turns],
  );
  const workingTurnId = workingTurn?.workingTurnId ?? null;
  // Stable by content, so rows do not re-render on every stream delta.
  const pendingTurnIdList = useShallowStableArray(workingTurn?.pendingTurnIds ?? EMPTY_IDS);
  const pendingTurnIds = useMemo(() => new Set(pendingTurnIdList), [pendingTurnIdList]);
  // Web `suppressWorkingTurnBusy` / `someTurnDrawsBusyRow`: when no turn draws
  // the busy row, the transcript end draws it.
  const suppressWorkingBusy = useMemo(
    () => (workingTurn ? findSuppressWorkingTurnBusy(turns as unknown as TurnBodyTurn[], workingTurn) : false),
    [turns, workingTurn],
  );
  const showTranscriptBusyRow = transcriptBusyRowVisible({
    isBusy,
    workingTurnId,
    suppressWorkingTurnBusy: suppressWorkingBusy,
  });
  // TEMP busy-trace (dev only): which signal holds the busy row back at session start.
  useEffect(() => {
    log.log('[busy-trace]', {
      sessionId,
      runtimeReady,
      isBusy,
      status: sessionStatus?.type ?? 'unknown',
      turns: turns.length,
      workingTurnId,
      suppressWorkingBusy,
      showTranscriptBusyRow,
      queued: queuedMessages.length,
    });
  }, [sessionId, runtimeReady, isBusy, sessionStatus?.type, turns.length, workingTurnId, suppressWorkingBusy, showTranscriptBusyRow, queuedMessages.length]);
  // Web `hasCompactionTurn` / `lastCompactionTurnIndex`: a real compaction turn
  // replaces the optimistic marker; failed attempts before the last compaction
  // turn render nothing.
  const hasCompactionTurn = useMemo(() => findCompactionTurn(turns as unknown as TurnBodyTurn[]), [turns]);
  const lastCompactionTurnIndex = useMemo(() => findLastCompactionTurnIndex(turns as unknown as TurnBodyTurn[]), [turns]);

  // Web `TurnViewport` spacing: mt-12 between turns, mt-3 between back-to-back
  // pending turns while the session works.
  const turnGapAt = useCallback(
    (list: readonly Turn[], index: number) =>
      turnTopGap({
        index,
        working: isBusy,
        pending: pendingTurnIds.has(list[index].userMessage.info.id),
        previousPending: index > 0 && pendingTurnIds.has(list[index - 1].userMessage.info.id),
      }),
    [isBusy, pendingTurnIds],
  );

  // Read by the layout callbacks, which must not re-create on every delta.
  const layoutInputsRef = useRef({ turns, turnGapAt, pendingTurnIds, interruptedIds, isBusy, topOffset: 0 });
  layoutInputsRef.current = {
    turns,
    turnGapAt,
    pendingTurnIds,
    interruptedIds,
    isBusy,
    // Floating chrome has no header: the list runs under the status bar and
    // the menu button, so the newest turn pins below them, where the first
    // turn sits.
    topOffset: Math.max(TURN_TOP_OFFSET, listTopInset),
  };

  /** FACT 1: size the room. `measured` is false while the anchor span is unknown. */
  const sizeRoom = useCallback((): { measured: boolean; anchorChanged: boolean } => {
    const { turns: list, turnGapAt: gapAt, pendingTurnIds: pending, interruptedIds: interrupted, isBusy: busy, topOffset } =
      layoutInputsRef.current;
    const viewportHeight = viewportHeightRef.current;
    if (viewportHeight <= 0) return { measured: false, anchorChanged: false };

    let next = 0;
    let anchorChanged = false;
    if (list.length > 0) {
      // Web marks a queued or never-run prompt `data-turn-pending`; the anchor skips those.
      const isPending = (i: number) => {
        const id = list[i].userMessage.info.id;
        return (busy && pending.has(id)) || interrupted.has(id);
      };
      const previous = lastAnchorRef.current;
      const index = pickAnchorIndex(
        list.length,
        isPending,
        previous
          ? { index: list.findIndex((t) => t.userMessage.info.id === previous.id), reached: previous.reached }
          : null,
      );
      const span = anchorSpan({
        anchorIndex: index,
        count: list.length,
        heightAt: (i) => turnHeightsRef.current.get(list[i].userMessage.info.id),
        gapAt: (i) => gapAt(list, i),
        footerHeight: footerContentHeightRef.current,
      });
      // A turn in the span has not laid out yet: keep the room until it has.
      if (span === null) return { measured: false, anchorChanged: false };
      // The composer covers the end of the list: the room is sized in the
      // part above it.
      next = Math.round(roomUnderNewestTurn(viewportHeight - endPaddingNow(), span, topOffset));
      const anchorId = list[index].userMessage.info.id;
      anchorChanged = previous !== null && previous.id !== anchorId;
      lastAnchorRef.current = {
        id: anchorId,
        // Reached once, reached for good.
        reached: (previous?.id === anchorId && previous.reached) || !isPending(index),
      };
    } else {
      lastAnchorRef.current = null;
    }
    roomRef.current = next;
    if (next !== committedRoomRef.current && (!keyboardMovingRef.current || next > committedRoomRef.current)) {
      committedRoomRef.current = next;
      setRoom(next);
    }
    return { measured: true, anchorChanged };
  }, [endPaddingNow]);

  /** The end the list settles at once the latest room is laid out. */
  const settledEnd = useCallback(
    () =>
      scrollEnd(
        contentHeightRef.current - renderedRoomRef.current + roomRef.current,
        viewportHeightRef.current,
      ),
    [],
  );

  const updateScrollButton = useCallback(
    (distance: number) => {
      setScrollButton(
        chevronVisible({ following: followRef.current, distanceFromEnd: distance, room: renderedRoomRef.current }),
      );
    },
    [setScrollButton],
  );

  const setFollow = useCallback(
    (next: boolean) => {
      followRef.current = next;
      if (next) {
        releasedByTouchRef.current = false;
        setScrollButton(false);
      }
    },
    [setScrollButton],
  );

  const settleRef = useRef<() => void>(() => {});
  const settleFrameRef = useRef<number | null>(null);
  // Layout and content-size events of one native layout pass arrive together;
  // one frame lets them all land before the list is moved.
  const scheduleSettle = useCallback(() => {
    if (settleFrameRef.current !== null) return;
    settleFrameRef.current = requestAnimationFrame(() => {
      settleFrameRef.current = null;
      settleRef.current();
    });
  }, []);

  // A taller or shorter composer moves the end padding: settle once, like any layout change.
  const handleComposerAreaLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const height = Math.round(e.nativeEvent.layout.height);
      composerAreaHeightRef.current = height;
      composerAreaHeight.value = height;
      scheduleSettle();
    },
    [composerAreaHeight, scheduleSettle],
  );

  // The keyboard's start and end events bound its motion. The end sets the
  // room the motion held back, then settles once. The fallback ends a motion
  // whose end event does not come.
  useEffect(() => {
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (fallback) clearTimeout(fallback);
      fallback = null;
      if (!keyboardMovingRef.current) return;
      keyboardMovingRef.current = false;
      if (committedRoomRef.current !== roomRef.current) {
        committedRoomRef.current = roomRef.current;
        setRoom(roomRef.current);
      }
      scheduleSettle();
    };
    const start = () => {
      keyboardMovingRef.current = true;
      if (fallback) clearTimeout(fallback);
      fallback = setTimeout(stop, KEYBOARD_MOTION_MAX_MS);
    };
    const subscriptions = [
      KeyboardEvents.addListener('keyboardWillShow', start),
      KeyboardEvents.addListener('keyboardWillHide', start),
      KeyboardEvents.addListener('keyboardDidShow', stop),
      KeyboardEvents.addListener('keyboardDidHide', stop),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      if (fallback) clearTimeout(fallback);
      keyboardMovingRef.current = false;
    };
  }, [scheduleSettle]);

  const cancelGlide = useCallback(() => {
    const glide = glideRef.current;
    if (!glide) return;
    if (glide.quiet) clearTimeout(glide.quiet);
    clearTimeout(glide.cap);
    glideRef.current = null;
    // The glide's own-scroll window was sized for its cap; give it back.
    ownScrollUntilRef.current = Date.now() + OWN_SCROLL_MS;
  }, []);

  /** The glide landed: one settle for whatever changed meanwhile. */
  const endGlide = useCallback(() => {
    if (!glideRef.current) return;
    cancelGlide();
    scheduleSettle();
  }, [cancelGlide, scheduleSettle]);

  /** Start a glide to `target`, or re-aim the one in flight (it keeps its cap). */
  const glideTo = useCallback(
    (target: number) => {
      const inFlight = glideRef.current;
      if (Math.abs(currentOffsetRef.current - target) <= 1) {
        if (inFlight) endGlide();
        return;
      }
      if (inFlight?.quiet) clearTimeout(inFlight.quiet);
      glideRef.current = {
        target,
        quiet: null,
        cap: inFlight ? inFlight.cap : setTimeout(endGlide, GLIDE_MAX_MS),
      };
      markOwnScroll(GLIDE_MAX_MS + OWN_SCROLL_MS);
      flatListRef.current?.scrollToOffset({ offset: target, animated: true });
    },
    [endGlide, markOwnScroll],
  );

  /** FACT 2 + THE RULE: after any layout change, a following list is at the end. */
  const settle = useCallback(() => {
    const { measured, anchorChanged } = sizeRoom();
    if (!followRef.current || viewportHeightRef.current <= 0) return;
    const glideArmed = Date.now() < sendGlideUntilRef.current;
    // A send's glide waits for its turn's own layout, so it starts once, at
    // the right target, instead of starting short and re-aiming.
    if (glideArmed && !measured) return;
    const end = settledEnd();
    const motion = settleMotion({
      distance: Math.abs(currentOffsetRef.current - end),
      end,
      anchorChanged,
      glideArmed,
      glideTarget: glideRef.current?.target ?? null,
      reduceMotion: reduceMotionRef.current,
    });
    if (motion === 'none' || motion === 'wait') return;
    // The armed glide is spent by the first move it could shape.
    sendGlideUntilRef.current = 0;
    if (motion === 'glide') {
      glideTo(end);
      return;
    }
    markOwnScroll(OWN_SCROLL_MS);
    flatListRef.current?.scrollToOffset({ offset: end, animated: false });
  }, [sizeRoom, settledEnd, glideTo, markOwnScroll]);
  settleRef.current = settle;

  useEffect(
    () => () => {
      if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
      cancelGlide();
    },
    [cancelGlide],
  );

  /** Follow from here and go to the end without animation (thread open, a command). */
  const stickToEnd = useCallback(() => {
    setFollow(true);
    cancelGlide();
    scheduleSettle();
  }, [setFollow, cancelGlide, scheduleSettle]);

  /** The scroll-to-bottom button: glide to the end and follow from here. */
  const jumpToEnd = useCallback(() => {
    setFollow(nextFollow(followRef.current, { type: 'jump-to-end' }));
    sizeRoom();
    const end = settledEnd();
    if (reduceMotionRef.current) {
      cancelGlide();
      markOwnScroll(OWN_SCROLL_MS);
      flatListRef.current?.scrollToOffset({ offset: end, animated: false });
      return;
    }
    glideTo(end);
  }, [setFollow, sizeRoom, settledEnd, cancelGlide, markOwnScroll, glideTo]);

  // When turns appear:
  // - a turn the reader just sent glides to the top of the list in one motion;
  // - an opened session follows its end, unless a saved offset is restored;
  // - any other new turn (another client, a trigger) is followed when the
  //   thread was effectively at its end.
  // Later growth is followed by `settle` itself.
  const prevTurnCount = useRef(turns.length);
  const openedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const grew = turns.length > prevTurnCount.current;
    prevTurnCount.current = turns.length;
    if (turns.length === 0) return;
    const firstOpen = openedSessionIdRef.current !== sessionId;
    openedSessionIdRef.current = sessionId;

    if (grew && userSentRef.current) {
      userSentRef.current = false;
      setFollow(nextFollow(followRef.current, { type: 'send' }));
      sendGlideUntilRef.current = Date.now() + SEND_GLIDE_ARM_MS;
      scheduleSettle();
      return;
    }

    if (firstOpen) {
      releasedByTouchRef.current = false;
      settledAtEndRef.current = false;
      lastAnchorRef.current = null;
      turnHeightsRef.current.clear();
      cancelGlide();
      if (savedScrollOffset > 0) {
        followRef.current = false;
        return;
      }
      stickToEnd();
      return;
    }

    if (
      !followRef.current &&
      shouldFollowNewTurn({
        grew,
        releasedByTouch: releasedByTouchRef.current,
        settledNearEnd: settledAtEndRef.current,
      })
    ) {
      stickToEnd();
    }
  }, [turns.length, sessionId, savedScrollOffset, setFollow, scheduleSettle, cancelGlide, stickToEnd]);

  const handleScrollToIndexFailed = useCallback(() => {
    stickToEnd();
  }, [stickToEnd]);

  // Restore scroll position when reopening this tab/session. A restored
  // position does not follow the end.
  useEffect(() => {
    if (restoredSessionIdRef.current === sessionId) return;
    if (savedScrollOffset <= 0) {
      restoredSessionIdRef.current = sessionId;
      return;
    }
    if (turns.length === 0) return;
    const timer = setTimeout(() => {
      followRef.current = false;
      cancelGlide();
      try {
        markOwnScroll(OWN_SCROLL_MS);
        flatListRef.current?.scrollToOffset({
          offset: savedScrollOffset,
          animated: false,
        });
      } finally {
        restoredSessionIdRef.current = sessionId;
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [sessionId, savedScrollOffset, turns.length, cancelGlide, markOwnScroll]);

  // Persist the scroll offset when a user scroll settles and when leaving the
  // session. A thread left while following its end saves 0 (no position), so
  // it reopens at its end, not at an old offset.
  const persistScrollOffset = useCallback(
    (targetSessionId: string, offset: number) => {
      const following = followRef.current;
      if (!following && isOwnScroll()) return;
      const value = following ? 0 : offset;
      if (value === lastSavedOffsetRef.current) return;
      if (value !== 0 && Math.abs(value - lastSavedOffsetRef.current) < 24) return;
      lastSavedOffsetRef.current = value;
      useTabStore.getState().setTabState(targetSessionId, { scrollOffset: value });
    },
    [isOwnScroll],
  );

  useEffect(() => {
    lastSavedOffsetRef.current = savedScrollOffset;
    currentOffsetRef.current = savedScrollOffset;
    return () => {
      persistScrollOffset(sessionId, currentOffsetRef.current);
    };
  }, [sessionId, savedScrollOffset, persistScrollOffset]);

  /** A user scroll came to rest: at the end, follow resumes. */
  const handleScrollRest = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offset = Math.max(0, contentOffset.y || 0);
      currentOffsetRef.current = offset;
      const distance = distanceFromEnd({
        offset,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
      if (!isOwnScroll()) settledAtEndRef.current = isAtEnd(distance);
      const next = nextFollow(followRef.current, { type: 'rest', distanceFromEnd: distance });
      if (next !== followRef.current) setFollow(next);
      updateScrollButton(distance);
      persistScrollOffset(sessionId, offset);
    },
    [sessionId, persistScrollOffset, isOwnScroll, setFollow, updateScrollButton],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false;
      const offset = Math.max(0, event.nativeEvent.contentOffset.y || 0);
      // iOS only: where the scroll comes to rest after finger lift.
      const target = event.nativeEvent.targetContentOffset;
      if (
        momentumFollows({
          offset,
          velocityY: event.nativeEvent.velocity?.y ?? 0,
          targetOffsetY: target ? Math.max(0, target.y || 0) : undefined,
        })
      ) {
        return; // onMomentumScrollEnd decides.
      }
      handleScrollRest(event);
    },
    [handleScrollRest],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // iOS reports the end of our own animated scroll here too.
      if (glideRef.current) {
        endGlide();
        return;
      }
      handleScrollRest(event);
    },
    [endGlide, handleScrollRest],
  );

  // A drag is reader intent: follow off, any glide or armed glide dropped.
  const handleScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
    setFollow(nextFollow(followRef.current, { type: 'drag-begin' }));
    releasedByTouchRef.current = false;
    sendGlideUntilRef.current = 0;
    cancelGlide();
    ownScrollUntilRef.current = 0;
  }, [setFollow, cancelGlide]);

  // A touch on an idle thread releases follow, so a card the reader expands
  // opens in place. While busy, touches keep following the stream.
  const handleListTouchStart = useCallback(() => {
    if (followRef.current && shouldReleaseStickOnTouch({ isBusy })) {
      followRef.current = false;
      releasedByTouchRef.current = true;
    }
  }, [isBusy]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offset = Math.max(0, contentOffset.y || 0);
      const prevOffset = currentOffsetRef.current;
      currentOffsetRef.current = offset;
      const last = scrollGeometryRef.current;
      const geometryChanged =
        contentSize.height !== last.contentHeight || layoutMeasurement.height !== last.viewportHeight;
      scrollGeometryRef.current = { contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height };
      const distance = distanceFromEnd({
        offset,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });

      const wasFollowing = followRef.current;
      const next = nextFollow(wasFollowing, {
        type: 'scroll',
        ours: isOwnScroll(),
        geometryChanged,
        movedTowardEnd: offset >= prevOffset,
        dragging: draggingRef.current,
        distanceFromEnd: distance,
      });
      if (next !== wasFollowing) {
        setFollow(next);
        if (!next) {
          releasedByTouchRef.current = false;
          settledAtEndRef.current = false;
        }
      }
      updateScrollButton(distance);

      // A glide lands when it reaches its target or its events go quiet.
      const glide = glideRef.current;
      if (glide) {
        if (Math.abs(offset - glide.target) <= 1) {
          endGlide();
        } else {
          if (glide.quiet) clearTimeout(glide.quiet);
          glide.quiet = setTimeout(endGlide, GLIDE_QUIET_MS);
        }
      }
    },
    [isOwnScroll, setFollow, updateScrollButton, endGlide],
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      scheduleSettle();
    },
    [scheduleSettle],
  );

  // The viewport shrinks when the keyboard opens.
  const handleListLayout = useCallback(
    (e: LayoutChangeEvent) => {
      viewportHeightRef.current = e.nativeEvent.layout.height;
      scheduleSettle();
    },
    [scheduleSettle],
  );

  const handleTurnLayout = useCallback(
    (id: string, height: number) => {
      const prev = turnHeightsRef.current.get(id);
      if (prev !== undefined && Math.abs(prev - height) < 0.5) return;
      turnHeightsRef.current.set(id, height);
      scheduleSettle();
    },
    [scheduleSettle],
  );

  // Footer content above the spacer (compaction marker, busy row) is part of
  // the span. The wrapper always mounts, so an emptied footer reports 0.
  const handleFooterContentLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const height = e.nativeEvent.layout.height;
      if (Math.abs(footerContentHeightRef.current - height) < 0.5) return;
      footerContentHeightRef.current = height;
      scheduleSettle();
    },
    [scheduleSettle],
  );

  const handleSpacerLayout = useCallback((e: LayoutChangeEvent) => {
    renderedRoomRef.current = e.nativeEvent.layout.height;
  }, []);

  // Question reply/reject handlers
  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      if (!runtimeReady) throw new Error('Runtime not ready');
      await answerQuestion(requestId, answers);
    },
    [runtimeReady],
  );

  // Permission reply — the Deny / Allow always / Allow once prompt under a
  // tool row. Same as apps/web `handlePermissionReply`: no optimistic remove;
  // the prompt leaves the store only once the runtime accepted the reply
  // (`answerPermission`), so a failed reply stays visible.
  const handlePermissionReply = useCallback(
    async (requestId: string, reply: PermissionReply) => {
      if (!runtimeReady) return;
      try {
        await answerPermission(requestId, reply);
      } catch (err: any) {
        log.error('[SessionPage] Permission reply failed:', err?.message || err);
        toast.error("Couldn't send the permission reply. Try again.");
      }
    },
    [runtimeReady, toast],
  );

  // Inline-code file paths in the transcript open the file viewer.
  const markdownActions = useMemo(() => ({ onOpenFile: handleFileMention }), [handleFileMention]);

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      if (!runtimeReady) throw new Error('Runtime not ready');
      await rejectQuestion(requestId);
      handleStop();
    },
    [runtimeReady, handleStop],
  );

  // Command handler — executes a slash command via the server
  const handleCommand = useCallback(
    async (cmd: Command, args?: string) => {
      if (!runtimeReady) return;
      // A command creates its turn through the stream, not optimistically, so
      // it has no send scroll: show the result by sticking to the end.
      stickToEnd();
      setLocalSessionStatus(sessionId, { type: 'busy' });
      try {
        const current = resolvedRef.current;
        await executeRuntimeCommand({
          sessionId,
          command: cmd.name,
          args: args || '',
          ...(current.agent?.name ? { agent: current.agent.name } : {}),
          ...(current.modelKey ? { model: `${current.modelKey.providerID}/${current.modelKey.modelID}` } : {}),
          ...(current.variant ? { variant: current.variant } : {}),
        });
      } catch (err: any) {
        log.error('[SessionPage] Command failed:', err?.message || err);
        setLocalSessionStatus(sessionId, { type: 'idle' });
        // A runtime without slash commands answers in its own words.
        const unsupported = unsupportedFeatureMessage(err);
        if (unsupported) toast.error(unsupported);
      }
    },
    [runtimeReady, sessionId, stickToEnd, toast],
  );

  // Only the working turn (web `resolveWorkingTurn`) receives status and busy;
  // other turns get stable values, so their memoized rows skip stream renders.
  // The room follows the displayed order. Every turn gets `pendingQuestions`
  // (one stable store array) so a pending question tool part is hidden in
  // whichever turn holds it.
  // Whether the working turn's row is inside the viewport: off screen, its
  // shimmer and busy dot matrix stop looping (KRTX-1638). RN requires the
  // callback to be one stable function, so it reads the id through a ref.
  // ponytail: per turn, not per row. A tall working turn whose top is visible
  // counts as on screen; go per row if that measurably costs frames.
  const [workingTurnOnScreen, setWorkingTurnOnScreen] = useState(true);
  const workingTurnIdRef = useRef(workingTurnId);
  workingTurnIdRef.current = workingTurnId;
  // The list re-checks viewability on a data change or the next scroll, but
  // reports only when the viewable SET changes. This effect is the fallback
  // for a working-turn change that leaves the set as it was (a turn appended
  // below the viewport): recompute from the last reported set. Before the
  // first report the set is unknown and the turn counts as on screen.
  const viewableKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = viewableKeysRef.current;
    setWorkingTurnOnScreen(keys == null || workingTurnId == null || keys.has(workingTurnId));
  }, [workingTurnId]);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { key: string }[] }) => {
    const keys = new Set(viewableItems.map((v) => v.key));
    viewableKeysRef.current = keys;
    const id = workingTurnIdRef.current;
    setWorkingTurnOnScreen(id == null || keys.has(id));
  }).current;

  const renderTurn = useCallback(
    ({ item, index }: { item: Turn; index: number }) => {
      const id = item.userMessage.info.id;
      const isWorkingTurn = id === workingTurnId;
      // Web: a failed compaction attempt with a later compaction turn is
      // history — it keeps its row (stable keys, layout) but renders nothing.
      const suppressed =
        lastCompactionTurnIndex > index &&
        isSuppressedFailedCompaction({
          info: compactionTurnInfo(item as never),
          isTurnWorking: isWorkingTurn,
          turnIndex: index,
          lastCompactionTurnIndex,
        });
      // The turn list is read through the ref: depending on `turns` would
      // re-render every row on each stream delta.
      const gap = suppressed ? 0 : turnGapAt(layoutInputsRef.current.turns, index);
      return (
        <View
          style={gap > 0 ? { marginTop: gap } : undefined}
          onLayout={(e) => handleTurnLayout(id, e.nativeEvent.layout.height)}>
          {suppressed ? null : (
          <SessionTurn
            turn={item}
            isWorkingTurn={isWorkingTurn}
            sessionStatus={isWorkingTurn ? sessionStatus : undefined}
            isBusy={isWorkingTurn ? isBusy : false}
            suppressBusyIndicator={isWorkingTurn && suppressWorkingBusy}
            sessionId={sessionId}
            permissions={pendingPermissions}
            pendingQuestions={pendingQuestions}
            onPermissionReply={handlePermissionReply}
            agentNames={agentNames}
            onFileMention={handleFileMention}
            onSessionMention={handleSessionMention}
            commands={commands}
            editingText={rewindTarget?.messageId === id ? rewindTarget.text : null}
            editPending={rewindTarget?.messageId === id ? editPending : false}
            onEditStart={handleEditStart}
            onEditCancel={handleEditCancel}
            onEditSend={handleEditSend}
            rewindDisabled={rewindDisabled}
            queueState={interruptedIds.has(id) ? 'interrupted' : null}
            uploadStatus={failedSends[id] ? { state: 'failed', onRetry: () => handleRetrySend(id) } : undefined}
            sender={senderOf(id)}
            onScreen={isWorkingTurn ? workingTurnOnScreen : true}
          />
          )}
        </View>
      );
    },
    [workingTurnId, lastCompactionTurnIndex, suppressWorkingBusy, turnGapAt, handleTurnLayout, sessionStatus, isBusy, sessionId, pendingPermissions, pendingQuestions, handlePermissionReply, agentNames, handleFileMention, handleSessionMention, commands, rewindTarget, editPending, handleEditStart, handleEditCancel, handleEditSend, rewindDisabled, interruptedIds, failedSends, handleRetrySend, senderOf, workingTurnOnScreen],
  );

  const keyExtractor = useCallback((item: Turn) => item.userMessage.info.id, []);

  const handleToggleQueue = useCallback(() => setQueueExpanded((v) => !v), []);
  const handleRemoveQueued = useCallback(async (promptId: string) => {
    if (!projectId || !projectSessionId) return;
    try {
      const removed = await deleteSessionPrompt(projectId, projectSessionId, promptId);
      await refreshQueue();
      toast.info('Removed from queue', {
        action: {
          label: 'Undo',
          onPress: () => void createSessionPrompt(projectId, projectSessionId, {
            clientMessageId: removed.client_message_id,
            messageId: removed.message_id,
            parts: removed.parts,
            ...(removed.placement ? { placement: removed.placement } : {}),
            ...(removed.overrides ? { overrides: removed.overrides } : {}),
            remintOnDelivery: true,
          }).then(refreshQueue).catch(() => toast.error('Could not restore message. Try again.')),
        },
      });
    } catch (error) {
      log.error('[SessionPage] Could not remove prompt:', error);
      toast.error('Could not remove message. Try again.');
    }
  }, [projectId, projectSessionId, refreshQueue, toast]);
  // The oldest pending permission, pinned above the composer (COR-137 Task 7)
  // — above the queue panel in the same top slot, so it is never missed
  // off-screen while a tool call waits on it.
  const pinnedPermissionRequest = useMemo(() => pinnedPermission(pendingPermissions), [pendingPermissions]);
  const inputSlot = useMemo(() => {
    const slots: React.ReactNode[] = [];
    if (pinnedPermissionRequest) {
      slots.push(
        <PermissionPromptCard
          key={`permission-${pinnedPermissionRequest.id}`}
          permission={pinnedPermissionRequest}
          onReply={handlePermissionReply}
        />,
      );
    }
    if (queuedMessages.length > 0) {
      slots.push(
        <QueuePanel
          key="queue"
          messages={queuedMessages}
          expanded={queueExpanded}
          busy={isBusy}
          onToggle={handleToggleQueue}
          onRemove={handleRemoveQueued}
          onSendNow={handleQueueSendNow}
          isDark={isDark}
          senderOf={queuedSender}
          actionsOf={queuedActions}
        />,
      );
    }
    return slots.length > 0 ? slots : undefined;
  }, [
    pinnedPermissionRequest,
    handlePermissionReply,
    queuedMessages,
    queueExpanded,
    handleToggleQueue,
    isBusy,
    handleRemoveQueued,
    handleQueueSendNow,
    isDark,
    queuedSender,
    queuedActions,
  ]);

  // ── Older history (COR-144) ─────────────────────────────────────────────
  // "Show 100 earlier messages" above the first turn. While a page loads and
  // lays out, `maintainVisibleContentPosition` keeps the turn the reader sees
  // in place as older turns prepend above it. It is on only for that window:
  // always on, it would move the list under the auto-scroll physics above.
  const [holdPosition, setHoldPosition] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
  }, []);
  const handleLoadOlder = useCallback(() => {
    haptics.tap();
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    setHoldPosition(true);
    void loadOlderRef.current()
      .catch((error: unknown) => {
        log.warn('[SessionPage] Loading older messages failed:', error instanceof Error ? error.message : error);
        toast.error('Could not load earlier messages');
      })
      .finally(() => {
        // The native position fix scrolls the list: not the reader's scroll.
        markOwnScroll(OLDER_HOLD_POSITION_MS);
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          setHoldPosition(false);
        }, OLDER_HOLD_POSITION_MS);
      });
  }, [markOwnScroll, toast]);
  const olderControl = olderHistoryControl({ hasOlder, isLoadingOlder, turnCount: turns.length });
  const olderHistoryHeader = useMemo(
    () =>
      olderControl ? (
        <View className="items-center px-4 pb-6">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={olderControl.disabled}
            onPress={handleLoadOlder}>
            <Text>{olderControl.label}</Text>
          </Button>
        </View>
      ) : null,
    [olderControl?.label, olderControl?.disabled, handleLoadOlder],
  );

  const title = sessionTitle ?? (session?.title || 'New Session');

  // ── Sub-agent relationship (COR-162) ────────────────────────────────────
  // The same relation as the session list (`metadata.spawned_by_session`,
  // `lib/session/sub-agents.ts`), computed by `ProjectScreen` over the
  // project session rows. The parent and every sub-agent open through the
  // project-session open path (`onOpenProjectSession`), like a drawer row.
  const subAgentListSheetRef = useRef<SheetRef>(null);
  // The header's avatar stack opens who can open this session.
  const participantsSheetRef = useRef<SheetRef>(null);
  const openParticipantsSheet = useCallback(() => participantsSheetRef.current?.open(), []);
  // No open path, nothing to open: the chip hides rather than dead-ends.
  const headerRelation = onOpenProjectSession ? (subAgentRelationValue ?? null) : null;
  const handleSubAgentRelationPress = useCallback(() => {
    if (!headerRelation) return;
    if (headerRelation.type === 'child') {
      onOpenProjectSession?.(headerRelation.parent);
    } else {
      subAgentListSheetRef.current?.open();
    }
  }, [headerRelation, onOpenProjectSession]);
  const handleSubAgentSelect = useCallback(
    (child: ProjectSession) => onOpenProjectSession?.(child),
    [onOpenProjectSession],
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      className="bg-background"
    >
      {/* Floating menu button — opens the project drawer (every project page
          shows it, Jay 2026-09-16). `fade`: turns scroll under the button and
          the status bar, so they fade out there instead of showing through.
          `title`: the thread's title (COR-140), centred between the
          hamburger and the right-side controls. The legacy static header bar
          this used to branch on (`chrome === 'header'`) rendered nowhere —
          no call site ever passed it — so it was deleted with the
          inline-rename state that belonged only to it (COR-140 remaining
          part). */}
      <FloatingMenuButton
        onPress={onOpenDrawer}
        fade
        title={
          <SessionThreadTitle
            title={title}
            onPress={onRenamePress}
            status={liveUpdates.paused ? liveUpdates.statusLabel : null}
          />
        }
      >
        {/* The agent is picked in the model sheet's Agent tab (Jay,
            2026-09-23), not here. The `···` button opens the session actions
            sheet (COR-140 Task 5) for the open thread's session. A thread
            whose project session has not loaded yet has no `···`, so the
            relation chip (or nothing) holds the edge there. */}
        {onOpenRightDrawer ? (
          <ProjectHeaderActions onOpenMore={onOpenRightDrawer}>
            <SessionParticipantStack participants={participants} onPress={openParticipantsSheet} />
            <SubAgentHeaderChip relation={headerRelation} onPress={handleSubAgentRelationPress} />
          </ProjectHeaderActions>
        ) : (
          <SubAgentHeaderChip relation={headerRelation} onPress={handleSubAgentRelationPress} />
        )}
      </FloatingMenuButton>
      <SubAgentListSheet ref={subAgentListSheetRef} subAgents={subAgents ?? EMPTY_PROJECT_SESSIONS} onSelect={handleSubAgentSelect} />
      <SessionParticipantsSheet ref={participantsSheetRef} participants={participants} />

      {/* Messages + Fresh Session Hero — flat continuation of the page
          surface (the rounded "sheet" card treatment was removed app-wide). */}
      <View style={{ flex: 1 }} className="bg-background">
        {/* iOS: the list's drag-to-dismiss starts at the top of the composer.
            Only the list sits inside: below Android 11 this renders its
            children alone, so the absolute siblings keep the View above. */}
        <ComposerGestureArea
          heightRef={bottomAreaHeightRef}
          setHeightRef={setGestureOffsetRef}
          textInputNativeID={composerInputNativeID}>
        <ConnectorHandoffContext.Provider value={connectorHandoffApi}>
        <MarkdownActionsProvider value={markdownActions}>
        <FlatList
          ref={flatListRef}
          style={LIST_DRAWS_UNDER_KEYBOARD}
          data={turns}
          renderItem={renderTurn}
          keyExtractor={keyExtractor}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
          initialNumToRender={INITIAL_TURNS_TO_RENDER}
          maxToRenderPerBatch={5}
          windowSize={11}
          updateCellsBatchingPeriod={32}
          contentContainerStyle={{ paddingTop: listTopInset }}
          ListHeaderComponent={olderHistoryHeader}
          maintainVisibleContentPosition={holdPosition ? MAINTAIN_FIRST_VISIBLE : undefined}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleListScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onScrollEndDrag={handleScrollEndDrag}
          onTouchStart={handleListTouchStart}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleListLayout}
          // WhatsApp-style: drag the message list down to dismiss the keyboard.
          // 'interactive' makes the keyboard track the finger on iOS; Android
          // falls back to 'on-drag' (closes once the user starts scrolling).
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={handlePullRefresh}
              // Android draws the spinner over the list: start it below the
              // floating header and its fade, not under them.
              progressViewOffset={listTopInset}
            />
          }
          ListFooterComponent={
            <View>
              {/* Footer content above the spacer — part of the anchor span. */}
              <View onLayout={handleFooterContentLayout} className="px-4">
                {/* Web: the change requests this session opened, as cards.
                    A tap opens the Review page's sheet. */}
                {projectId && projectSessionId ? (
                  <SessionChangeRequests
                    projectId={projectId}
                    projectSessionId={projectSessionId}
                    style={turns.length > 0 ? { marginTop: webSpace(6) } : undefined}
                  />
                ) : null}
                {/* Web: the optimistic compaction marker, where the real
                    compaction turn will mount, until that turn exists. */}
                {isCompacting && !hasCompactionTurn ? (
                  <View style={{ marginTop: turns.length > 0 ? webSpace(12) : webSpace(2) }}>
                    <CompactionMarker running />
                  </View>
                ) : null}
                {/* Web: busy with no turn to attach the row to. */}
                {showTranscriptBusyRow ? (
                  <SessionBusyIndicator
                    sessionId={sessionId}
                    style={turns.length > 0 ? { marginTop: webSpace(6) } : undefined}
                  />
                ) : null}
              </View>
              {/* The room (FACT 1): lets the newest turn pin near the top. */}
              <View onLayout={handleSpacerLayout} style={{ height: room }} />
              {/* The height the floating composer covers. */}
              <Reanimated.View testID="session-list-end-padding" style={endPaddingStyle} />
            </View>
          }
          onScrollToIndexFailed={handleScrollToIndexFailed}
        />
        </MarkdownActionsProvider>
        </ConnectorHandoffContext.Provider>
        </ComposerGestureArea>

        {/* The composer floats over the list, at the bottom of this view: the
            keyboard's `padding` above lifts the view, so the composer rides
            on the keyboard. `box-none`: taps reach the list everywhere but
            on the composer. */}
        <View pointerEvents="box-none" style={COMPOSER_OVERLAY}>
        <View testID="session-composer-fade" pointerEvents="none" style={[COMPOSER_FADE, { height: composerFadeHeight }]}>
          <LinearGradient
            colors={[withAlpha(pageBackground, 0), withAlpha(pageBackground, 0.85), withAlpha(pageBackground, 1)]}
            locations={[0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <View pointerEvents="box-none" style={FILL}>
        {heroMounted ? <FreshSessionHero opacity={heroOpacity} visible={showFreshHero} /> : null}

        <ScrollToBottomButton visible={showScrollButton} onPress={jumpToEnd} />
        </View>

      {/* No fill of its own: the fade behind it is the project drawer's. */}
      <Reanimated.View testID="session-composer-block" style={bottomAreaStyle}>
      {/* The composer area, without the inset: the list's end padding. */}
      <View testID="session-composer-area" onLayout={handleComposerAreaLayout}>
      {/* Sandbox health pill — full-width row immediately above the chat
          input. Self-hides (returns null) when the sandbox is reachable,
          so it takes no layout space the rest of the time. */}
      {!hasQuestion && (
        <SandboxHealthPill
          whenReachable={
            liveUpdates.paused ? <LiveUpdatesPausedPill onReconnect={liveUpdates.reconnect} /> : null
          }
        />
      )}

      {/* Bottom area — question prompt OR chat input, above the safe area. */}
        <View onLayout={handleBottomAreaLayout}>
        {hasQuestion && activeQuestion ? (
          <QuestionPrompt
            key={activeQuestion.id}
            request={activeQuestion}
            onReply={handleQuestionReply}
            onReject={handleQuestionReject}
            autoFocus={bottomSwap.keepKeyboard}
          />
        ) : (
          <SessionChatInput
            autoFocus={bottomSwap.keepKeyboard}
            inputNativeID={composerInputNativeID}
            onSend={handleSend}
            onStop={handleStop}
            isBusy={isBusy}
            initialText={savedInputText}
            onTextChange={handleTextChange}
            draftKey={draftKey({ kind: 'session', sessionId })}
            agent={resolved.agent}
            agents={resolvedAgents}
            onAgentChange={handleAgentChange}
            onCreateAgent={onCreateAgent}
            model={resolvedModel}
            models={models}
            modelsLoading={modelsLoading}
            agentsLoading={agentsLoading}
            modelUnavailable={modelUnavailable}
            onConnectModel={handleConnectModel}
            modelKey={resolvedModelKey}
            variant={resolved.variant}
            variants={resolvedVariants}
            onModelChange={handleModelChange}
            onVariantSet={handleVariantSet}
            sessions={allSessions}
            currentSessionId={sessionId}
            sandboxUrl={sandboxUrl}
            projectId={projectId}
            // Files go through the prompt inbox, which delivers to the
            // session's root: a sub-agent's thread sends text only.
            canAttach={Boolean(projectId && projectSessionId) && !isSubThread}
            disabled={subThreadReadOnly}
            placeholder={subThreadReadOnly ? 'This sub-agent takes no messages' : undefined}
            onEnqueue={handleEnqueue}
            commands={commands}
            onCommand={handleCommand}
            inputSlot={inputSlot}
          />
        )}
        </View>
      </View>
      </Reanimated.View>
        </View>
      </View>

      <ConnectProviderSheet
        ref={connectSheetRef}
        projectId={projectId ?? ''}
        onRefetchModels={refetchModelCount}
      />

      <ConnectorAuthSheet ref={connectorAuthSheetRef} request={connectorHandoffRequest} />

      {/* File taps: tool rows (ToolNavigation.openFile), attachment tiles, file mentions */}
      <ToolFilePreviewHost />

      {/* Show/preview taps (ToolNavigation.openPreview): in-session over the
          thread, so a one-tap close returns to the same position (KRTX-602). */}
      <SandboxPreviewSheet />

      {/* The activity summary rows' sheet (ActivityBurst) */}
      {/* Given the connector hand-off so a Connect inside it dismisses the
          activity sheet before the auth sheet opens (never two overlays). */}
      <ActivitySheetHost sessionId={sessionId} markdownActions={markdownActions} connectorHandoff={connectorHandoffApi} />
    </KeyboardAvoidingView>
  );
}

/**
 * Memoized so a parent render with unchanged props does not re-render the
 * thread. Callers pass stable callbacks.
 */
export const SessionPage = React.memo(SessionPageImpl);

const FILL = { flex: 1 } as const;
/** Fills its parent: the overlay over the message area. */
const COMPOSER_OVERLAY = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;
/** The project drawer's bottom-bar fade (`ProjectLeftDrawer`), at the screen's bottom edge. */
const COMPOSER_FADE = { position: 'absolute', right: 0, bottom: 0, left: 0 } as const;
/** The drawer fade's height above the safe-area inset: 16pt gap + 44pt controls + 36pt above them. */
const DRAWER_FADE_HEIGHT = 16 + 44 + 36;
/** The session fade is half the drawer's. */
const COMPOSER_FADE_SCALE = 0.5;

/**
 * The list's `KeyboardGestureArea`, offset by the composer's height. The height
 * is this component's own state, set through `setHeightRef` from the composer's
 * layout: a new height renders only this component, and `children` (the list,
 * built by the page) is the same element, so React skips it.
 */
function ComposerGestureArea({
  heightRef,
  setHeightRef,
  textInputNativeID,
  children,
}: {
  heightRef: React.RefObject<number>;
  setHeightRef: React.RefObject<((height: number) => void) | null>;
  textInputNativeID: string;
  children: React.ReactNode;
}) {
  const [offset, setOffset] = useState(() => heightRef.current);
  setHeightRef.current = setOffset;
  return (
    <KeyboardGestureArea
      style={FILL}
      offset={offset}
      textInputNativeID={textInputNativeID}
      // Android keeps `keyboardDismissMode="on-drag"` below.
      enableSwipeToDismiss={false}>
      {children}
    </KeyboardGestureArea>
  );
}

/** Web: `ease-[cubic-bezier(0.23,1,0.32,1)]` on the scroll-to-bottom button. */
const SCROLL_BUTTON_EASING = ReanimatedEasing.bezier(0.23, 1, 0.32, 1);

/**
 * ScrollToBottomButton — apps/web `session-chat.tsx`'s chevron: a round glass
 * button at the bottom-right corner, directly above the composer, shown once the reader is more than 120pt
 * of content away from the end. Opacity + scale 0.97 → 1, `duration-normal`
 * in, `duration-fast` out. Tapping glides to the end and follows from there.
 *
 * The `secondary` round button with a 1pt `border-border` ring on every
 * platform (Jay, 2026-09-22), so it separates from the prose scrolling under
 * it. No native Liquid Glass: SwiftUI glass cannot carry the border.
 */
function ScrollToBottomButton({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: visible ? MOTION.duration.normal : MOTION.duration.fast,
      easing: SCROLL_BUTTON_EASING,
    });
  }, [visible, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.97 + 0.03 * progress.value }],
  }));

  return (
    <Reanimated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      // Bottom-right, directly above the composer: the 16pt project edge
      // (`px-4`) on the right; 10pt above the composer's top edge, over the
      // list (`zIndex`).
      style={[{ position: 'absolute', right: 16, bottom: 10, zIndex: 20 }, style]}
    >
      <Button
        variant="secondary"
        size="icon"
        className="rounded-full border border-border"
        accessibilityLabel="Scroll to bottom"
        onPress={onPress}
      >
        <Icon as={CaretDownIcon} size={20} />
      </Button>
    </Reanimated.View>
  );
}

/**
 * FreshSessionHero — the Kortix symbol centred in the message area of a
 * chat with no messages yet. Same `ProjectHero` as ProjectHome, so a new
 * chat opens onto the surface the project home showed.
 */
function FreshSessionHero({
  opacity,
  visible,
}: {
  opacity: Animated.Value;
  visible: boolean;
}) {
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    if (visible) {
      translateY.setValue(10);
      Animated.timing(translateY, {
        toValue: 0,
        duration: 380,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [visible, translateY]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      <Animated.View style={{ transform: [{ translateY }] }}>
        <ProjectHero />
      </Animated.View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// QueuePanel — the messages waiting to send, above the text input. Header
// "Up next · N" toggles the list. Each row: the message, a "Send now" pill,
// and a 44pt remove. Remove acts at once; the caller shows a toast with Undo.
// No Clear-all (Jay, 2026-09-25): the per-row X is enough.
// ---------------------------------------------------------------------------

function QueuePanel({
  messages,
  expanded,
  busy,
  onToggle,
  onRemove,
  onSendNow,
  isDark,
  senderOf,
  actionsOf,
}: {
  messages: SessionPrompt[];
  /** The prompt's sender avatar in a shared session, else null. */
  senderOf?: (prompt: SessionPrompt) => AvatarPerson | null;
  /** What the viewer may do to the prompt (`sessionPromptActions`). */
  actionsOf?: (prompt: SessionPrompt) => { own: boolean; removable: boolean };
  expanded: boolean;
  /** The agent is working: Send now stops the current reply first. */
  busy: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  isDark: boolean;
}) {
  const bgColor = isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03);
  const borderColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06);
  const mutedText = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const first = messages[0]?.text ?? '';

  return (
    <View
      style={{
        borderRadius: 12,
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor,
        marginBottom: 8,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 4 }}>
        <Button
          variant="ghost"
          onPress={onToggle}
          accessibilityState={{ expanded }}
          accessibilityLabel={`${queueHeaderLabel(messages.length)}. ${expanded ? 'Hide' : 'Show'} queued messages`}
          className="h-auto w-auto flex-1 flex-row items-center justify-start gap-2 rounded-none active:opacity-70"
          style={{ minHeight: 44, paddingLeft: 12, paddingRight: 4, paddingVertical: 10 }}
        >
          <Text variant="small" className="leading-5">
            {queueHeaderLabel(messages.length)}
          </Text>
          <Text variant="muted" numberOfLines={1} className="flex-1">
            {expanded ? '' : first}
          </Text>
          {expanded ? (
            <CaretUpIcon size={14} color={mutedText} />
          ) : (
            <CaretDownIcon size={14} color={mutedText} />
          )}
        </Button>
      </View>

      {expanded && messages.length > 0 && (
        <View style={{ maxHeight: 176 }}>
          <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
            {messages.map((qm) => {
              const actions = actionsOf?.(qm) ?? { own: true, removable: true };
              return (
              <View
                key={qm.prompt_id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: 12,
                  paddingRight: 4,
                  paddingVertical: 2,
                  borderTopWidth: 1,
                  borderTopColor: borderColor,
                }}
              >
                {(() => {
                  // Queued prompts show their sender too, like the transcript.
                  const sender = senderOf?.(qm);
                  return sender ? <ParticipantAvatar person={sender} /> : null;
                })()}
                <View className="flex-1">
                  <Text variant="small" numberOfLines={1} className="leading-5">
                    {qm.text}
                  </Text>
                  {queueRowCaption(qm) ? (
                    <Text variant="muted" numberOfLines={2}>
                      {queueRowCaption(qm)}
                    </Text>
                  ) : null}
                </View>
                {actions.own && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full"
                    onPress={() => onSendNow(qm.prompt_id)}
                    accessibilityLabel="Send now"
                    accessibilityHint={busy ? 'Stops the current reply and sends this message' : undefined}
                  >
                    <Text>Send now</Text>
                  </Button>
                )}
                {/* 40pt box + the Button's default 2pt hit slop = 44pt target. */}
                {actions.removable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    onPress={() => onRemove(qm.prompt_id)}
                    accessibilityLabel="Remove from queue"
                  >
                    <XIcon size={16} color={mutedText} />
                  </Button>
                )}
              </View>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

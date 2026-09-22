/**
 * SessionPage — the full session chat view.
 *
 * Uses the sync store (hydrated by useSessionSync, kept live by SSE)
 * as the single source of truth for messages.
 *
 * Sends messages via fire-and-forget promptAsync with agent/model/variant.
 */

import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import {
  AppState,
  View,
  FlatList,
  ScrollView,
  TextInput,
  Animated,
  Easing,
  Platform,
  RefreshControl,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListIcon as MenuIcon, XIcon as CloseIcon, ListIcon, XIcon, PaperPlaneTiltIcon, ArrowUpIcon, ArrowDownIcon, CaretUpIcon, CaretDownIcon, DotsThreeIcon } from '@/lib/icons';
import { MenuButton } from '@/components/kortix/menu-button';
import { FLOATING_MENU_CLEARANCE, FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import { AgentPill } from '@/components/session/AgentPill';
import { ProjectHeaderActions } from '@/components/session/ProjectHeaderActions';
import { useProjectModelCatalog } from '@/lib/projects/hooks';
import { openProjectModelsOnWeb } from '@/lib/session/connect-model';
import { offeredSessionModels, type PickerCatalogModel, type PickerModel } from '@/lib/session/model-picker';
import { haptics } from '@/lib/haptics';
import { Icon } from '@/components/ui/icon';
import { Text as RNText } from 'react-native';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { reconcileLiveSession, useSessionSync } from '@/lib/opencode/session-sync';
import { compactionTurnInfo, groupMessagesIntoTurns, resolveWorkingTurn } from '@kortix/sdk';
import type { Turn, QuestionRequest, MessageWithParts, PermissionRequest } from '@/lib/opencode/types';
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
import { interruptedTurnIds, rewindHiddenMessageIds, webSpace } from '@/lib/session/user-message';
import {
  hasCompactionTurn as findCompactionTurn,
  isSuppressedFailedCompaction,
  lastCompactionTurnIndex as findLastCompactionTurnIndex,
  suppressWorkingTurnBusy as findSuppressWorkingTurnBusy,
  transcriptBusyRowVisible,
  type TurnBodyTurn,
} from '@/lib/session/turn-body';
import { revertSession } from '@/lib/opencode/session-rewind';
import { useToast } from '@/components/kortix/toast-provider';
import {
  hasRunningQuestionTool as findRunningQuestionTool,
  nextQuestionPollDelay,
  shouldPollQuestions as shouldPollQuestionsFor,
} from '@/lib/session/question-poll';
import { useSession, replyToQuestion, rejectQuestion, replyToPermission, useRenameSession } from '@/lib/platform/hooks';
import { useTabStore } from '@/stores/tab-store';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import type { QueuedMessage } from '@/stores/message-queue-store';
import { useCompactionStore } from '@/stores/compaction-store';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useOpenCodeAgents,
  useOpenCodeProviders,
  useOpenCodeConfig,
  useOpenCodeCommands,
  flattenModels,
  filterToLatestModels,
  type Agent,
  type Command,
  type FlatModel,
} from '@/lib/opencode/hooks/use-opencode-data';
import { useResolvedConfig } from '@/lib/opencode/hooks/use-local-config';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

import { SessionChatInput, type PromptOptions, type TrackedMention } from './SessionChatInput';
import { SandboxHealthPill } from './SandboxHealthPill';
import { useRouter } from 'expo-router';
import { SessionTurn } from './SessionTurn';
import { SessionBusyIndicator } from './session-busy-indicator';
import { CompactionMarker } from './turn/compaction-divider';
import { QuestionPrompt } from './QuestionPrompt';
import { useSessions } from '@/lib/platform/hooks';
import { FileViewer } from '@/components/files/FileViewer';
import { MarkdownActionsProvider } from '@/components/markdown/inline-code';
import { ToolFilePreviewHost } from '@/components/session/tool/shared/navigation';
import { ActivitySheetHost } from '@/components/session/turn/activity-sheet';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';
import type { SandboxFile } from '@/api/types';
import type { Session } from '@/lib/platform/types';
import { ProjectHero } from '@/components/session/ProjectHero';

// AnimatedToggleIcon was extracted to components/kortix/animated-toggle-icon.tsx
// so it can be shared with PageHeader and page-level headers across the app.
import { AnimatedToggleIcon } from '@/components/kortix/animated-toggle-icon';

interface SessionPageProps {
  sessionId: string;
  /** The session's project: its model catalog is the thread's model list. */
  projectId?: string;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  /** True when the left drawer is currently open — swaps the menu icon for an X */
  isDrawerOpen?: boolean;
  /** True when the right drawer is currently open — swaps the grid icon for an X */
  isRightDrawerOpen?: boolean;
  /**
   * 'header'   — the legacy top bar (back/title/drawer buttons). Default, so
   *              ProjectScreenLegacy is unaffected.
   * 'floating' — no header; a floating menu button.
   */
  chrome?: 'header' | 'floating';
  /** Hides drawer buttons, model/variant selectors — used for onboarding */
  onboardingMode?: boolean;
  /** Skip callback shown in header during onboarding */
  onSkipOnboarding?: () => void;
}

// Module-level empty values: a `?? []` default creates a new array on every
// render and defeats every memo downstream.
function frozenEmpty<T>(): T[] {
  return Object.freeze([]) as unknown as T[];
}
const EMPTY_MESSAGES = frozenEmpty<MessageWithParts>();
const EMPTY_QUESTIONS = frozenEmpty<QuestionRequest>();
const EMPTY_PERMISSIONS = frozenEmpty<PermissionRequest>();
const EMPTY_TURNS = frozenEmpty<Turn>();
const EMPTY_SESSIONS = frozenEmpty<Session>();
const EMPTY_AGENTS = frozenEmpty<Agent>();
const EMPTY_COMMANDS = frozenEmpty<Command>();
const EMPTY_MODELS = frozenEmpty<FlatModel>();
const EMPTY_DEFAULTS = Object.freeze({}) as Record<string, string>;
const EMPTY_IDS = frozenEmpty<string>();

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

function readSavedScrollOffset(sessionId: string): number {
  const saved = useTabStore.getState().tabStateById[sessionId] as { scrollOffset?: number } | undefined;
  return typeof saved?.scrollOffset === 'number' ? saved.scrollOffset : 0;
}

/** A catalog model the sandbox has not listed (yet), as the composer's `FlatModel`. */
function flatModelFromCatalog(model: PickerModel, entry: PickerCatalogModel): FlatModel {
  return {
    ...model,
    reasoning: entry.reasoning ?? false,
    contextWindow: entry.limit?.context,
    family: entry.family,
    releaseDate: entry.release_date,
  };
}

function SessionPageImpl({ sessionId, projectId, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, chrome = 'header', onboardingMode, onSkipOnboarding }: SessionPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  // Onboarding always uses header chrome (no floating menu). Explicit guard against any call site
  // that might accidentally pass both onboardingMode and chrome="floating".
  const effectiveChrome = onboardingMode ? 'header' : chrome;
  // Top inset for the message list. Floating chrome has no header, so the
  // list would start under the status bar and the floating menu button —
  // inset it below them (FLOATING_MENU_CLEARANCE, where the top fade ends).
  // Header chrome keeps the original 16pt breathing room below the header.
  const listTopInset = effectiveChrome === 'floating' ? insets.top + FLOATING_MENU_CLEARANCE : 16;
  // The bottom area rests above the home indicator (`insets.bottom`). While
  // the keyboard is up the indicator is covered, so the inset collapses with
  // the keyboard's progress: the composer then sits its own 12pt (`pb-3`) above
  // the keyboard, the same gap as the project home composer (design.md §5).
  const padsSafeArea = onboardingMode || effectiveChrome === 'floating';
  const bottomInset = insets.bottom;
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomAreaStyle = useAnimatedStyle(() => ({
    paddingBottom: bottomInset * (1 - keyboardProgress.value),
  }));
  const { sandboxUrl } = useSandboxContext();
  const flatListRef = useRef<FlatList>(null);
  // Saved scroll offset: read once per session, not subscribed. Subscribing
  // re-rendered the whole thread on every persisted offset write.
  const savedScrollOffset = useMemo(() => readSavedScrollOffset(sessionId), [sessionId]);
  const lastSavedOffsetRef = useRef(savedScrollOffset);
  const currentOffsetRef = useRef(savedScrollOffset);
  const restoredSessionIdRef = useRef<string | null>(null);




  // Session metadata
  const { data: session } = useSession(sandboxUrl, sessionId);
  const { data: allSessions = EMPTY_SESSIONS } = useSessions(sandboxUrl);

  // Hydrate messages from REST on mount; SSE keeps store updated after
  useSessionSync(sandboxUrl, sessionId);

  // Pull to refresh (Jay, 2026-09-23): re-reads this session's transcript
  // through its sync controller (`reconcile('manual')`) — the chat refreshes,
  // the page does not remount. Only a pull shows the spinner.
  const [pulling, setPulling] = useState(false);
  const handlePullRefresh = useCallback(() => {
    haptics.tap();
    setPulling(true);
    void reconcileLiveSession(sessionId, 'manual').finally(() => setPulling(false));
  }, [sessionId]);

  // Read messages from sync store
  const messages = useSyncStore((s) => s.messages[sessionId]);
  const sessionStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
  const pendingQuestions = useSyncStore((s) => s.questions[sessionId]) ?? EMPTY_QUESTIONS;
  const pendingPermissions = useSyncStore((s) => s.permissions[sessionId]) ?? EMPTY_PERMISSIONS;
  const safeMessages = messages ?? EMPTY_MESSAGES;

  const isBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const isCompacting = useCompactionStore((s) => Boolean(s.compactingBySession[sessionId]));

  // ── Self-heal: restore pending questions after reload ──────────────────
  // Matches the frontend's pattern: detect running question tool parts in
  // messages, and if the store has no pending questions, poll GET /question.
  // Track recently-replied question IDs to avoid re-adding them before the
  // server processes the reply.
  const suppressedQuestionIds = useRef(new Set<string>());

  // Scans only the newest assistant message: a running question tool always
  // belongs to the newest turn.
  const hasRunningQuestionTool = useMemo(() => findRunningQuestionTool(safeMessages), [safeMessages]);

  // Poll GET /question only while a question tool part runs and the store has
  // no pending question (the `question.asked` event was missed). The stream
  // layer hydrates /question after reconnects, so a busy session alone is not
  // a trigger.
  const shouldPollQuestions = shouldPollQuestionsFor({
    hasRunningQuestionTool,
    pendingCount: pendingQuestions.length,
    hasSandboxUrl: !!sandboxUrl,
  });

  // A status change (idle → busy, busy → idle) restarts the poll with a fresh
  // failure count, so a 401/403 stop or a long backoff is re-evaluated.
  const sessionStatusType = sessionStatus?.type;

  useEffect(() => {
    if (!shouldPollQuestions || !sandboxUrl) return;
    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    // `null` stops the poll until the status changes or the app returns to
    // the foreground.
    const schedule = (delayMs: number | null) => {
      clearTimer();
      if (cancelled || delayMs === null) return;
      timer = setTimeout(() => {
        timer = null;
        void hydrateQuestions();
      }, delayMs);
    };

    const hydrateQuestions = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      let status: number | null = null;
      try {
        const token = await getAuthToken();
        const res = await fetch(`${sandboxUrl}/question`, {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        status = res.status;
        if (cancelled) return;
        if (!res.ok) {
          consecutiveFailures += 1;
          return;
        }
        const questions = await res.json();
        consecutiveFailures = 0;
        if (!Array.isArray(questions) || cancelled) return;
        const store = useSyncStore.getState();
        const existingIds = new Set((store.questions[sessionId] || []).map((q) => q.id));
        for (const q of questions) {
          if (q.sessionID === sessionId && !existingIds.has(q.id) && !suppressedQuestionIds.current.has(q.id)) {
            store.addQuestion(sessionId, q);
            log.log('🔄 [SessionPage] Self-healed pending question:', q.id);
          }
        }
      } catch {
        consecutiveFailures += 1;
      } finally {
        inFlight = false;
        schedule(nextQuestionPollDelay(status, consecutiveFailures));
      }
    };

    // Back in the foreground: poll now instead of waiting out a backoff.
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || cancelled) return;
      consecutiveFailures = 0;
      clearTimer();
      void hydrateQuestions();
    });

    void hydrateQuestions();

    return () => {
      cancelled = true;
      clearTimer();
      appStateSubscription.remove();
    };
  }, [shouldPollQuestions, sandboxUrl, sessionId, sessionStatusType]);

  // ── Message Queue ──────────────────────────────────────────────────────
  const queueHydrated = useMessageQueueStore((s) => s.hydrated);
  const allQueuedMessages = useMessageQueueStore((s) => s.messages);
  const queuedMessages = useMemo(
    () => allQueuedMessages.filter((m) => m.sessionId === sessionId),
    [allQueuedMessages, sessionId],
  );
  const queueEnqueue = useMessageQueueStore((s) => s.enqueue);
  const queueRemove = useMessageQueueStore((s) => s.remove);
  const queueMoveUp = useMessageQueueStore((s) => s.moveUp);
  const queueMoveDown = useMessageQueueStore((s) => s.moveDown);
  const queueClearSession = useMessageQueueStore((s) => s.clearSession);

  // Hydrate queue store from AsyncStorage once
  useEffect(() => {
    if (!queueHydrated) {
      useMessageQueueStore.getState().hydrate();
    }
  }, [queueHydrated]);

  // Enqueue handler — called by SessionChatInput when agent is busy
  const handleEnqueue = useCallback(
    (text: string) => {
      queueEnqueue(sessionId, text);
    },
    [sessionId, queueEnqueue],
  );

  // Queue expanded/collapsed state
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [savedInputText, setSavedInputText] = useState('');
  const inputTextRef = useRef('');

  // The first pending question for this session (if any)
  const activeQuestion: QuestionRequest | undefined = pendingQuestions[0];
  const hasQuestion = !!activeQuestion;

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

  // ── Queue Draining ─────────────────────────────────────────────────────
  // Automatically send the next queued message when the agent becomes idle.
  // Mirrors the frontend's drainNextWhenSettled pattern.

  const drainScheduledRef = useRef(false);
  // Set by a user send; the next new turn scrolls into view animated. Turns
  // that appear from hydration jump without an animation.
  const userSentRef = useRef(false);
  const queueInFlightRef = useRef<{ queueId: string; sentAt: number } | null>(null);


  // ── Send / Stop handlers (defined early so queue drain logic can reference them) ──

  const handleSend = useCallback(
    async (text: string, options: PromptOptions, mentions?: TrackedMention[]) => {
      if (!sandboxUrl) return;

      // Clear the tracked input text so it isn't saved when a question appears
      inputTextRef.current = '';
      // The turn this send creates scrolls into view with an animation; the
      // thread then sticks to its end again.
      userSentRef.current = true;

      // Process session mentions — append XML refs (same as frontend)
      let finalText = text;
      const sessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value);
      if (sessionMentions && sessionMentions.length > 0) {
        const refs = sessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        finalText = `${text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }

      // Optimistic user message
      // Wire-format id: the thread sorts messages by id as a string, so the
      // optimistic message must sort after the real ones already present.
      const messageId = mintWireMessageId({
        nowMs: Date.now(),
        knownMessageIds: (useSyncStore.getState().messages[sessionId] ?? EMPTY_MESSAGES).map((m) => m.info.id),
      });
      const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      useSyncStore.getState().addOptimisticMessage(sessionId, {
        info: {
          id: messageId,
          role: 'user',
          sessionID: sessionId,
          time: { created: Date.now() },
        },
        parts: [{ type: 'text', id: partId, text: finalText }],
      });
      useSyncStore.getState().setStatus(sessionId, { type: 'busy' });

      // Build prompt payload
      const payload: Record<string, any> = {
        parts: [{ type: 'text', text: finalText }],
      };
      if (options.model) payload.model = options.model;
      if (options.agent) payload.agent = options.agent;
      if (options.variant) payload.variant = options.variant;

      try {
        const token = await getAuthToken();
        const res = await fetch(`${sandboxUrl}/session/${sessionId}/prompt_async`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          log.error('[SessionPage] Prompt failed:', res.status, errorText);
          userSentRef.current = false;
          useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        } else {
          log.log('[SessionPage] Prompt sent (async)');
        }
      } catch (err: any) {
        log.error('[SessionPage] Prompt error:', err?.message || err);
        userSentRef.current = false;
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
      }
    },
    [sandboxUrl, sessionId],
  );

  const handleStop = useCallback(async () => {
    if (!sandboxUrl) return;
    useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
    try {
      const token = await getAuthToken();
      await fetch(`${sandboxUrl}/session/${sessionId}/abort`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (err: any) {
      log.error('[SessionPage] Abort error:', err?.message || err);
    }
  }, [sandboxUrl, sessionId]);

  // ── Queue drain logic ───────────────────────────────────────────────────

  const drainNextWhenSettled = useCallback(() => {
    if (drainScheduledRef.current) return;
    if (queueInFlightRef.current) return;
    if (isBusy) return;
    if (hasQuestion) return;

    const sessionQueue = useMessageQueueStore
      .getState()
      .messages.filter((m) => m.sessionId === sessionId);
    if (sessionQueue.length === 0) return;

    drainScheduledRef.current = true;
    setTimeout(() => {
      drainScheduledRef.current = false;

      // Re-check guards after delay
      const status = useSyncStore.getState().sessionStatus[sessionId];
      const stillBusy = status?.type === 'busy' || status?.type === 'retry';
      const stillHasQuestion = (useSyncStore.getState().questions[sessionId] ?? []).length > 0;
      if (stillBusy || stillHasQuestion || queueInFlightRef.current) return;

      const next = useMessageQueueStore.getState().dequeue(sessionId);
      if (next) {
        queueInFlightRef.current = { queueId: next.id, sentAt: Date.now() };
        // Send with default options (agent/model/variant come from resolved config)
        handleSend(next.text, {}).catch(() => {
          queueInFlightRef.current = null;
        });
      }
    }, 500);
  }, [isBusy, hasQuestion, sessionId, handleSend]);

  // Release in-flight lock when agent finishes and drain next
  useEffect(() => {
    const inFlight = queueInFlightRef.current;
    if (!inFlight) return;
    if (isBusy || hasQuestion) return;

    // Agent finished — release lock and drain next
    queueInFlightRef.current = null;
    setTimeout(() => drainNextWhenSettled(), 100);
  }, [safeMessages, isBusy, hasQuestion, drainNextWhenSettled]);

  // Fallback drain: triggers when isBusy changes to false and queue has items
  useEffect(() => {
    if (isBusy || drainScheduledRef.current) return;
    const sessionQueue = useMessageQueueStore
      .getState()
      .messages.filter((m) => m.sessionId === sessionId);
    if (sessionQueue.length === 0) return;
    drainNextWhenSettled();
  }, [isBusy, queuedMessages.length, sessionId, drainNextWhenSettled]);

  // "Send now" — abort current processing and immediately send a queued message
  const handleQueueSendNow = useCallback(
    (messageId: string) => {
      const msg = useMessageQueueStore
        .getState()
        .messages.find((m) => m.id === messageId);
      if (!msg) return;
      queueInFlightRef.current = null;
      queueRemove(messageId);
      handleStop();
      setTimeout(() => {
        handleSend(msg.text, {});
      }, 200);
    },
    [queueRemove, handleStop, handleSend],
  );

  // Agent/model/variant config
  const { data: agents = EMPTY_AGENTS } = useOpenCodeAgents(sandboxUrl);
  // Models are derived here from the providers query (the same query
  // useOpenCodeModels reads) so the arrays keep their identity between
  // renders and the memoized composer can skip stream renders.
  const { data: providers } = useOpenCodeProviders(sandboxUrl);
  const sandboxModels = useMemo(() => (providers ? flattenModels(providers) : EMPTY_MODELS), [providers]);
  // The models this thread can run on: web's rule (`lib/session/model-picker.ts`).
  // A gateway project lists its `/model-picker` catalog — the list project home
  // and web show; any other project lists its sandbox's own providers.
  const { catalog: modelCatalog, isLoading: catalogLoading } = useProjectModelCatalog(projectId ?? null);
  const allModels = useMemo(
    () => offeredSessionModels(sandboxModels, modelCatalog, flatModelFromCatalog),
    [sandboxModels, modelCatalog],
  );
  // The catalog is already curated by the server. A native provider list is
  // not: it keeps the newest model per family.
  const visibleModels = useMemo(
    () => (modelCatalog ? allModels : filterToLatestModels(allModels)),
    [modelCatalog, allModels],
  );
  const modelsLoading = catalogLoading || (!modelCatalog && !providers);
  const handleConnectModel = useCallback(() => {
    if (projectId) openProjectModelsOnWeb(projectId);
  }, [projectId]);
  const defaults = providers?.default ?? EMPTY_DEFAULTS;
  const { data: config } = useOpenCodeConfig(sandboxUrl);
  const { data: commands = EMPTY_COMMANDS } = useOpenCodeCommands(sandboxUrl);

  // Resolution uses ALL models (fallback chain); selector shows only visible
  const resolved = useResolvedConfig(agents, allModels, config, defaults);

  // useResolvedConfig returns new arrays, objects, and setters on every
  // render. Stabilize what the composer receives: arrays by content, setters
  // through a ref that always calls the latest resolved config.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
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
    (providerID: string, modelID: string) =>
      resolvedRef.current.setModel(providerID, modelID, { explicit: true }),
    [],
  );
  const handleVariantSet = useCallback((v: string | null) => resolvedRef.current.setVariant(v), []);
  const handleTextChange = useCallback((t: string) => {
    inputTextRef.current = t;
  }, []);

  // Agent names for mention highlighting in user bubbles
  const agentNames = useMemo(() => agents.map((a) => a.name), [agents]);

  // Mention click handlers
  const handleSessionMention = useCallback((mentionedSessionId: string) => {
    useTabStore.getState().navigateToSession(mentionedSessionId);
  }, []);

  // File mention viewer
  const [mentionFileViewerVisible, setMentionFileViewerVisible] = useState(false);
  const [mentionViewerFile, setMentionViewerFile] = useState<SandboxFile | null>(null);

  const handleFileMention = useCallback((path: string) => {
    const name = path.split('/').pop() || path;
    const fullPath = path.startsWith('/') ? path : `/workspace/${path}`;
    setMentionViewerFile({ name, path: fullPath, type: 'file' });
    setMentionFileViewerVisible(true);
  }, []);

  // ── Edit a sent message ────────────────────────────────────────────────
  // Same mechanism as apps/web `session-chat.tsx` `handleEditSend`: rewind the
  // session to the message (`POST /session/:id/revert`, what the SDK's
  // `useSession().rewind` calls), then send the edited text. The server
  // stages the revert; that send commits it and deletes the reverted messages.
  const toast = useToast();
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
    async (messageId: string, text: string) => {
      if (!sandboxUrl || editPendingRef.current) return;
      editPendingRef.current = true;
      setEditPending(true);
      try {
        const token = await getAuthToken();
        await revertSession({ sandboxUrl, sessionId, messageId, token });
      } catch (err: any) {
        // The editor stays open with the draft, so Send can be tried again.
        log.error('[SessionPage] Rewind failed:', err?.message || err);
        toast.error("Couldn't edit the message. Try again.");
        editPendingRef.current = false;
        setEditPending(false);
        return;
      }
      // Hide the abandoned messages now; the resend below commits the revert
      // server-side.
      const store = useSyncStore.getState();
      for (const id of rewindHiddenMessageIds(store.messages[sessionId] ?? EMPTY_MESSAGES, messageId)) {
        store.removeMessage(sessionId, id);
      }
      editPendingRef.current = false;
      setEditPending(false);
      setRewindTarget(null);
      const { agent, modelKey, variant } = resolvedRef.current;
      const options: PromptOptions = {};
      if (agent?.name) options.agent = agent.name;
      if (modelKey) options.model = modelKey;
      if (variant) options.variant = variant;
      await handleSend(text, options);
    },
    [sandboxUrl, sessionId, handleSend, toast],
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
  // The last turn as displayed. Turns are sorted for display, and store order
  // can differ, so the spacer and pending questions follow this id.
  const lastTurnId = turns.length > 0 ? turns[turns.length - 1].userMessage.info.id : undefined;
  const isFreshSession = turns.length === 0;
  // User messages a Stop stranded before a step ran under them (web: `interruptedTurnIds`).
  const interruptedIds = useMemo(() => interruptedTurnIds(turns, isBusy), [turns, isBusy]);
  // Web refuses a rewind while the runtime is busy or prompts are still queued.
  const rewindDisabled = isBusy || queuedMessages.length > 0 || editPending || !sandboxUrl;
  const showFreshHero = isFreshSession && !hasQuestion && queuedMessages.length === 0 && !isBusy;
  const heroOpacity = useRef(new Animated.Value(showFreshHero ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(heroOpacity, {
      toValue: showFreshHero ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [showFreshHero, heroOpacity]);

  // ── Transcript scroll physics ──────────────────────────────────────────
  // A port of apps/web `use-auto-scroll.ts`. The decisions are pure and tested
  // in `lib/session/auto-scroll.ts`; this block only feeds them geometry and
  // applies the result to the FlatList.
  //
  // FACT 1 — the room: the footer spacer under the newest reached turn is
  //   max(24, viewport − span(anchor turn → content end) − topOffset), so that
  //   turn can sit `topOffset` below the top of the list.
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
      next = Math.round(roomUnderNewestTurn(viewportHeight, span, topOffset));
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
    if (next !== roomRef.current) {
      roomRef.current = next;
      setRoom(next);
    }
    return { measured: true, anchorChanged };
  }, []);

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

  // The viewport shrinks when the keyboard opens or the composer grows.
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
      if (!sandboxUrl) return;
      // Suppress this ID so the self-heal polling doesn't re-add it
      suppressedQuestionIds.current.add(requestId);
      // Optimistically remove from store
      useSyncStore.getState().removeQuestion(sessionId, requestId);
      try {
        await replyToQuestion(sandboxUrl, requestId, answers);
      } catch (err: any) {
        log.error('Failed to reply to question:', err?.message || err);
      }
      // Clear suppression after a delay (server should have processed by then)
      setTimeout(() => suppressedQuestionIds.current.delete(requestId), 10000);
    },
    [sandboxUrl, sessionId],
  );

  // Permission reply — the Deny / Allow always / Allow once prompt under a
  // tool row. Same as apps/web `handlePermissionReply`: no optimistic remove;
  // the prompt leaves the store only once the runtime accepted the reply, so
  // a failed reply stays visible.
  const handlePermissionReply = useCallback(
    async (requestId: string, reply: PermissionReply) => {
      if (!sandboxUrl) return;
      try {
        await replyToPermission(sandboxUrl, requestId, reply);
        useSyncStore.getState().removePermission(sessionId, requestId);
      } catch (err: any) {
        log.error('[SessionPage] Permission reply failed:', err?.message || err);
        toast.error("Couldn't send the permission reply. Try again.");
      }
    },
    [sandboxUrl, sessionId, toast],
  );

  // Inline-code file paths in the transcript open the file viewer.
  const markdownActions = useMemo(() => ({ onOpenFile: handleFileMention }), [handleFileMention]);

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      if (!sandboxUrl) return;
      suppressedQuestionIds.current.add(requestId);
      // Optimistically remove from store
      useSyncStore.getState().removeQuestion(sessionId, requestId);
      try {
        await rejectQuestion(sandboxUrl, requestId);
      } catch (err: any) {
        log.error('Failed to reject question:', err?.message || err);
      }
      setTimeout(() => suppressedQuestionIds.current.delete(requestId), 10000);
      // Also abort the session (matches frontend behavior)
      handleStop();
    },
    [sandboxUrl, sessionId, handleStop],
  );

  // Command handler — executes a slash command via the server
  const handleCommand = useCallback(
    async (cmd: Command, args?: string) => {
      if (!sandboxUrl) return;
      // A command creates its turn through the stream, not optimistically, so
      // it has no send scroll: show the result by sticking to the end.
      stickToEnd();
      useSyncStore.getState().setStatus(sessionId, { type: 'busy' });
      try {
        const token = await getAuthToken();
        const payload: Record<string, any> = {
          command: cmd.name,
          arguments: args || '',
        };
        const current = resolvedRef.current;
        if (current.agent?.name) payload.agent = current.agent.name;
        if (current.modelKey) payload.model = `${current.modelKey.providerID}/${current.modelKey.modelID}`;
        if (current.variant) payload.variant = current.variant;

        const res = await fetch(`${sandboxUrl}/session/${sessionId}/command`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          log.error('[SessionPage] Command failed:', res.status, errorText);
          useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        }
      } catch (err: any) {
        log.error('[SessionPage] Command error:', err?.message || err);
        useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
      }
    },
    [sandboxUrl, sessionId, stickToEnd],
  );

  // Only the working turn (web `resolveWorkingTurn`) receives status and busy;
  // other turns get stable values, so their memoized rows skip stream renders.
  // The room follows the displayed order. Every turn gets `pendingQuestions`
  // (one stable store array) so a pending question tool part is hidden in
  // whichever turn holds it.
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
          />
          )}
        </View>
      );
    },
    [workingTurnId, lastCompactionTurnIndex, suppressWorkingBusy, turnGapAt, handleTurnLayout, sessionStatus, isBusy, sessionId, pendingPermissions, pendingQuestions, handlePermissionReply, agentNames, handleFileMention, handleSessionMention, commands, rewindTarget, editPending, handleEditStart, handleEditCancel, handleEditSend, rewindDisabled, interruptedIds],
  );

  const keyExtractor = useCallback((item: Turn) => item.userMessage.info.id, []);

  const handleToggleQueue = useCallback(() => setQueueExpanded((v) => !v), []);
  const handleClearQueue = useCallback(() => queueClearSession(sessionId), [queueClearSession, sessionId]);
  const inputSlot = useMemo(
    () =>
      queuedMessages.length > 0 ? (
        <QueuePanel
          messages={queuedMessages}
          expanded={queueExpanded}
          onToggle={handleToggleQueue}
          onRemove={queueRemove}
          onMoveUp={queueMoveUp}
          onMoveDown={queueMoveDown}
          onClear={handleClearQueue}
          onSendNow={handleQueueSendNow}
          isDark={isDark}
        />
      ) : undefined,
    [queuedMessages, queueExpanded, handleToggleQueue, queueRemove, queueMoveUp, queueMoveDown, handleClearQueue, handleQueueSendNow, isDark],
  );

  const title = session?.title || 'New Session';

  // ── Inline title edit ──────────────────────────────────────────────────
  // Tap the title → it becomes a TextInput in place. Commit on blur or Return;
  // revert if the user clears the field. Disabled in onboarding mode.
  const renameSession = useRenameSession(sandboxUrl);
  const titleInputRef = useRef<TextInput>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);

  const beginTitleEdit = useCallback(() => {
    if (onboardingMode) return;
    const current = session?.title || '';
    setTitleDraft(current);
    setIsEditingTitle(true);
    // Focus on the next frame so the TextInput is mounted, then place the
    // caret at the end of the text (native default would select the whole
    // string when selectTextOnFocus is set).
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.setNativeProps({
        selection: { start: current.length, end: current.length },
      });
    });
  }, [onboardingMode, session?.title]);

  const commitTitleEdit = useCallback(() => {
    if (!isEditingTitle) return;
    const trimmed = titleDraft.trim();
    const previous = (session?.title || '').trim();
    setIsEditingTitle(false);
    // No change or empty → revert silently
    if (!trimmed || trimmed === previous) return;
    renameSession.mutate({ sessionId, title: trimmed });
  }, [isEditingTitle, titleDraft, session?.title, renameSession, sessionId]);

  const cancelTitleEdit = useCallback(() => {
    setIsEditingTitle(false);
    setTitleDraft(session?.title || '');
  }, [session?.title]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      className="bg-background"
    >
      {effectiveChrome === 'header' ? (
        /* Header — flat bar on the page surface, matches PageHeader */
        <View
          style={{ paddingTop: insets.top, paddingBottom: 12 }}
          className="px-4 bg-background"
        >
          <View className="flex-row items-center">
            {!onboardingMode && (
              <View className="mr-3">
                <MenuButton onPress={onOpenDrawer} />
              </View>
            )}
            <View className="flex-1 flex-row items-center">
              {/* Status dot before the title (matches web session-list):
                  amber when a question is waiting, green while working,
                  hidden otherwise. */}
              {!onboardingMode && !isEditingTitle && (isBusy || pendingQuestions.length > 0) && (
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: pendingQuestions.length > 0 ? THEME.accent.orange : THEME.accent.green,
                    marginRight: 8,
                  }}
                />
              )}
              {isEditingTitle ? (
                <TextInput
                  ref={titleInputRef}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  onBlur={commitTitleEdit}
                  onSubmitEditing={commitTitleEdit}
                  returnKeyType="done"
                  blurOnSubmit
                  maxLength={200}
                  placeholder="Session title"
                  placeholderTextColor={isDark ? withAlpha(THEME.dark.foreground, 0.3) : withAlpha(THEME.light.foreground, 0.3)}
                  style={{
                    flex: 1,
                    fontSize: 16,
                    fontFamily: 'Roobert-Medium',
                    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
                    padding: 0,
                    margin: 0,
                  }}
                />
              ) : (
                <Button
                  variant="ghost"
                  onPress={beginTitleEdit}
                  disabled={onboardingMode}
                  className={`h-auto w-auto flex-1 justify-start p-0 active:bg-transparent ${onboardingMode ? 'active:opacity-100' : 'active:opacity-70'}`}
                  hitSlop={{ top: 8, bottom: 8 }}
                >
                  <Text
                    className="text-base font-medium text-muted-foreground"
                    numberOfLines={1}
                  >
                    {title}
                  </Text>
                </Button>
              )}
            </View>
            {!onboardingMode && (
              <Button
                variant="ghost"
                onPress={onOpenRightDrawer}
                className="h-auto w-auto ml-3 p-1 active:bg-transparent active:opacity-70"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <AnimatedToggleIcon open={!!isRightDrawerOpen} color={isDark ? THEME.dark.foreground : THEME.light.foreground} icon={DotsThreeIcon} size={20} />
              </Button>
            )}
            {onboardingMode && onSkipOnboarding && (
              <Button
                variant="ghost"
                onPress={onSkipOnboarding}
                className="h-auto w-auto ml-3 py-1 px-3 active:bg-transparent active:opacity-70"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: isDark ? withAlpha(THEME.dark.foreground, 0.5) : withAlpha(THEME.light.foreground, 0.4) }}>
                  Skip
                </Text>
              </Button>
            )}
          </View>
        </View>
      ) : (
        /* Floating menu button — opens the project drawer (every project page
           shows it, Jay 2026-09-16). `fade`: turns scroll under the button and
           the status bar, so they fade out there instead of showing through. */
        <FloatingMenuButton onPress={onOpenDrawer} fade>
          {/* The agent is a thread-level choice: it sits in the header, not in
              the composer (design.md §5). Hidden with fewer than two agents.
              The `···` button after it opens the project sheet. Onboarding
              has no project sheet, so the pill holds the edge there. */}
          {onOpenRightDrawer && !onboardingMode ? (
            <ProjectHeaderActions onOpenMore={onOpenRightDrawer}>
              <AgentPill agents={resolvedAgents} activeName={resolved.agent?.name ?? null} onChange={handleAgentChange} edge={false} />
            </ProjectHeaderActions>
          ) : (
            <AgentPill agents={resolvedAgents} activeName={resolved.agent?.name ?? null} onChange={handleAgentChange} />
          )}
        </FloatingMenuButton>
      )}

      {/* Messages + Fresh Session Hero — flat continuation of the page
          surface (the rounded "sheet" card treatment was removed app-wide). */}
      <View style={{ flex: 1 }} className="bg-background">
        <MarkdownActionsProvider value={markdownActions}>
        <FlatList
          ref={flatListRef}
          data={turns}
          renderItem={renderTurn}
          keyExtractor={keyExtractor}
          initialNumToRender={INITIAL_TURNS_TO_RENDER}
          maxToRenderPerBatch={5}
          windowSize={11}
          updateCellsBatchingPeriod={32}
          contentContainerStyle={{ paddingTop: listTopInset }}
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
            </View>
          }
          onScrollToIndexFailed={handleScrollToIndexFailed}
        />
        </MarkdownActionsProvider>

        <ScrollToBottomButton visible={showScrollButton} onPress={jumpToEnd} />

        <FreshSessionHero
          opacity={heroOpacity}
          visible={showFreshHero}
        />
      </View>

      {/* Fade gradient above input — only when textarea is shown */}
      {!hasQuestion && (
        <LinearGradient
          colors={isDark ? [withAlpha(THEME.dark.background, 0), withAlpha(THEME.dark.background, 1)] : [withAlpha(THEME.light.background, 0), withAlpha(THEME.light.background, 1)]}
          style={{ height: 24, marginTop: -24, zIndex: 1 }}
          pointerEvents="none"
        />
      )}

      {/* Sandbox health pill — full-width row immediately above the chat
          input. Self-hides (returns null) when the sandbox is reachable,
          so it takes no layout space the rest of the time. */}
      {!onboardingMode && !hasQuestion && (
        <SandboxHealthPill
          onSwitch={() => router.push('/(settings)/instances')}
        />
      )}

      {/* Bottom area — question prompt OR chat input. `floating` no longer
          clears a dock (removed): it just sits above the safe area, same as
          onboarding. */}
      <Reanimated.View style={padsSafeArea ? bottomAreaStyle : undefined}>
        {hasQuestion && activeQuestion ? (
          <QuestionPrompt
            key={activeQuestion.id}
            request={activeQuestion}
            onReply={handleQuestionReply}
            onReject={handleQuestionReject}
          />
        ) : (
          <SessionChatInput
            onSend={handleSend}
            onStop={handleStop}
            isBusy={isBusy}
            onboardingMode={onboardingMode}
            initialText={savedInputText}
            onTextChange={handleTextChange}
            agent={resolved.agent}
            agents={resolvedAgents}
            model={resolvedModel}
            models={visibleModels}
            modelsLoading={modelsLoading}
            onConnectModel={handleConnectModel}
            modelKey={resolvedModelKey}
            variant={resolved.variant}
            variants={resolvedVariants}
            onModelChange={handleModelChange}
            onVariantSet={handleVariantSet}
            sessions={allSessions}
            currentSessionId={sessionId}
            sandboxUrl={sandboxUrl}
            onEnqueue={handleEnqueue}
            commands={commands}
            onCommand={handleCommand}
            inputSlot={inputSlot}
          />
        )}
      </Reanimated.View>

      {/* File mention viewer */}
      <FileViewer
        visible={mentionFileViewerVisible}
        onClose={() => {
          setMentionFileViewerVisible(false);
          setMentionViewerFile(null);
        }}
        file={mentionViewerFile}
        sandboxId=""
        sandboxUrl={sandboxUrl}
      />

      {/* File taps inside tool rows (ToolNavigation.openFile) */}
      <ToolFilePreviewHost />

      {/* The activity summary rows' sheet (ActivityBurst) */}
      <ActivitySheetHost sessionId={sessionId} markdownActions={markdownActions} />
    </KeyboardAvoidingView>
  );
}

/**
 * Memoized so a parent render with unchanged props does not re-render the
 * thread. Callers pass stable callbacks.
 */
export const SessionPage = React.memo(SessionPageImpl);

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
      // (`px-4`) on the right; 8pt above the 24pt fade that overlaps the
      // bottom of the list — lower, and the fade would paint over it.
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
// QueuePanel — collapsible list of queued messages shown above the text input
// ---------------------------------------------------------------------------

function QueuePanel({
  messages,
  expanded,
  onToggle,
  onRemove,
  onMoveUp,
  onMoveDown,
  onClear,
  onSendNow,
  isDark,
}: {
  messages: QueuedMessage[];
  expanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onClear: () => void;
  onSendNow: (id: string) => void;
  isDark: boolean;
}) {
  const bgColor = isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03);
  const borderColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06);
  // Original literals (`#888`/`#999`) had their light/dark branches swapped
  // relative to their own lightness.
  const mutedText = isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground;
  const fgText = isDark ? THEME.dark.foreground : THEME.light.foreground;

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
      {/* Header — tap to expand/collapse */}
      <Button
        variant="ghost"
        onPress={onToggle}
        className="h-auto w-auto flex-row items-center justify-start rounded-none active:opacity-70"
        style={{
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <ListIcon size={14} color={mutedText} style={{ marginRight: 6 }} />
        <RNText
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: 'Roobert-Medium',
            color: mutedText,
          }}
          numberOfLines={1}
        >
          {messages.length} message{messages.length !== 1 ? 's' : ''} queued
          {!expanded && messages.length > 0
            ? ` — ${messages[0].text.length > 40 ? messages[0].text.slice(0, 40) + '...' : messages[0].text}`
            : ''}
        </RNText>
        {/* Clear all */}
        <Button
          variant="ghost"
          size="icon"
          onPress={() => onClear()}
          hitSlop={8}
          className="h-auto w-auto mr-2 p-0 active:bg-transparent active:opacity-70"
        >
          <XIcon size={14} color={mutedText} />
        </Button>
        {/* Expand/collapse chevron */}
        {expanded ? (
          <CaretUpIcon size={14} color={mutedText} />
        ) : (
          <CaretDownIcon size={14} color={mutedText} />
        )}
      </Button>

      {/* Expanded list */}
      {expanded && messages.length > 0 && (
        <View style={{ maxHeight: 160 }}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {messages.map((qm, idx) => (
              <View
                key={qm.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderTopWidth: 1,
                  borderTopColor: borderColor,
                }}
              >
                {/* Index badge */}
                <RNText
                  style={{
                    fontSize: 10,
                    fontFamily: 'Roobert-Medium',
                    color: mutedText,
                    width: 18,
                  }}
                >
                  {idx + 1}
                </RNText>

                {/* Message text */}
                <RNText
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontFamily: 'Roobert',
                    color: fgText,
                    marginRight: 8,
                  }}
                >
                  {qm.text}
                </RNText>

                {/* Action buttons */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {/* Send now */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onPress={() => onSendNow(qm.id)}
                    hitSlop={6}
                    className="h-auto w-auto p-1 active:bg-transparent active:opacity-70"
                  >
                    <PaperPlaneTiltIcon size={12} color={THEME.accent.blue} weight="fill" />
                  </Button>
                  {/* Move up */}
                  {idx > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onPress={() => onMoveUp(qm.id)}
                      hitSlop={6}
                      className="h-auto w-auto p-1 active:bg-transparent active:opacity-70"
                    >
                      <ArrowUpIcon size={12} color={mutedText} />
                    </Button>
                  )}
                  {/* Move down */}
                  {idx < messages.length - 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onPress={() => onMoveDown(qm.id)}
                      hitSlop={6}
                      className="h-auto w-auto p-1 active:bg-transparent active:opacity-70"
                    >
                      <ArrowDownIcon size={12} color={mutedText} />
                    </Button>
                  )}
                  {/* Remove */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onPress={() => onRemove(qm.id)}
                    hitSlop={6}
                    className="h-auto w-auto p-1 active:bg-transparent active:opacity-70"
                  >
                    <XIcon size={12} color={mutedText} />
                  </Button>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

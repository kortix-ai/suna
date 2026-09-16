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
  useWindowDimensions,
  Animated,
  Easing,
  Platform,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListIcon as MenuIcon, XIcon as CloseIcon, StackIcon, ListIcon, XIcon, PaperPlaneTiltIcon, ArrowUpIcon, ArrowDownIcon, CaretUpIcon, CaretDownIcon, DotsThreeIcon } from '@/lib/icons';
import { MenuButton } from '@/components/kortix/menu-button';
import { FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import { haptics } from '@/lib/haptics';
import { Icon } from '@/components/ui/icon';
import { Text as RNText } from 'react-native';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { useSessionSync } from '@/lib/opencode/session-sync';
import { groupMessagesIntoTurns } from '@kortix/sdk';
import type { Turn, QuestionRequest, MessageWithParts } from '@/lib/opencode/types';
import {
  findLastUserMessageId,
  isNearEnd,
  reuseStableTurns,
  shouldFollowNewTurn,
  shouldRearmStick,
  shouldReleaseStick,
  shouldReleaseStickOnTouch,
  shouldUpdateSpacer,
} from '@/lib/session/stable-turns';
import { mintWireMessageId } from '@/lib/session/wire-message-id';
import {
  hasRunningQuestionTool as findRunningQuestionTool,
  nextQuestionPollDelay,
  shouldPollQuestions as shouldPollQuestionsFor,
} from '@/lib/session/question-poll';
import { useSession, replyToQuestion, rejectQuestion, useRenameSession } from '@/lib/platform/hooks';
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
import { QuestionPrompt } from './QuestionPrompt';
import { useSessions } from '@/lib/platform/hooks';
import { FileViewer } from '@/components/files/FileViewer';
import type { SandboxFile } from '@/api/types';
import type { Session } from '@/lib/platform/types';
import { ProjectGreeting } from '@/components/session/ProjectGreeting';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

// AnimatedToggleIcon was extracted to components/kortix/animated-toggle-icon.tsx
// so it can be shared with PageHeader and page-level headers across the app.
import { AnimatedToggleIcon } from '@/components/kortix/animated-toggle-icon';

interface SessionPageProps {
  sessionId: string;
  /** Project name for the fresh-session hero — "Give {name} something real to work on." */
  projectName?: string;
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
   * 'floating' — no header; a floating menu button, and bottom padding for the dock.
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
const EMPTY_TURNS = frozenEmpty<Turn>();
const EMPTY_SESSIONS = frozenEmpty<Session>();
const EMPTY_AGENTS = frozenEmpty<Agent>();
const EMPTY_COMMANDS = frozenEmpty<Command>();
const EMPTY_MODELS = frozenEmpty<FlatModel>();
const EMPTY_DEFAULTS = Object.freeze({}) as Record<string, string>;

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
// How long scroll events after a programmatic scroll call are attributed to it.
const PROGRAMMATIC_SCROLL_MS = 300;
const ANIMATED_SCROLL_MS = 1000;

function readSavedScrollOffset(sessionId: string): number {
  const saved = useTabStore.getState().tabStateById[sessionId] as { scrollOffset?: number } | undefined;
  return typeof saved?.scrollOffset === 'number' ? saved.scrollOffset : 0;
}

function SessionPageImpl({ sessionId, projectName, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, chrome = 'header', onboardingMode, onSkipOnboarding }: SessionPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  // Onboarding always uses header chrome (no dock, no floating menu). Explicit guard against any call site
  // that might accidentally pass both onboardingMode and chrome="floating".
  const effectiveChrome = onboardingMode ? 'header' : chrome;
  const { height: windowHeight } = useWindowDimensions();
  // Top inset for the message list. Floating chrome has no header, so the
  // list would start under the status bar and the floating menu button —
  // inset it below them (insets.top + 8 button offset + 40 button + 12 gap).
  // Header chrome keeps the original 16pt breathing room below the header.
  const listTopInset = effectiveChrome === 'floating' ? insets.top + 60 : 16;
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

  // Read messages from sync store
  const messages = useSyncStore((s) => s.messages[sessionId]);
  const sessionStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
  const pendingQuestions = useSyncStore((s) => s.questions[sessionId]) ?? EMPTY_QUESTIONS;
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
  const allModels = useMemo(() => (providers ? flattenModels(providers) : EMPTY_MODELS), [providers]);
  const visibleModels = useMemo(() => filterToLatestModels(allModels), [allModels]);
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
  const handleVariantCycle = useCallback(() => resolvedRef.current.cycleVariant(), []);
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
  const lastUserMessageId = useMemo(() => findLastUserMessageId(safeMessages), [safeMessages]);
  // The last turn as displayed. Turns are sorted for display, and store order
  // can differ, so the spacer and pending questions follow this id.
  const lastTurnId = turns.length > 0 ? turns[turns.length - 1].userMessage.info.id : undefined;
  const isFreshSession = turns.length === 0;
  const showFreshHero = isFreshSession && !hasQuestion && queuedMessages.length === 0 && !isBusy;
  const heroOpacity = useRef(new Animated.Value(showFreshHero ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(heroOpacity, {
      toValue: showFreshHero ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [showFreshHero, heroOpacity]);

  // ── Programmatic scrolls ───────────────────────────────────────────────
  // Scroll events caused by the list's own scroll calls must not release the
  // stick or be persisted as the user's reading position.
  const programmaticScrollUntilRef = useRef(0);
  const markProgrammaticScroll = useCallback((durationMs: number) => {
    programmaticScrollUntilRef.current = Math.max(programmaticScrollUntilRef.current, Date.now() + durationMs);
  }, []);
  const isProgrammaticScroll = useCallback(() => Date.now() < programmaticScrollUntilRef.current, []);

  // ── Stick to end ───────────────────────────────────────────────────────
  // While set, every content-size change (and viewport resize) scrolls the
  // thread to its end without animation, idle or busy. Turn heights arrive
  // over many layout passes, so this is what makes an opened thread settle at
  // the true end.
  // Set: a thread opens with no saved offset to restore; a turn the user sent
  //      finished its send scroll; a user scroll settles near the end.
  // Cleared only by user intent: a drag, a send (re-armed after its animated
  //      scroll), or a non-programmatic scroll that moves up away from the end
  //      (iOS status-bar tap). A restored saved offset never sets it.
  const stickToEndRef = useRef(false);
  // True while the stick was released only by a touch on the idle thread (no
  // drag since). A new turn not sent by the user then still scrolls into view.
  const releasedByTouchRef = useRef(false);
  // Whether the last settled user scroll rested near the end.
  const settledNearEndRef = useRef(false);
  const sendScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from a user send until its stick re-arms (or user intent cancels it).
  // Leaving the thread in that window counts as leaving at the end.
  const sendScrollPendingRef = useRef(false);

  const clearSendScrollTimer = useCallback(() => {
    if (sendScrollTimerRef.current) clearTimeout(sendScrollTimerRef.current);
    sendScrollTimerRef.current = null;
  }, []);
  useEffect(() => clearSendScrollTimer, [clearSendScrollTimer]);

  const scrollToEndNow = useCallback(() => {
    markProgrammaticScroll(PROGRAMMATIC_SCROLL_MS);
    flatListRef.current?.scrollToEnd({ animated: false });
  }, [markProgrammaticScroll]);

  const stickToEnd = useCallback(() => {
    stickToEndRef.current = true;
    releasedByTouchRef.current = false;
    scrollToEndNow();
  }, [scrollToEndNow]);

  // When turns appear:
  // - a turn the user just sent scrolls its bubble to the top, animated, then
  //   re-arms the stick;
  // - the first turns of an opened session stick to the end, unless a saved
  //   offset is restored instead (restoration wins);
  // - any other new turn (another client, a trigger, a menu action) sticks to
  //   the end when the thread was effectively at its end.
  // Later turns follow the end through the stick itself.
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
      stickToEndRef.current = false;
      sendScrollPendingRef.current = true;
      clearSendScrollTimer();
      // In floating chrome the viewport starts at the screen top, so offset by
      // the list's top inset to keep the bubble clear of the status bar + menu
      // button.
      const targetIndex = turns.length - 1;
      const viewOffset = effectiveChrome === 'floating' ? listTopInset : 0;
      sendScrollTimerRef.current = setTimeout(() => {
        try {
          markProgrammaticScroll(ANIMATED_SCROLL_MS);
          try {
            flatListRef.current?.scrollToIndex({
              index: targetIndex,
              viewPosition: 0,
              viewOffset,
              animated: true,
            });
          } catch {
            flatListRef.current?.scrollToEnd({ animated: true });
          }
        } finally {
          // Re-arm once the animated send scroll is over, even if it threw.
          sendScrollTimerRef.current = setTimeout(() => {
            sendScrollTimerRef.current = null;
            sendScrollPendingRef.current = false;
            stickToEndRef.current = true;
          }, ANIMATED_SCROLL_MS);
        }
      }, 150);
      return;
    }

    if (firstOpen) {
      stickToEndRef.current = false;
      releasedByTouchRef.current = false;
      settledNearEndRef.current = false;
      if (savedScrollOffset > 0) return;
      stickToEnd();
      return;
    }

    if (
      !stickToEndRef.current &&
      shouldFollowNewTurn({
        grew,
        releasedByTouch: releasedByTouchRef.current,
        settledNearEnd: settledNearEndRef.current,
      })
    ) {
      stickToEnd();
    }
  }, [turns.length, sessionId, savedScrollOffset, effectiveChrome, listTopInset, stickToEnd, clearSendScrollTimer, markProgrammaticScroll]);

  // The new turn's cell is not measured yet. The target is always the last
  // turn, so stick to the end instead of guessing an offset.
  const handleScrollToIndexFailed = useCallback(() => {
    clearSendScrollTimer();
    sendScrollPendingRef.current = false;
    stickToEnd();
  }, [clearSendScrollTimer, stickToEnd]);

  // Restore scroll position when reopening this tab/session. A restored
  // position does not stick to the end.
  useEffect(() => {
    if (restoredSessionIdRef.current === sessionId) return;
    if (savedScrollOffset <= 0) {
      restoredSessionIdRef.current = sessionId;
      return;
    }
    if (turns.length === 0) return;
    const timer = setTimeout(() => {
      stickToEndRef.current = false;
      sendScrollPendingRef.current = false;
      clearSendScrollTimer();
      try {
        markProgrammaticScroll(PROGRAMMATIC_SCROLL_MS);
        flatListRef.current?.scrollToOffset({
          offset: savedScrollOffset,
          animated: false,
        });
      } finally {
        restoredSessionIdRef.current = sessionId;
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [sessionId, savedScrollOffset, turns.length, clearSendScrollTimer, markProgrammaticScroll]);

  // Persist the scroll offset when a user scroll settles and when leaving the
  // session. A thread left while stuck to its end, or during a send's scroll,
  // saves 0 (no position), so it reopens at its end, not at an old offset.
  const persistScrollOffset = useCallback(
    (targetSessionId: string, offset: number) => {
      const stuck = stickToEndRef.current || sendScrollPendingRef.current;
      if (!stuck && isProgrammaticScroll()) return;
      const value = stuck ? 0 : offset;
      if (value === lastSavedOffsetRef.current) return;
      if (value !== 0 && Math.abs(value - lastSavedOffsetRef.current) < 24) return;
      lastSavedOffsetRef.current = value;
      useTabStore.getState().setTabState(targetSessionId, { scrollOffset: value });
    },
    [isProgrammaticScroll],
  );

  useEffect(() => {
    lastSavedOffsetRef.current = savedScrollOffset;
    currentOffsetRef.current = savedScrollOffset;
    return () => {
      persistScrollOffset(sessionId, currentOffsetRef.current);
    };
  }, [sessionId, savedScrollOffset, persistScrollOffset]);

  // A user scroll that comes to rest near the end sticks to it again. At finger
  // lift the event carries the drag velocity; with momentum following, the
  // decision waits for onMomentumScrollEnd.
  const settleScroll = useCallback(
    (
      event: NativeSyntheticEvent<NativeScrollEvent>,
      velocityY: number | undefined,
      targetOffsetY: number | undefined,
    ) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offset = Math.max(0, contentOffset.y || 0);
      currentOffsetRef.current = offset;
      const programmatic = isProgrammaticScroll();
      if (!programmatic) {
        settledNearEndRef.current = isNearEnd(offset, contentSize.height, layoutMeasurement.height);
      }
      if (
        shouldRearmStick({
          offset,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
          programmatic,
          velocityY,
          targetOffsetY,
        })
      ) {
        stickToEndRef.current = true;
      }
      persistScrollOffset(sessionId, offset);
    },
    [sessionId, persistScrollOffset, isProgrammaticScroll],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // iOS only: where the scroll comes to rest after finger lift.
      const target = event.nativeEvent.targetContentOffset;
      settleScroll(
        event,
        event.nativeEvent.velocity?.y ?? 0,
        target ? Math.max(0, target.y || 0) : undefined,
      );
    },
    [settleScroll],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => settleScroll(event, undefined, undefined),
    [settleScroll],
  );

  // A user drag releases the stick and ends any programmatic window.
  const handleScrollBeginDrag = useCallback(() => {
    stickToEndRef.current = false;
    releasedByTouchRef.current = false;
    sendScrollPendingRef.current = false;
    clearSendScrollTimer();
    programmaticScrollUntilRef.current = 0;
  }, [clearSendScrollTimer]);

  // A touch on an idle thread releases the stick, so a card the user expands
  // opens in place. While busy, touches keep following the stream.
  const handleListTouchStart = useCallback(() => {
    if (stickToEndRef.current && shouldReleaseStickOnTouch({ isBusy })) {
      stickToEndRef.current = false;
      releasedByTouchRef.current = true;
    }
  }, [isBusy]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offset = Math.max(0, contentOffset.y || 0);
      const prevOffset = currentOffsetRef.current;
      currentOffsetRef.current = offset;
      if (
        stickToEndRef.current &&
        shouldReleaseStick({
          prevOffset,
          offset,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
          programmatic: isProgrammaticScroll(),
        })
      ) {
        stickToEndRef.current = false;
        releasedByTouchRef.current = false;
        settledNearEndRef.current = false;
      }
    },
    [isProgrammaticScroll],
  );

  const handleContentSizeChange = useCallback(() => {
    if (stickToEndRef.current) scrollToEndNow();
  }, [scrollToEndNow]);

  // The viewport shrinks when the keyboard opens; keep the end in view.
  const handleListLayout = useCallback(() => {
    if (stickToEndRef.current) scrollToEndNow();
  }, [scrollToEndNow]);

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

  // Track last turn height for footer sizing. The spacer fills the viewport
  // below a short last turn: `max(0, spacerCap - lastTurnHeight)`.
  // Header chrome subtracts header (~60+insets), input (~90+insets), and footer
  // bar (~50). 'floating' chrome has no header but adds the ~48pt+8pt tab dock
  // below the composer (+64), and its container no longer overlaps upward by
  // 24 (no -24 sheet margin), so the reserved chrome grows by 88 total.
  const spacerCap = windowHeight - insets.top - insets.bottom - (effectiveChrome === 'floating' ? 283 : 195);
  const [lastTurnHeight, setLastTurnHeight] = useState(80);
  const lastTurnHeightRef = useRef(80);

  // Streaming grows the last turn on every wrapped line. Set state only when
  // the resulting spacer height changes; once the turn is taller than the
  // viewport the spacer stays at 0 and no render is needed.
  const handleLastTurnLayout = useCallback(
    (e: { nativeEvent: { layout: { height: number } } }) => {
      const h = e.nativeEvent.layout.height;
      const prev = lastTurnHeightRef.current;
      lastTurnHeightRef.current = h;
      if (shouldUpdateSpacer(prev, h, spacerCap)) setLastTurnHeight(h);
    },
    [spacerCap],
  );

  // A cap change (window resize) invalidates the skipped updates above.
  useEffect(() => {
    setLastTurnHeight(lastTurnHeightRef.current);
  }, [spacerCap]);

  // Only the last turn receives status and busy; other turns get stable values,
  // so their memoized rows skip stream renders. `isLast` (working state)
  // follows the last user message in store order, as the SDK does; the spacer
  // follows the displayed order. Every turn gets `pendingQuestions` (one
  // stable store array) so a pending question tool part is hidden in
  // whichever turn holds it.
  const renderTurn = useCallback(
    ({ item }: { item: Turn }) => {
      const id = item.userMessage.info.id;
      const isLast = id === lastUserMessageId;
      const isLastDisplayed = id === lastTurnId;
      return (
        <View onLayout={isLastDisplayed ? handleLastTurnLayout : undefined}>
          <SessionTurn
            turn={item}
            isLast={isLast}
            sessionStatus={isLast ? sessionStatus : undefined}
            isBusy={isLast ? isBusy : false}
            pendingQuestions={pendingQuestions}
            agentNames={agentNames}
            onFileMention={handleFileMention}
            onSessionMention={handleSessionMention}
            commands={commands}
          />
        </View>
      );
    },
    [lastUserMessageId, lastTurnId, handleLastTurnLayout, sessionStatus, isBusy, pendingQuestions, agentNames, handleFileMention, handleSessionMention, commands],
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
           shows it, Jay 2026-09-16). */
        <FloatingMenuButton onPress={onOpenDrawer} />
      )}

      {/* Messages + Fresh Session Hero — flat continuation of the page
          surface (the rounded "sheet" card treatment was removed app-wide). */}
      <View style={{ flex: 1 }} className="bg-background">
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
          ListFooterComponent={
            <View>
              {isCompacting && (
                <View style={{ paddingHorizontal: 20, paddingVertical: 16 }}>
                  {/* Divider with Compaction badge */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06) }} />
                    <View style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 10, paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                      borderWidth: 1,
                      borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                    }}>
                      <StackIcon size={12} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, letterSpacing: 0.3 }}>
                        Compaction
                      </RNText>
                    </View>
                    <View style={{ flex: 1, height: 1, backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06) }} />
                  </View>
                  {/* Compacting indicator */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {isDark ? (
                      <KortixSymbolWhite width={14} height={14} />
                    ) : (
                      <KortixSymbolBlack width={14} height={14} />
                    )}
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground }}>
                      Compacting session...
                    </RNText>
                  </View>
                </View>
              )}
              <View
                style={{
                  // Fill remaining viewport so the last turn's user bubble
                  // sits at the top (see spacerCap).
                  height: Math.max(0, spacerCap - lastTurnHeight),
                }}
              />
            </View>
          }
          onScrollToIndexFailed={handleScrollToIndexFailed}
        />

        <FreshSessionHero
          projectName={projectName}
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

      {/* Bottom area — question prompt OR chat input */}
      <View
        style={
          onboardingMode
            ? { paddingBottom: insets.bottom }
            : effectiveChrome === 'floating'
              ? { paddingBottom: insets.bottom + 64 }
              : undefined
        }
      >
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
            modelKey={resolvedModelKey}
            variant={resolved.variant}
            variants={resolvedVariants}
            onAgentChange={handleAgentChange}
            onModelChange={handleModelChange}
            onVariantCycle={handleVariantCycle}
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
      </View>

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
    </KeyboardAvoidingView>
  );
}

/**
 * Memoized so a parent render with unchanged props does not re-render the
 * thread. Callers pass stable callbacks.
 */
export const SessionPage = React.memo(SessionPageImpl);

/**
 * FreshSessionHero — the project greeting centred in the message area of a
 * chat with no messages yet. Same `ProjectGreeting` as ProjectHome, so a new
 * chat opens onto the surface the project home showed.
 */
function FreshSessionHero({
  projectName,
  opacity,
  visible,
}: {
  projectName?: string;
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
        paddingHorizontal: 32,
        opacity,
      }}
    >
      <Animated.View style={{ transform: [{ translateY }] }}>
        <ProjectGreeting projectName={projectName} />
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

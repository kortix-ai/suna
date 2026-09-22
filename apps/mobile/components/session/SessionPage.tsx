/**
 * SessionPage — the full session chat view.
 *
 * Addressed by (projectId, sessionId) in KORTIX ids, and driven entirely by
 * `useSession` from `@kortix/sdk/react` — the same hook apps/web, the Electron
 * desktop app, the TUI and the whitelabel demo use.
 *
 * That is what gives this screen saved transcript history: `useSession` drives
 * `useSessionTranscriptHistory`, which reads the durable server-side mirror, so
 * a stopped or still-waking session paints its thread from PostgreSQL instead
 * of showing nothing until the sandbox answers. The previous implementation
 * could not do this at any price — every read was keyed on a live sandbox url.
 */

import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import {
  View,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  Animated,
  Platform,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Menu as MenuIcon, X as CloseIcon } from 'lucide-react-native';
import { Text as RNText } from 'react-native';

import { groupMessagesIntoTurns, updateProjectSession } from '@kortix/sdk';
import { toSessionPickerItems } from '@/lib/sessions/session-picker-item';
import {
  useSession,
  useProjectSession,
  useProjectSessions,
  flattenProjectSessionPages,
  qk,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import type { Turn, QuestionRequest } from '@/lib/opencode/types';
import { useTabStore } from '@/stores/tab-store';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import type { QueuedMessage } from '@/stores/message-queue-store';
import { useCompactionStore } from '@/stores/compaction-store';
import {
  useOpenCodeAgents,
  useOpenCodeModels,
  useOpenCodeConfig,
  useOpenCodeCommands,
  type Command,
} from '@/lib/opencode/hooks/use-opencode-data';
import { useResolvedConfig } from '@/lib/opencode/hooks/use-local-config';
import { log } from '@/lib/logger';

import { SessionChatInput, type PromptOptions, type TrackedMention } from './SessionChatInput';
import { SandboxHealthPill } from './SandboxHealthPill';
import { useRouter } from 'expo-router';
import { SessionTurn } from './SessionTurn';
import { QuestionPrompt } from './QuestionPrompt';
import { FileViewer } from '@/components/files/FileViewer';
import type { SandboxFile } from '@/api/types';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

// AnimatedToggleIcon was extracted to components/ui/animated-toggle-icon.tsx
// so it can be shared with PageHeader and page-level headers across the app.
import { AnimatedToggleIcon } from '@/components/ui/animated-toggle-icon';

interface SessionPageProps {
  /** Kortix project id. Sessions are addressed as (projectId, sessionId). */
  projectId: string;
  /**
   * Kortix session id — NOT an OpenCode session id.
   *
   * This app used to pass the OpenCode id and read everything off the live
   * sandbox, which is why a stopped session showed nothing: every read was
   * keyed on a sandbox that was not running. The durable transcript mirror is
   * keyed by the KORTIX session, so addressing a session the way the rest of
   * Kortix does is what lets saved history paint before the box wakes.
   */
  sessionId: string;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  /** True when the left drawer is currently open — swaps the menu icon for an X */
  isDrawerOpen?: boolean;
  /** True when the right drawer is currently open — swaps the grid icon for an X */
  isRightDrawerOpen?: boolean;
  /** Hides drawer buttons, model/variant selectors — used for onboarding */
  onboardingMode?: boolean;
  /** Skip callback shown in header during onboarding */
  onSkipOnboarding?: () => void;
}

export function SessionPage({ projectId, sessionId, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, onboardingMode, onSkipOnboarding }: SessionPageProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const flatListRef = useRef<FlatList>(null);
  const setTabState = useTabStore((s) => s.setTabState);
  const savedSessionState = useTabStore((s) => s.tabStateById[sessionId] as { scrollOffset?: number } | undefined);
  const savedScrollOffset = typeof savedSessionState?.scrollOffset === 'number'
    ? savedSessionState.scrollOffset
    : 0;
  const lastSavedOffsetRef = useRef(savedScrollOffset);
  const didRestoreScrollRef = useRef(false);

  // Auto-scroll tracking
  const isFollowingRef = useRef(true);       // true = scroll with AI output
  const isAutoScrollingRef = useRef(false);  // suppress follow-disable during programmatic scrolls
  const listHeightRef = useRef(0);           // visible list viewport height
  const contentHeightRef = useRef(0);        // total scrollable content height
  const AT_BOTTOM_THRESHOLD = 80;            // px from bottom considered "at bottom"



  // ── The whole session, in one hook ──────────────────────────────────────
  //
  // This replaced five host-side mechanisms: a REST session read keyed on the
  // sandbox url, a second Zustand sync store, a bespoke `useSessionSync`, a
  // hand-rolled SSE mount, and the 40-line `GET /question` self-heal poll
  // below it. `useSession` owns all of them — /start, the sandbox switch, the
  // live stream, id resolution, message sync, and the question self-heal —
  // and, because it is addressed by (projectId, sessionId), it also drives
  // `useSessionTranscriptHistory`. That is what makes a STOPPED session paint
  // its saved transcript from PostgreSQL instead of showing an empty thread
  // until the box wakes.
  //
  // `replayStartStash: false`: this app hands the first prompt over itself
  // (`handleCreateSessionWithPrompt`), so the SDK must not also replay a stash.
  const session = useSession(projectId, sessionId, { replayStartStash: false });
  const { data: sessionRow } = useProjectSession(projectId, sessionId);
  const projectSessionsQuery = useProjectSessions(projectId);
  // `useProjectSessions` pages. `flattenProjectSessionPages` is the SDK's own
  // flattener — it also de-duplicates by session_id, which matters because a
  // session prompted between two page fetches legitimately appears on both.
  const sessionPickerItems = useMemo(
    () => toSessionPickerItems(flattenProjectSessionPages(projectSessionsQuery.data)),
    [projectSessionsQuery.data],
  );

  const safeMessages = session.messages;
  const sessionStatus = session.status;
  const pendingQuestions = session.questions as unknown as QuestionRequest[];
  const isBusy = session.isBusy;
  const isCompacting = session.isCompacting;
  /**
   * The live runtime url, or null until `/start` reports ready.
   *
   * Everything that genuinely needs a RUNNING sandbox — file mentions, the
   * file viewer, the model/agent catalog — reads this rather than a global
   * "current sandbox". Transcript rendering deliberately does not: it must
   * work while this is still null, which is the entire point of the migration.
   */
  const runtimeUrl = session.runtimeUrl;


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
  // Latest-render mirrors of the two drain guards, for the delayed re-check
  // below — a ref, because the 500ms timer must not act on the values that
  // were current when it was scheduled.
  const isBusyRef = useRef(false);
  const hasQuestionRef = useRef(false);
  const queueInFlightRef = useRef<{ queueId: string; sentAt: number } | null>(null);

  // Keep the drain guards' ref mirrors current on every render, so the delayed
  // re-check below reads this render's values rather than the ones captured
  // when its timer was scheduled.
  isBusyRef.current = isBusy;
  hasQuestionRef.current = hasQuestion;


  // ── Send / Stop handlers (defined early so queue drain logic can reference them) ──

  const handleSend = useCallback(
    async (text: string, options: PromptOptions, mentions?: TrackedMention[]) => {
      // Clear the tracked input text so it isn't saved when a question appears
      inputTextRef.current = '';
      // Re-enable auto-scroll follow when user sends a new message
      isFollowingRef.current = true;

      // Process session mentions — append XML refs (same as frontend)
      let finalText = text;
      const sessionMentions = mentions?.filter((m) => m.kind === 'session' && m.value);
      if (sessionMentions && sessionMentions.length > 0) {
        const refs = sessionMentions
          .map((m) => `<session_ref id="${m.value}" title="${m.label}" />`)
          .join('\n');
        finalText = `${text}\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n${refs}`;
      }

      // One call. The optimistic user bubble, the busy state, the wire message
      // id that lets the server's echo settle that bubble instead of
      // duplicating it, and the failure rollback are all `useSession`'s — this
      // used to be a hand-rolled `addOptimisticMessage` + `setStatus('busy')` +
      // raw `POST /prompt_async`, whose optimistic id shared nothing with the
      // id the runtime finally persisted.
      session.send(finalText, {
        model: options.model ?? undefined,
        agent: options.agent ?? undefined,
        variant: options.variant ?? undefined,
      });
    },
    [session],
  );

  const handleStop = useCallback(async () => {
    // `cancel()` aborts the run AND drops pending prompts/questions/permissions,
    // then resolves once the control plane acknowledges. The old version
    // fabricated an idle status locally and fired a bare POST /abort, so the
    // composer flipped back to "Send" before the turn had actually stopped.
    await session.cancel();
  }, [session]);

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

      // Re-check the guards after the delay against the LATEST render's
      // values. This used to reach into the host sync store, which no longer
      // exists; a ref mirror is the equivalent that does not capture the
      // stale `isBusy`/`hasQuestion` from the closure this timer was
      // scheduled in.
      if (isBusyRef.current || hasQuestionRef.current || queueInFlightRef.current) return;

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
  const { data: agents = [] } = useOpenCodeAgents(runtimeUrl ?? undefined);
  const { data: visibleModels = [], allModels = [], defaults } = useOpenCodeModels(runtimeUrl ?? undefined);
  const { data: config } = useOpenCodeConfig(runtimeUrl ?? undefined);
  const { data: commands = [] } = useOpenCodeCommands(runtimeUrl ?? undefined);

  // Resolution uses ALL models (fallback chain); selector shows only visible
  const resolved = useResolvedConfig(agents, allModels, config, defaults);

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

  // Group messages into turns
  const turns = useMemo(() => groupMessagesIntoTurns(safeMessages), [safeMessages]);
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

  // When a new turn appears, scroll so the latest user bubble is at the top
  const prevTurnCount = useRef(turns.length);
  useEffect(() => {
    if (turns.length > prevTurnCount.current) {
      // New turn added — scroll it to the top of the viewport
      const targetIndex = turns.length - 1;
      setTimeout(() => {
        try {
          flatListRef.current?.scrollToIndex({
            index: targetIndex,
            viewPosition: 0,
            viewOffset: 0,
            animated: true,
          });
        } catch {
          flatListRef.current?.scrollToEnd({ animated: true });
        }
      }, 150);
    }
    prevTurnCount.current = turns.length;
  }, [turns.length]);

  // Restore scroll position when reopening this tab/session.
  useEffect(() => {
    if (didRestoreScrollRef.current) return;
    if (savedScrollOffset <= 0) {
      didRestoreScrollRef.current = true;
      return;
    }
    if (turns.length === 0) return;
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToOffset({
        offset: savedScrollOffset,
        animated: false,
      });
      didRestoreScrollRef.current = true;
    }, 60);
    return () => clearTimeout(timer);
  }, [savedScrollOffset, turns.length]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y || 0);

      // Determine if user is near the bottom
      const distanceFromBottom = contentHeightRef.current - offset - listHeightRef.current;
      const atBottom = distanceFromBottom <= AT_BOTTOM_THRESHOLD;

      if (isAutoScrollingRef.current) {
        // This scroll event was triggered programmatically — don't touch follow state
      } else if (atBottom) {
        // User scrolled back to the bottom — resume following
        isFollowingRef.current = true;
      } else {
        // User scrolled up manually — stop following
        isFollowingRef.current = false;
      }

      if (Math.abs(offset - lastSavedOffsetRef.current) < 24) return;
      lastSavedOffsetRef.current = offset;
      setTabState(sessionId, { scrollOffset: offset });
    },
    [sessionId, setTabState],
  );

  // Auto-scroll to bottom while AI is typing, if user hasn't scrolled up
  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      contentHeightRef.current = h;
      if (isBusy && isFollowingRef.current) {
        isAutoScrollingRef.current = true;
        flatListRef.current?.scrollToEnd({ animated: false });
        // Reset flag after scroll event propagates
        setTimeout(() => { isAutoScrollingRef.current = false; }, 80);
      }
    },
    [isBusy],
  );

  const handleListLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      listHeightRef.current = event.nativeEvent.layout.height;
    },
    [],
  );

  // ── Question reply / reject ─────────────────────────────────────────────
  //
  // `answerQuestion`/`rejectQuestion` only drop the question from local state
  // once the SERVER accepted the reply, and throw a typed error otherwise. The
  // old handlers removed it optimistically and then had to suppress the id for
  // 10s so their own self-heal poll would not re-add it — a workaround for a
  // race that no longer exists, because nothing here re-polls.
  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      try {
        await session.answerQuestion(requestId, answers);
      } catch (err: any) {
        log.error('Failed to reply to question:', err?.message || err);
      }
    },
    [session],
  );

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      try {
        await session.rejectQuestion(requestId);
      } catch (err: any) {
        log.error('Failed to reject question:', err?.message || err);
      }
      // Also abort the session (matches frontend behavior)
      handleStop();
    },
    [session, handleStop],
  );

  // Command handler — executes a slash command through the session runtime.
  const handleCommand = useCallback(
    async (cmd: Command, args?: string) => {
      try {
        await session.runCommand(cmd.name, args || '', {
          agent: resolved.agent?.name,
          model: resolved.modelKey ?? undefined,
          variant: resolved.variant ?? undefined,
        });
      } catch (err: any) {
        log.error('[SessionPage] Command error:', err?.message || err);
      }
    },
    [session, resolved.agent, resolved.modelKey, resolved.variant],
  );

  // Track last turn height for footer sizing
  const turnHeights = useRef<Record<string, number>>({});
  const [lastTurnHeight, setLastTurnHeight] = useState(80);

  const renderTurn = useCallback(
    ({ item, index }: { item: Turn; index: number }) => (
      <View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          turnHeights.current[item.userMessage.info.id] = h;
          // Update footer when the last turn's height changes
          if (index === turns.length - 1) {
            setLastTurnHeight(h);
          }
        }}
      >
        <SessionTurn
          turn={item}
          allMessages={safeMessages}
          sessionStatus={sessionStatus}
          isBusy={isBusy}
          pendingQuestions={pendingQuestions}
          agentNames={agentNames}
          onFileMention={handleFileMention}
          onSessionMention={handleSessionMention}
          commands={commands}
        />
      </View>
    ),
    [safeMessages, sessionStatus, isBusy, turns.length, pendingQuestions, agentNames, handleFileMention, handleSessionMention, commands],
  );

  // The Kortix session row owns the name, so a rename survives the sandbox
  // stopping — the OpenCode session title did not.
  const title = sessionRow?.name || 'New Session';

  // ── Inline title edit ──────────────────────────────────────────────────
  // Tap the title → it becomes a TextInput in place. Commit on blur or Return;
  // revert if the user clears the field. Disabled in onboarding mode.
  const queryClient = useQueryClient();
  const titleInputRef = useRef<TextInput>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);

  const beginTitleEdit = useCallback(() => {
    if (onboardingMode) return;
    const current = sessionRow?.name || '';
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
  }, [onboardingMode, sessionRow?.name]);

  const commitTitleEdit = useCallback(() => {
    if (!isEditingTitle) return;
    const trimmed = titleDraft.trim();
    const previous = (sessionRow?.name || '').trim();
    setIsEditingTitle(false);
    // No change or empty → revert silently
    if (!trimmed || trimmed === previous) return;
    void updateProjectSession(projectId, sessionId, { name: trimmed })
      .then(() => {
        // Refresh both the row this header reads and the list the tab bar and
        // session picker read, so the new name appears everywhere at once.
        void queryClient.invalidateQueries({ queryKey: qk.project.session(projectId, sessionId) });
        void queryClient.invalidateQueries({ queryKey: qk.project.sessions(projectId) });
      })
      .catch((err: any) => log.error('Failed to rename session:', err?.message || err));
  }, [isEditingTitle, titleDraft, sessionRow?.name, projectId, sessionId, queryClient]);

  const cancelTitleEdit = useCallback(() => {
    setIsEditingTitle(false);
    setTitleDraft(sessionRow?.name || '');
  }, [sessionRow?.name]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      className="bg-background"
    >
      {/* Header — matches dashboard layout exactly */}
      <View
        style={{ paddingTop: insets.top, paddingBottom: 36 }}
        className="px-4 bg-chrome-background"
      >
        <View className="flex-row items-center">
          {!onboardingMode && (
            <TouchableOpacity
              onPress={onOpenDrawer}
              className="mr-3 p-1"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <AnimatedToggleIcon open={!!isDrawerOpen} color={isDark ? '#F8F8F8' : '#121215'} icon="menu-lucide" size={20} />
            </TouchableOpacity>
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
                  backgroundColor: pendingQuestions.length > 0 ? '#F59E0B' : '#10B981',
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
                placeholderTextColor={isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)'}
                style={{
                  flex: 1,
                  fontSize: 16,
                  fontFamily: 'Roobert-Medium',
                  color: isDark ? '#F8F8F8' : '#121215',
                  padding: 0,
                  margin: 0,
                }}
              />
            ) : (
              <TouchableOpacity
                onPress={beginTitleEdit}
                disabled={onboardingMode}
                activeOpacity={onboardingMode ? 1 : 0.7}
                className="flex-1"
                hitSlop={{ top: 8, bottom: 8 }}
              >
                <Text
                  className="text-base font-medium text-muted-foreground"
                  numberOfLines={1}
                >
                  {title}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {!onboardingMode && (
            <TouchableOpacity
              onPress={onOpenRightDrawer}
              className="ml-3 p-1"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <AnimatedToggleIcon open={!!isRightDrawerOpen} color={isDark ? '#F8F8F8' : '#121215'} icon="apps-outline" size={20} />
            </TouchableOpacity>
          )}
          {onboardingMode && onSkipOnboarding && (
            <TouchableOpacity
              onPress={onSkipOnboarding}
              className="ml-3 py-1 px-3"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.4)' }}>
                Skip
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Messages + Fresh Session Hero */}
      <View
        style={{
          flex: 1,
          marginTop: -24,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: 'hidden',
          borderTopWidth: 2,
          borderLeftWidth: 2,
          borderRightWidth: 2,
          borderColor: isDark ? '#222222' : '#e6e6e5',
        }}
        className="bg-background"
      >
        <FlatList
          ref={flatListRef}
          data={turns}
          renderItem={renderTurn}
          keyExtractor={(item, index) => `${item.userMessage.info.id}:${index}`}
          contentContainerStyle={{ paddingTop: 16 }}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleListScroll}
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
                    <View style={{ flex: 1, height: 1, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
                    <View style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 10, paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                      borderWidth: 1,
                      borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    }}>
                      <Ionicons name="layers-outline" size={12} color={isDark ? '#888' : '#666'} />
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: isDark ? '#888' : '#666', letterSpacing: 0.3 }}>
                        Compaction
                      </RNText>
                    </View>
                    <View style={{ flex: 1, height: 1, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
                  </View>
                  {/* Compacting indicator */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {isDark ? (
                      <KortixSymbolWhite width={14} height={14} />
                    ) : (
                      <KortixSymbolBlack width={14} height={14} />
                    )}
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: isDark ? '#888' : '#666' }}>
                      Compacting session...
                    </RNText>
                  </View>
                </View>
              )}
              <View
                style={{
                  // Fill remaining viewport so the last turn's user bubble
                  // sits at the top. Subtract: header (~60+insets), input (~90+insets),
                  // footer bar (~50), and the actual measured last turn height.
                  height: Math.max(0, windowHeight - insets.top - insets.bottom - 195 - lastTurnHeight),
                }}
              />
            </View>
          }
          onScrollToIndexFailed={(info) => {
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({
                index: info.index,
                viewPosition: 0,
                viewOffset: 0,
                animated: true,
              });
            }, 200);
          }}
        />

        <FreshSessionHero
          isDark={isDark}
          opacity={heroOpacity}
          visible={showFreshHero}
          windowWidth={windowWidth}
        />
      </View>

      {/* Fade gradient above input — only when textarea is shown */}
      {!hasQuestion && (
        <LinearGradient
          colors={isDark ? ['rgba(13,13,13,0)', 'rgba(13,13,13,1)'] : ['rgba(255,255,255,0)', 'rgba(255,255,255,1)']}
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
      <View style={onboardingMode ? { paddingBottom: insets.bottom } : undefined}>
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
            onTextChange={(t) => { inputTextRef.current = t; }}
            agent={resolved.agent}
            agents={resolved.agents}
            model={resolved.model}
            models={visibleModels}
            modelKey={resolved.modelKey}
            variant={resolved.variant}
            variants={resolved.variants}
            onAgentChange={resolved.setAgent}
            onModelChange={(pid, mid) => resolved.setModel(pid, mid, { explicit: true })}
            onVariantCycle={resolved.cycleVariant}
            onVariantSet={resolved.setVariant}
            sessions={sessionPickerItems}
            currentSessionId={sessionId}
            sandboxUrl={runtimeUrl ?? undefined}
            onEnqueue={handleEnqueue}
            commands={commands}
            onCommand={handleCommand}
            inputSlot={
              queuedMessages.length > 0 ? (
                <QueuePanel
                  messages={queuedMessages}
                  expanded={queueExpanded}
                  onToggle={() => setQueueExpanded((v) => !v)}
                  onRemove={queueRemove}
                  onMoveUp={queueMoveUp}
                  onMoveDown={queueMoveDown}
                  onClear={() => queueClearSession(sessionId)}
                  onSendNow={handleQueueSendNow}
                  isDark={isDark}
                />
              ) : undefined
            }
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
        sandboxUrl={runtimeUrl ?? undefined}
      />
    </KeyboardAvoidingView>
  );
}

function getGreetingLabel(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function FreshSessionHero({
  isDark,
  opacity,
  visible,
  windowWidth,
}: {
  isDark: boolean;
  opacity: Animated.Value;
  visible: boolean;
  windowWidth: number;
}) {
  const Symbol = isDark ? KortixSymbolWhite : KortixSymbolBlack;
  const greeting = useMemo(() => getGreetingLabel(), []);
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(14)).current;
  const leftOffset = (windowWidth - 393) / 2;

  useEffect(() => {
    if (visible) {
      logoOpacity.setValue(0);
      textOpacity.setValue(0);
      textTranslateY.setValue(14);

      // Logo: fade-in only
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 520,
        useNativeDriver: true,
      }).start();

      // Greeting: fade + gentle rise
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 620,
          useNativeDriver: true,
        }),
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 760,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, logoOpacity, textOpacity, textTranslateY]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        opacity,
      }}
    >
      {/* Logo + greeting share the same absolutely-positioned box so the
          text stays centered in the logo regardless of screen height. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: -80 + leftOffset,
          width: 554,
          height: 462,
        }}
      >
        <Animated.View
          style={{
            ...StyleSheet.absoluteFillObject,
            opacity: Animated.multiply(logoOpacity, 0.4),
          }}
        >
          <Symbol width={554} height={462} />
        </Animated.View>

        <Animated.View
          style={{
            ...StyleSheet.absoluteFillObject,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: textOpacity,
            transform: [{ translateY: textTranslateY }],
          }}
        >
          <RNText
            style={{
              fontSize: 14,
              fontFamily: 'Roobert',
              color: isDark ? 'rgba(248,248,248,0.46)' : 'rgba(18,18,21,0.4)',
              letterSpacing: 0.28,
            }}
          >
            {greeting}
          </RNText>
        </Animated.View>
      </View>
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
  const bgColor = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const mutedText = isDark ? '#888' : '#999';
  const fgText = isDark ? '#ccc' : '#444';

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
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <Ionicons
          name="list-outline"
          size={14}
          color={mutedText}
          style={{ marginRight: 6 }}
        />
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
        <TouchableOpacity
          onPress={() => onClear()}
          hitSlop={8}
          style={{ marginRight: 8 }}
        >
          <Ionicons name="close" size={14} color={mutedText} />
        </TouchableOpacity>
        {/* Expand/collapse chevron */}
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={mutedText}
        />
      </TouchableOpacity>

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
                  <TouchableOpacity
                    onPress={() => onSendNow(qm.id)}
                    hitSlop={6}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="send" size={12} color={isDark ? '#60a5fa' : '#3b82f6'} />
                  </TouchableOpacity>
                  {/* Move up */}
                  {idx > 0 && (
                    <TouchableOpacity
                      onPress={() => onMoveUp(qm.id)}
                      hitSlop={6}
                      style={{ padding: 4 }}
                    >
                      <Ionicons name="arrow-up" size={12} color={mutedText} />
                    </TouchableOpacity>
                  )}
                  {/* Move down */}
                  {idx < messages.length - 1 && (
                    <TouchableOpacity
                      onPress={() => onMoveDown(qm.id)}
                      hitSlop={6}
                      style={{ padding: 4 }}
                    >
                      <Ionicons name="arrow-down" size={12} color={mutedText} />
                    </TouchableOpacity>
                  )}
                  {/* Remove */}
                  <TouchableOpacity
                    onPress={() => onRemove(qm.id)}
                    hitSlop={6}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="close" size={12} color={mutedText} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

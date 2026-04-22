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
import { Icon } from '@/components/ui/icon';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text as RNText } from 'react-native';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { useSessionSync } from '@/lib/opencode/session-sync';
import { groupMessagesIntoTurns } from '@/lib/opencode/turns';
import type { Turn, QuestionRequest, ToolPart } from '@/lib/opencode/types';
import { useSession, replyToQuestion, rejectQuestion, forkSession, useRenameSession } from '@/lib/platform/hooks';
import { useTabStore } from '@/stores/tab-store';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import type { QueuedMessage } from '@/stores/message-queue-store';
import { useCompactionStore } from '@/stores/compaction-store';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useOpenCodeAgents,
  useOpenCodeModels,
  useOpenCodeConfig,
  useOpenCodeCommands,
  type Command,
} from '@/lib/opencode/hooks/use-opencode-data';
import { useResolvedConfig } from '@/lib/opencode/hooks/use-local-config';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

import { SessionChatInput, type PromptOptions, type TrackedMention } from './SessionChatInput';
import { ProjectPicker } from './ProjectPicker';
import { useAudioRecorder } from '@/hooks/media/useAudioRecorder';
import { useAudioRecordingHandlers } from '@/hooks/media/useAudioRecordingHandlers';
import { transcribeAudio } from '@/lib/chat/transcription';
import { SessionTurn } from './SessionTurn';
import { QuestionPrompt } from './QuestionPrompt';
import { useSessions } from '@/lib/platform/hooks';
import { FileViewer } from '@/components/files/FileViewer';
import type { SandboxFile } from '@/api/types';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

// AnimatedToggleIcon was extracted to components/ui/animated-toggle-icon.tsx
// so it can be shared with PageHeader and page-level headers across the app.
import { AnimatedToggleIcon } from '@/components/ui/animated-toggle-icon';

interface SessionPageProps {
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

export function SessionPage({ sessionId, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, onboardingMode, onSkipOnboarding }: SessionPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { sandboxUrl } = useSandboxContext();
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



  // Session metadata
  const { data: session } = useSession(sandboxUrl, sessionId);
  const { data: allSessions = [] } = useSessions(sandboxUrl);

  // Fork origin — check server parentID and AsyncStorage fallback
  const [forkParentId, setForkParentId] = useState<string | null>(null);
  useEffect(() => {
    const parentFromServer = (session as any)?.parentID;
    if (parentFromServer) {
      setForkParentId(parentFromServer);
      return;
    }
    AsyncStorage.getItem(`fork_origin_${sessionId}`).then((val) => {
      if (val) setForkParentId(val);
    });
  }, [sessionId, session]);
  const { data: parentSession } = useSession(sandboxUrl, forkParentId ?? undefined);

  // Hydrate messages from REST on mount; SSE keeps store updated after
  useSessionSync(sandboxUrl, sessionId);

  // Read messages from sync store
  const messages = useSyncStore((s) => s.messages[sessionId]);
  const sessionStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
  const pendingQuestions = useSyncStore((s) => s.questions[sessionId]) ?? [];
  const safeMessages = useMemo(() => messages ?? [], [messages]);

  const isBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const isCompacting = useCompactionStore((s) => Boolean(s.compactingBySession[sessionId]));

  // ── Self-heal: restore pending questions after reload ──────────────────
  // Matches the frontend's pattern: detect running question tool parts in
  // messages, and if the store has no pending questions, poll GET /question.
  // Track recently-replied question IDs to avoid re-adding them before the
  // server processes the reply.
  const suppressedQuestionIds = useRef(new Set<string>());

  const hasRunningQuestionTool = useMemo(() => {
    if (!safeMessages || safeMessages.length === 0) return false;
    return safeMessages.some((m) => {
      if (m.info.role !== 'assistant') return false;
      return m.parts.some((p) => {
        if (p.type !== 'tool') return false;
        const tool = p as ToolPart;
        return tool.tool === 'question' && (tool.state.status === 'running' || tool.state.status === 'pending');
      });
    });
  }, [safeMessages]);

  // Poll for pending questions when:
  // - A question tool part is running/pending in messages, OR session is busy
  // - AND no pending questions in the store
  const shouldPollQuestions = (hasRunningQuestionTool || isBusy) && pendingQuestions.length === 0 && !!sandboxUrl;

  useEffect(() => {
    if (!shouldPollQuestions || !sandboxUrl) return;
    let cancelled = false;
    let inFlight = false;

    const hydrateQuestions = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const token = await getAuthToken();
        const res = await fetch(`${sandboxUrl}/question`, {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!res.ok || cancelled) return;
        const questions = await res.json();
        if (!Array.isArray(questions) || cancelled) return;
        const store = useSyncStore.getState();
        const existingIds = new Set((store.questions[sessionId] || []).map((q) => q.id));
        for (const q of questions) {
          if (q.sessionID === sessionId && !existingIds.has(q.id) && !suppressedQuestionIds.current.has(q.id)) {
            store.addQuestion(sessionId, q);
            log.log('🔄 [SessionPage] Self-healed pending question:', q.id);
          }
        }
      } catch {} finally {
        inFlight = false;
      }
    };

    hydrateQuestions();
    const timer = setInterval(hydrateQuestions, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [shouldPollQuestions, sandboxUrl, sessionId]);

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
  const queueInFlightRef = useRef<{ queueId: string; sentAt: number } | null>(null);


  // ── Audio recording ──

  const audioRecorder = useAudioRecorder();
  // Dummy agent manager shape for useAudioRecordingHandlers compatibility
  const dummyAgentManager = useMemo(() => ({ selectedAgent: null } as any), []);

  // Track transcribed text to inject into SessionChatInput
  const [pendingTranscription, setPendingTranscription] = useState<string | null>(null);
  const transcribeAndAddToInput = useCallback(async (audioUri: string) => {
    const transcribedText = await transcribeAudio(audioUri);
    if (transcribedText) {
      setPendingTranscription(transcribedText);
    }
  }, []);

  const audioHandlers = useAudioRecordingHandlers(audioRecorder, dummyAgentManager, transcribeAndAddToInput);

  // ── Send / Stop handlers (defined early so queue drain logic can reference them) ──

  const handleSend = useCallback(
    async (text: string, options: PromptOptions, mentions?: TrackedMention[]) => {
      if (!sandboxUrl) return;

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

      // Optimistic user message
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
          useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
        } else {
          log.log('[SessionPage] Prompt sent (async)');
        }
      } catch (err: any) {
        log.error('[SessionPage] Prompt error:', err?.message || err);
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
  const { data: agents = [] } = useOpenCodeAgents(sandboxUrl);
  const { data: visibleModels = [], allModels = [], defaults } = useOpenCodeModels(sandboxUrl);
  const { data: config } = useOpenCodeConfig(sandboxUrl);
  const { data: commands = [] } = useOpenCodeCommands(sandboxUrl);

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
      useSyncStore.getState().setStatus(sessionId, { type: 'busy' });
      try {
        const token = await getAuthToken();
        const payload: Record<string, any> = {
          command: cmd.name,
          arguments: args || '',
        };
        if (resolved.agent?.name) payload.agent = resolved.agent.name;
        if (resolved.modelKey) payload.model = `${resolved.modelKey.providerID}/${resolved.modelKey.modelID}`;
        if (resolved.variant) payload.variant = resolved.variant;

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
    [sandboxUrl, sessionId, resolved.agent, resolved.modelKey, resolved.variant],
  );

  // Fork handler — forks session at the given assistant message
  const handleFork = useCallback(
    async (assistantMessageId: string) => {
      if (!sandboxUrl) return;

      // The server copies all messages BEFORE the given messageID (exclusive).
      // To include the assistant message the user clicked on, we pass the ID
      // of the NEXT message after it as the cut-off.
      let forkAtMessageId: string | undefined;
      if (safeMessages.length > 0) {
        const idx = safeMessages.findIndex((m) => m.info.id === assistantMessageId);
        if (idx >= 0 && idx < safeMessages.length - 1) {
          forkAtMessageId = safeMessages[idx + 1].info.id;
        }
        // else: last message — omit messageID to copy all
      }

      try {
        const forkedSession = await forkSession(sandboxUrl, sessionId, forkAtMessageId);
        // Store fork origin so the forked session can show "Forked from" banner
        AsyncStorage.setItem(`fork_origin_${forkedSession.id}`, sessionId);
        useTabStore.getState().navigateToSession(forkedSession.id);
      } catch (err: any) {
        log.error('Failed to fork session:', err?.message || err);
      }
    },
    [sandboxUrl, sessionId, safeMessages],
  );

  // Fork with edited prompt — forks at the user message and pre-fills new text
  const handleEditFork = useCallback(
    async (messageId: string, editedText: string) => {
      if (!sandboxUrl) return;
      try {
        // Fork at this message (exclusive — copies everything before it)
        const forkedSession = await forkSession(sandboxUrl, sessionId, messageId);
        AsyncStorage.setItem(`fork_origin_${forkedSession.id}`, sessionId);
        // Stash the edited prompt so the new session can pre-fill it
        AsyncStorage.setItem(`fork_prompt_${forkedSession.id}`, editedText);
        useTabStore.getState().navigateToSession(forkedSession.id);
      } catch (err: any) {
        log.error('Failed to edit-fork session:', err?.message || err);
      }
    },
    [sandboxUrl, sessionId],
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
          onFork={handleFork}
          onEditFork={handleEditFork}
          agentNames={agentNames}
          onFileMention={handleFileMention}
          onSessionMention={handleSessionMention}
          commands={commands}
        />
      </View>
    ),
    [safeMessages, sessionStatus, isBusy, turns.length, pendingQuestions, handleFork, handleEditFork, agentNames, handleFileMention, handleSessionMention, commands],
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
      {/* Header — matches dashboard layout exactly */}
      <View
        style={{ paddingTop: insets.top, paddingBottom: 36 }}
        className="px-4 bg-muted"
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
            {isBusy && !onboardingMode && !isEditingTitle && (
              <View className="flex-row items-center mt-0.5">
                <View className="h-1.5 w-1.5 rounded-full bg-muted-foreground mr-1" />
                <Text className="text-xs text-muted-foreground">Working</Text>
              </View>
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
          borderTopWidth: StyleSheet.hairlineWidth,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
        }}
        className="bg-background"
      >
        <FlatList
          ref={flatListRef}
          data={turns}
          renderItem={renderTurn}
          keyExtractor={(item) => item.userMessage.info.id}
          contentContainerStyle={{ paddingTop: 16 }}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleListScroll}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleListLayout}
          ListHeaderComponent={
            forkParentId ? (
              <ForkBanner
                parentTitle={parentSession?.title}
                onPress={() => useTabStore.getState().navigateToSession(forkParentId)}
                isDark={isDark}
              />
            ) : null
          }
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
          colors={isDark ? ['rgba(18,18,21,0)', 'rgba(18,18,21,1)'] : ['rgba(255,255,255,0)', 'rgba(255,255,255,1)']}
          style={{ height: 24, marginTop: -24, zIndex: 1 }}
          pointerEvents="none"
        />
      )}

      {/* Project picker — only on fresh sessions, above the chat input.
          Mirrors the web's dashboard/empty-state ProjectSelector: shared
          selection store so the picked project survives app restarts and
          scopes the next `/kortix/task`-creating send. */}
      {showFreshHero && !onboardingMode && !hasQuestion && (
        <ProjectPicker />
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
            onAudioRecord={audioHandlers.handleStartRecording}
            onCancelRecording={audioHandlers.handleCancelRecording}
            onSendAudio={audioHandlers.handleSendAudio}
            isRecording={audioRecorder.isRecording}
            recordingDuration={audioRecorder.recordingDuration}
            audioLevels={audioRecorder.audioLevels}
            isTranscribing={audioHandlers.isTranscribing}
            pendingTranscription={pendingTranscription}
            onTranscriptionConsumed={() => setPendingTranscription(null)}
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
            sessions={allSessions}
            currentSessionId={sessionId}
            sandboxUrl={sandboxUrl}
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
        sandboxUrl={sandboxUrl}
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

// ---------------------------------------------------------------------------
// ForkBanner — "Forked from {parentTitle}" divider
// ---------------------------------------------------------------------------

function ForkBanner({
  parentTitle,
  onPress,
  isDark,
}: {
  parentTitle?: string;
  onPress: () => void;
  isDark: boolean;
}) {
  const mutedColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.15)';
  const textMuted = isDark ? '#888' : '#999';
  const textColor = isDark ? '#aaa' : '#666';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const pillBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12, gap: 8 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: borderColor }} />
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 20,
          backgroundColor: pillBg,
          borderWidth: 1,
          borderColor,
          gap: 5,
        }}
      >
        <Ionicons name="git-branch-outline" size={11} color={textMuted} />
        <RNText style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Forked from
        </RNText>
        <RNText
          style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: textColor, maxWidth: 120 }}
          numberOfLines={1}
        >
          {parentTitle || 'Parent session'}
        </RNText>
      </TouchableOpacity>
      <View style={{ flex: 1, height: 1, backgroundColor: borderColor }} />
    </View>
  );
}

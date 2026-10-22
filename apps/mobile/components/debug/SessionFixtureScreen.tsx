/**
 * SessionFixtureScreen — the COR-91 parity fixture rendered through the real
 * transcript: the sync store, `groupMessagesIntoTurns`, and one `SessionTurn`
 * per `FlatList` row with `SessionPage`'s list window, turn gaps, compaction
 * suppression, and transcript-end busy row.
 *
 * `SessionPage` itself needs a live sandbox (session query, SSE sync, agents,
 * models), so this screen composes its list instead. What is NOT here: the
 * header/composer chrome and the scroll physics (follow, room spacer, glide).
 *
 * No network: the fixture is seeded into the store under `ses_FixtureParity…`
 * ids, file taps and mention taps are inert, and no `ToolFilePreviewHost` is
 * mounted. Open it in a dev build with `kortix://session-fixture`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colorScheme as nativewindColorScheme, useColorScheme } from 'nativewind';
import { useRouter } from 'expo-router';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { MarkdownActionsProvider } from '@/components/markdown/inline-code';
import { QuestionPrompt } from '@/components/session/QuestionPrompt';
import { SessionBusyIndicator } from '@/components/session/session-busy-indicator';
import { SessionTurn } from '@/components/session/SessionTurn';
import { ActivitySheetHost } from '@/components/session/turn/activity-sheet';
import { usePendingPermissions, usePendingQuestions, useSessionStatus } from '@/lib/session/session-store';
import { turnTopGap } from '@/lib/session/auto-scroll';
import {
  isSuppressedFailedCompaction,
  lastCompactionTurnIndex as findLastCompactionTurnIndex,
  suppressWorkingTurnBusy,
  transcriptBusyRowVisible,
} from '@/lib/session/turn-body';
import { webSpace } from '@/lib/session/user-message';
import { useThemeStore } from '@/stores/theme-store';
import type { SessionLogTurn } from '@kortix/sdk';
import { useSessionLogThread } from '@kortix/sdk/react';
import {
  fixturePendingTurnIds,
  fixtureQueueState,
  fixtureTurns,
  seedSessionFixture,
  type FixtureStatusMode,
} from '@/lib/debug/session-fixture';

const SESSION_ID = SESSION_FIXTURE.sessionId;
const WORKING_TURN_ID = SESSION_FIXTURE.working.userMessageId;
const PENDING_TURN_IDS = fixturePendingTurnIds();
const AGENT_NAMES = SESSION_FIXTURE.agentNames;
/** The fixture's transcript: the session log of its root runtime session (no Kortix session behind it). */
const FIXTURE_SOURCE = { projectId: '', sessionId: 'session-fixture', runtimeSessionId: SESSION_ID };
/** `SessionPage` `INITIAL_TURNS_TO_RENDER`. */
const INITIAL_TURNS_TO_RENDER = 4;
const NOOP = () => {};

export function SessionFixtureScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [mode, setMode] = useState<FixtureStatusMode>('busy');
  const [showQuestion, setShowQuestion] = useState(true);

  // Seed on mount and on every status switch; evict on unmount.
  useEffect(() => seedSessionFixture(mode), [mode]);

  // The theme switch is local to this screen: leaving restores the saved preference.
  useEffect(
    () => () => {
      nativewindColorScheme.set(useThemeStore.getState().preference);
    },
    [],
  );
  const toggleTheme = useCallback(() => nativewindColorScheme.set(isDark ? 'light' : 'dark'), [isDark]);

  const thread = useSessionLogThread(FIXTURE_SOURCE);
  const sessionStatus = useSessionStatus(SESSION_ID);
  const pendingQuestions = usePendingQuestions(SESSION_ID);
  const pendingPermissions = usePendingPermissions(SESSION_ID);
  const isBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  const turns = useMemo(() => fixtureTurns(thread, isBusy), [thread, isBusy]);
  const lastCompactionTurnIndex = useMemo(() => findLastCompactionTurnIndex(turns), [turns]);
  const suppressWorkingBusy = useMemo(() => suppressWorkingTurnBusy(turns), [turns]);
  const showTranscriptBusyRow = transcriptBusyRowVisible({
    isBusy,
    workingTurnId: WORKING_TURN_ID,
    suppressWorkingTurnBusy: suppressWorkingBusy,
  });

  const markdownActions = useMemo(() => ({ onOpenFile: NOOP }), []);

  const renderTurn = useCallback(
    ({ item, index }: { item: SessionLogTurn; index: number }) => {
      const id = item.id;
      const isWorkingTurn = item.live;
      const suppressed =
        lastCompactionTurnIndex > index &&
        isSuppressedFailedCompaction({
          compaction: item.compaction,
          isTurnWorking: isWorkingTurn,
          turnIndex: index,
          lastCompactionTurnIndex,
        });
      const gap = suppressed
        ? 0
        : turnTopGap({
            index,
            working: isBusy,
            pending: PENDING_TURN_IDS.has(id),
            previousPending: index > 0 && PENDING_TURN_IDS.has(turns[index - 1]!.id),
          });
      return (
        <View style={gap > 0 ? { marginTop: gap } : undefined}>
          {suppressed ? null : (
            <SessionTurn
              turn={item}
              sessionStatus={isWorkingTurn ? sessionStatus : undefined}
              suppressBusyIndicator={isWorkingTurn && suppressWorkingBusy}
              sessionId={SESSION_ID}
              permissions={pendingPermissions}
              pendingQuestions={pendingQuestions}
              onPermissionReply={NOOP}
              agentNames={AGENT_NAMES}
              onFileMention={NOOP}
              onSessionMention={NOOP}
              rewindDisabled
              queueState={fixtureQueueState(id)}
            />
          )}
        </View>
      );
    },
    [lastCompactionTurnIndex, isBusy, turns, sessionStatus, suppressWorkingBusy, pendingPermissions, pendingQuestions],
  );

  const keyExtractor = useCallback((item: SessionLogTurn) => item.id, []);
  const activeQuestion = pendingQuestions[0];

  return (
    <View className="bg-background flex-1">
      <View className="bg-background px-4 pb-3" style={{ paddingTop: insets.top + 8, gap: 8 }}>
        <View className="flex-row items-center justify-between">
          <Text variant="large">Session fixture</Text>
          <Button variant="ghost" size="sm" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
            <Text>Close</Text>
          </Button>
        </View>
        <View className="flex-row flex-wrap" style={{ gap: 8 }}>
          <Button variant="secondary" size="sm" onPress={toggleTheme}>
            <Text>{isDark ? 'Dark' : 'Light'}</Text>
          </Button>
          <Button variant="secondary" size="sm" onPress={() => setMode((m) => (m === 'busy' ? 'retry' : 'busy'))}>
            <Text>{mode === 'busy' ? 'Status: busy' : 'Status: retry'}</Text>
          </Button>
          <Button variant="secondary" size="sm" onPress={() => setShowQuestion((v) => !v)}>
            <Text>{showQuestion ? 'Question: on' : 'Question: off'}</Text>
          </Button>
        </View>
      </View>

      <View className="bg-background flex-1">
        <MarkdownActionsProvider value={markdownActions}>
          <FlatList
            data={turns}
            renderItem={renderTurn}
            keyExtractor={keyExtractor}
            initialNumToRender={INITIAL_TURNS_TO_RENDER}
            maxToRenderPerBatch={5}
            windowSize={11}
            updateCellsBatchingPeriod={32}
            contentContainerStyle={{ paddingTop: 16, paddingBottom: 48 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
              showTranscriptBusyRow ? (
                <View className="px-4">
                  <SessionBusyIndicator
                    sessionId={SESSION_ID}
                    style={turns.length > 0 ? { marginTop: webSpace(6) } : undefined}
                  />
                </View>
              ) : null
            }
          />
        </MarkdownActionsProvider>
      </View>

      {showQuestion && activeQuestion ? (
        <View style={{ paddingBottom: insets.bottom }}>
          <QuestionPrompt key={activeQuestion.id} request={activeQuestion} onReply={NOOP} onReject={NOOP} />
        </View>
      ) : (
        <View style={{ height: insets.bottom }} />
      )}
      <ActivitySheetHost sessionId={SESSION_ID} markdownActions={markdownActions} />
    </View>
  );
}

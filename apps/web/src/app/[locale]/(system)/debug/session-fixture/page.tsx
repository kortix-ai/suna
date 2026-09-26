'use client';

/**
 * /debug/session-fixture — the COR-91 parity fixture at phone width.
 *
 * Renders `@kortix/shared/session-fixture` through the web transcript parts
 * (`TurnViewport` + `FixtureTurn`, which composes `UserMessage`,
 * `ActivityBurst`, `ToolPartRenderer`, markdown, errors, busy/retry, and
 * compaction exactly as `SessionTurnImpl` orders them) in a 390px column, for
 * side-by-side comparison with the mobile route `kortix://session-fixture`.
 *
 * No network: the fixture is seeded into the SDK session store under fixture
 * ids, queries are disabled by default, and no runtime is connected. Tool rows
 * expand inline (no `ToolActivateContext`), as they do on mobile. Theme: the
 * /debug toggle, or press `D`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { QuestionPrompt } from '@/features/session/question-prompt';
import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-body';
import { compactionTurnInfo } from '@/features/session/turn/compaction-state';
import { TurnViewport } from '@/features/session/turn/turn-viewport';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';

import { FixtureTurn } from './fixture-turn';
import {
  type FixtureStatusMode,
  fixturePendingTurnIds,
  fixtureStatus,
  fixtureTurns,
  seedSessionFixture,
} from './seed';

const SESSION_ID = SESSION_FIXTURE.sessionId;
const WORKING_TURN_ID = SESSION_FIXTURE.working.userMessageId;
const PENDING_TURN_IDS = fixturePendingTurnIds();
const NOOP = () => {};

function ControlButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border text-muted-foreground hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
    >
      {label}
    </button>
  );
}

export default function SessionFixturePage() {
  const [mode, setMode] = useState<FixtureStatusMode>('busy');
  const [showQuestion, setShowQuestion] = useState(true);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }),
  );

  useEffect(() => seedSessionFixture(mode), [mode]);

  const turns = useMemo(() => fixtureTurns(), []);
  const sessionStatus = fixtureStatus(mode);
  const sessionWorking = sessionStatus.type === 'busy' || sessionStatus.type === 'retry';
  const lastCompactionTurnIndex = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (compactionTurnInfo(turns[i]).isCompaction) return i;
    }
    return -1;
  }, [turns]);
  const [question] = SESSION_FIXTURE.questions;

  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-background min-h-dvh">
        <div className="border-border mx-auto flex min-h-dvh w-full max-w-[390px] flex-col border-x">
          <header className="border-border bg-background sticky top-0 z-10 flex flex-col gap-2 border-b px-4 py-3">
            <p className="text-sm font-medium">Session fixture</p>
            <div className="flex flex-wrap gap-2">
              <ControlButton
                label={mode === 'busy' ? 'Status: busy' : 'Status: retry'}
                onClick={() => setMode((m) => (m === 'busy' ? 'retry' : 'busy'))}
              />
              <ControlButton
                label={showQuestion ? 'Question: on' : 'Question: off'}
                onClick={() => setShowQuestion((v) => !v)}
              />
            </div>
          </header>

          <div className="min-w-0 flex-1 pb-12">
            <div role="log" className={SESSION_TRANSCRIPT_CLASS}>
              <div className="flex min-w-0 flex-col">
                {turns.map((turn, turnIndex) => {
                  const id = turn.userMessage.info.id;
                  const compaction = compactionTurnInfo(turn);
                  const isWorkingTurn = sessionWorking && id === WORKING_TURN_ID;
                  const suppressed =
                    compaction.isCompaction &&
                    !compaction.hasContent &&
                    !compaction.inFlight &&
                    !isWorkingTurn &&
                    turnIndex < lastCompactionTurnIndex;
                  const gap =
                    turnIndex === 0
                      ? ''
                      : sessionWorking &&
                          PENDING_TURN_IDS.has(id) &&
                          PENDING_TURN_IDS.has(turns[turnIndex - 1].userMessage.info.id)
                        ? 'mt-3'
                        : 'mt-12';
                  return (
                    <TurnViewport key={id} turnId={id} className={gap}>
                      {suppressed ? null : (
                        <FixtureTurn
                          turn={turn}
                          sessionId={SESSION_ID}
                          sessionStatus={sessionStatus}
                          sessionWorking={sessionWorking}
                          isWorkingTurn={id === WORKING_TURN_ID}
                          queueState={SESSION_FIXTURE.queueStates[id] ?? null}
                          permissions={SESSION_FIXTURE.permissions}
                          questions={SESSION_FIXTURE.questions}
                          agentNames={SESSION_FIXTURE.agentNames}
                        />
                      )}
                    </TurnViewport>
                  );
                })}
              </div>
            </div>
          </div>

          {showQuestion && question ? (
            <div className="border-border bg-background sticky bottom-0 border-t px-4 py-3">
              <QuestionPrompt request={question} onReply={NOOP} onReject={NOOP} />
            </div>
          ) : null}
        </div>
      </div>
    </QueryClientProvider>
  );
}

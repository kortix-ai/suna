'use client';

/**
 * /debug/session-fixture — the COR-91 parity fixture at phone width.
 *
 * Renders `@kortix/shared/session-fixture` through the web transcript's own
 * turn (`TurnViewport` + `SessionTurn`, over the session-log turns of the
 * fixture's rows) in a 390px column, for side-by-side comparison with the
 * mobile route `kortix://session-fixture`. Below it, Codex and Claude Code tool calls
 * (`FOREIGN_TOOL_CALLS`) render through their block kind's renderer (P5.3).
 *
 * No network: the fixture is seeded into the SDK session store under fixture
 * ids, queries are disabled by default, and no runtime is connected. Tool rows
 * expand inline (no `ToolActivateContext`), as they do on mobile. Theme: the
 * /debug toggle, or press `D`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

// Register the tool renderers. Without this every tool part on the fixture
// page renders the GenericTool fallback, so the parity view shows no tool
// card, including the connector_get notes block this page exists to show.
import '@/features/session/tool/tools/register';

import { QuestionPrompt } from '@/features/session/question-prompt';
import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-body';
import { SessionTurn } from '@/features/session/session-chat/transcript';
import { FOREIGN_TOOL_CALLS } from '@/features/session/tool/foreign-tool-calls';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { TurnViewport } from '@/features/session/turn/turn-viewport';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';

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
const NOOP_ASYNC = async () => {};
const NO_OUTCOME = {};

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
  const lastCompactionTurnIndex = turns.findLastIndex((turn) => turn.compaction !== null);
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
                  const id = turn.id;
                  const compaction = turn.compaction;
                  const isWorkingTurn = sessionWorking && id === WORKING_TURN_ID;
                  const suppressed =
                    compaction !== null &&
                    !compaction.hasContent &&
                    !compaction.inFlight &&
                    !isWorkingTurn &&
                    turnIndex < lastCompactionTurnIndex;
                  const gap =
                    turnIndex === 0
                      ? ''
                      : sessionWorking &&
                          PENDING_TURN_IDS.has(id) &&
                          PENDING_TURN_IDS.has(turns[turnIndex - 1].id)
                        ? 'mt-3'
                        : 'mt-12';
                  return (
                    <TurnViewport key={id} turnId={id} className={gap}>
                      {suppressed ? null : (
                        <SessionTurn
                          turn={turn}
                          turnOutcome={NO_OUTCOME}
                          isLast={turnIndex === turns.length - 1}
                          ownsPlan={turn.plan}
                          isFirstTurn={turnIndex === 0}
                          sessionId={SESSION_ID}
                          sessionStatus={sessionStatus}
                          sessionWorking={sessionWorking}
                          isWorkingTurn={id === WORKING_TURN_ID}
                          suppressBusyIndicator={false}
                          awaitingUser={false}
                          pending={SESSION_FIXTURE.queueStates[id] === 'queued'}
                          interruptedBeforeRun={SESSION_FIXTURE.queueStates[id] === 'interrupted'}
                          isCompaction={compaction !== null}
                          permissions={SESSION_FIXTURE.permissions}
                          questions={SESSION_FIXTURE.questions}
                          agentNames={SESSION_FIXTURE.agentNames}
                          onPermissionReply={NOOP_ASYNC}
                          onRewind={NOOP}
                          rewindDisabled
                        />
                      )}
                    </TurnViewport>
                  );
                })}
              </div>
            </div>
            <section className="border-border mt-12 flex flex-col gap-2 border-t px-4 pt-3" data-testid="foreign-tools">
              <p className="text-sm font-medium">Foreign harness tools</p>
              {FOREIGN_TOOL_CALLS.map((call) => (
                <ToolPartRenderer key={call.id} call={call} defaultOpen />
              ))}
            </section>
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

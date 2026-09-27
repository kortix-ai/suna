'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { groupMessagesIntoTurns } from '@kortix/sdk';
import { useRuntimeMessages, useSession, useSessionStateStore } from '@kortix/sdk/react';
import { Profiler, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-body';
import { SessionChat } from '@/features/session/session-chat';
import { stabilizeTurns } from '@/features/session/turn/stable-turns';
import { TurnViewport } from '@/features/session/turn/turn-viewport';
import type { MessageWithParts, SessionStatus, Turn } from '@/ui';

import { FixtureTurn } from '../fixture-turn';

const SESSION_ID = 'ses_FixtureBench';
const DELTA_INTERVAL_MS = 16;
const SETTLE_MS = 2_000;
const BUSY: SessionStatus = { type: 'busy' } as SessionStatus;
const IDLE: SessionStatus = { type: 'idle' } as SessionStatus;
const NO_PERMISSIONS: never[] = [];
const NO_QUESTIONS: never[] = [];
const AGENT_NAMES = ['build'];

/** One settled assistant answer: prose, a list, a table, inline math, a code block. */
function answerText(turn: number): string {
  return [
    `Here is step ${turn} of the plan. The change keeps the public contract and moves the work off the hot path.`,
    '',
    '- Parse the input once and cache the result by content hash.',
    '- Render plain text while the block is still arriving.',
    `- Highlight when it settles; the cost is $O(n)$ per block, not per delta.`,
    '',
    '| Metric | Before | After |',
    '| --- | --- | --- |',
    `| renders | ${200 + turn} | ${turn % 7} |`,
    '',
    '```typescript',
    `export function step${turn}(input: readonly number[]): number {`,
    '  let total = 0;',
    '  for (const value of input) {',
    '    total += value * 2;',
    '  }',
    '  return total;',
    '}',
    '```',
    '',
    'That completes this step.',
  ].join('\n');
}

/** The streamed tail: prose, then a code block that grows line by line. */
const STREAM_SCRIPT = [
  'Streaming the final answer now. First a short explanation of the approach, ',
  'then the implementation.\n\n',
  '```typescript\n',
  ...Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i}, { retries: 3, timeoutMs: 250 });\n`),
  '```\n\n',
  'And the closing paragraph with inline math $a^2 + b^2 = c^2$ and a list:\n\n',
  '- first point\n- second point\n- third point\n',
].join('');

function user(id: string, created: number) {
  return { id, sessionID: SESSION_ID, role: 'user', time: { created }, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' } };
}
function assistant(id: string, parentID: string, created: number, completed: boolean) {
  return {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    time: completed ? { created, completed: created + 1 } : { created },
    parentID,
    modelID: 'claude',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function seed(messageCount: number): { messageId: string; partId: string; userId: string } {
  const turns = Math.max(1, Math.floor(messageCount / 2));
  const rows: MessageWithParts[] = [];
  let last = { messageId: '', partId: '', userId: '' };
  for (let t = 0; t < turns; t++) {
    const n = String(t).padStart(5, '0');
    const userId = `msg_bench_${n}_0`;
    const assistantId = `msg_bench_${n}_1`;
    const streaming = t === turns - 1;
    rows.push({
      info: user(userId, t * 10),
      parts: [{ id: `prt_${userId}`, sessionID: SESSION_ID, messageID: userId, type: 'text', text: `Question ${t}: do the next step.` }],
    } as unknown as MessageWithParts);
    rows.push({
      info: assistant(assistantId, userId, t * 10 + 1, !streaming),
      parts: [{ id: `prt_${assistantId}`, sessionID: SESSION_ID, messageID: assistantId, type: 'text', text: streaming ? '' : answerText(t) }],
    } as unknown as MessageWithParts);
    last = { messageId: assistantId, partId: `prt_${assistantId}`, userId };
  }
  const store = useSessionStateStore.getState();
  store.clearSession(SESSION_ID);
  store.hydrate(SESSION_ID, rows);
  return last;
}

/** Renders of turns other than the streaming one, while the replay runs. Target: 0. */
const settledRenders = { active: false, count: 0, streamingTurnId: '' };

type BenchTurnProps = Parameters<typeof FixtureTurn>[0];

/** `SessionTurn`'s memo boundary: the turn itself. Counts its real renders. */
const BenchTurn = memo(function BenchTurn(props: BenchTurnProps) {
  if (settledRenders.active && props.turn.userMessage.info.id !== settledRenders.streamingTurnId) {
    settledRenders.count += 1;
  }
  return <FixtureTurn {...props} />;
});

/**
 * `?rows=row` memoizes the whole row (viewport + turn), as `TranscriptTurnRow`
 * in session-chat.tsx does; the default memoizes only the turn, as
 * `SessionChat` did before it. Compare both to see the viewport's share.
 */
const BenchRow = memo(function BenchRow({
  turnId,
  className,
  ...props
}: BenchTurnProps & { turnId: string; className: string }) {
  return (
    <TurnViewport turnId={turnId} className={className}>
      <BenchTurn {...props} />
    </TurnViewport>
  );
});

interface BenchResult {
  messages: number;
  deltas: number;
  rows: 'turn' | 'row' | 'chat' | 'session';
  settledTurnRenders: number;
  commits: number;
  renderMs: number;
  longTasks: number;
  longTaskMs: number;
  totalBlockingMs: number;
  loafCount: number;
  loafMs: number;
  wallMs: number;
  heapMb: number | null;
  settledHeapMb: number | null;
  /** Frames over 16.7 ms during the replay, and the time beyond budget they cost. */
  slowFrames: number;
  jankMs: number;
  /** Shiki grammar/theme/engine resources fetched since page load. */
  shikiResources: number;
}

function heapMb(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10 : null;
}

function Transcript({ streaming, memoRows }: { streaming: boolean; memoRows: boolean }) {
  const { data } = useRuntimeMessages(SESSION_ID);
  const stableRef = useRef<Turn[]>([]);
  const turns = useMemo(
    () => stabilizeTurns(groupMessagesIntoTurns(data ?? []) as Turn[], stableRef.current),
    [data],
  );
  useEffect(() => {
    stableRef.current = turns;
  }, [turns]);
  const lastId = turns[turns.length - 1]?.userMessage.info.id;
  const status = streaming ? BUSY : IDLE;
  return (
    <div role="log" className={SESSION_TRANSCRIPT_CLASS}>
      <div className="flex min-w-0 flex-col">
        {turns.map((turn, index) => {
          const id = turn.userMessage.info.id;
          const turnProps: BenchTurnProps = {
            turn,
            sessionId: SESSION_ID,
            sessionStatus: status,
            sessionWorking: streaming,
            isWorkingTurn: id === lastId,
            queueState: null,
            permissions: NO_PERMISSIONS,
            questions: NO_QUESTIONS,
            agentNames: AGENT_NAMES,
          };
          const className = index === 0 ? '' : 'mt-12';
          return memoRows ? (
            <BenchRow key={id} turnId={id} className={className} {...turnProps} />
          ) : (
            <TurnViewport key={id} turnId={id} className={className}>
              <BenchTurn {...turnProps} />
            </TurnViewport>
          );
        })}
      </div>
    </div>
  );
}

/** `SessionChat` fed by `useSession`, as the project session page renders it. */
function SessionBackedChat() {
  const session = useSession('bench-project', 'bench-session', {
    enabled: false,
    replayStartStash: false,
    initialOpenCodeSessionId: SESSION_ID,
    subscribeMessages: false,
  });
  return <SessionChat sessionId={SESSION_ID} sessionState={session} hideHeader readOnly />;
}

export function SessionFixtureBench() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const messageCount = Number(params.get('messages') ?? 100);
  const deltaCount = Number(params.get('deltas') ?? 200);
  const autorun = params.get('autorun') === '1';
  const memoRows = params.get('rows') === 'row';
  // `?chat=1` renders the real `SessionChat` (read-only, no `useSession`)
  // over the seeded store instead of the fixture composition. `?chat=session`
  // hands it a `useSession` result (`enabled: false`: no network) — the
  // project session page's path, with `subscribeMessages: false`.
  const realChat = params.get('chat') === '1' || params.get('chat') === 'session';
  const withSession = params.get('chat') === 'session';
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }),
  );
  const [target, setTarget] = useState<{ messageId: string; partId: string; userId: string } | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [phase, setPhase] = useState<'seeding' | 'settling' | 'ready' | 'running' | 'done'>('seeding');
  const [result, setResult] = useState<BenchResult | null>(null);
  const profile = useRef({ active: false, commits: 0, renderMs: 0 });

  useEffect(() => {
    setTarget(seed(messageCount));
    setPhase('settling');
    const timer = setTimeout(() => setPhase('ready'), SETTLE_MS);
    return () => {
      clearTimeout(timer);
      useSessionStateStore.getState().clearSession(SESSION_ID);
    };
  }, [messageCount]);

  const onRender = useCallback((_id: string, _phase: string, actualDuration: number) => {
    if (!profile.current.active) return;
    profile.current.commits += 1;
    profile.current.renderMs += actualDuration;
  }, []);

  const run = useCallback(() => {
    if (!target) return;
    setPhase('running');
    const settledHeap = heapMb();
    const longTasks: PerformanceEntry[] = [];
    const loafs: PerformanceEntry[] = [];
    const observers: PerformanceObserver[] = [];
    for (const [type, sink] of [
      ['longtask', longTasks],
      ['long-animation-frame', loafs],
    ] as const) {
      try {
        const observer = new PerformanceObserver((list) => sink.push(...list.getEntries()));
        observer.observe({ type, buffered: false });
        observers.push(observer);
      } catch {
        // Entry type unsupported in this browser.
      }
    }
    profile.current = { active: true, commits: 0, renderMs: 0 };
    settledRenders.active = true;
    settledRenders.count = 0;
    settledRenders.streamingTurnId = target.userId;
    // Read by an optional render counter a harness may install as the React
    // DevTools hook (it counts fibers that performed work during the replay).
    const win = window as unknown as { __benchCounting?: boolean; __benchStreamingTurnId?: string };
    win.__benchStreamingTurnId = target.userId;
    win.__benchCounting = true;
    useSessionStateStore.getState().setStatus(SESSION_ID, BUSY);
    const started = performance.now();
    const frames = { slow: 0, jank: 0, last: started, on: true };
    const tick = (now: number) => {
      const delta = now - frames.last;
      if (delta > 1000 / 60 + 1) {
        frames.slow += 1;
        frames.jank += delta - 1000 / 60;
      }
      frames.last = now;
      if (frames.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const chunk = Math.max(1, Math.ceil(STREAM_SCRIPT.length / deltaCount));
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= deltaCount) {
        clearInterval(timer);
        // Stop counting before the turn ends: the end flips `sessionWorking`
        // for every turn once, which is not per-delta cost.
        settledRenders.active = false;
        (window as unknown as { __benchCounting?: boolean }).__benchCounting = false;
        useSessionStateStore.getState().setStatus(SESSION_ID, IDLE);
        setStreaming(false);
        setTimeout(() => {
          const wallMs = performance.now() - started;
          profile.current.active = false;
          settledRenders.active = false;
          frames.on = false;
          for (const observer of observers) observer.disconnect();
          const longTaskMs = longTasks.reduce((sum, entry) => sum + entry.duration, 0);
          const next: BenchResult = {
            messages: messageCount,
            deltas: deltaCount,
            rows: withSession ? 'session' : realChat ? 'chat' : memoRows ? 'row' : 'turn',
            settledTurnRenders: settledRenders.count,
            commits: profile.current.commits,
            renderMs: Math.round(profile.current.renderMs),
            longTasks: longTasks.length,
            longTaskMs: Math.round(longTaskMs),
            totalBlockingMs: Math.round(
              longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
            ),
            loafCount: loafs.length,
            loafMs: Math.round(loafs.reduce((sum, entry) => sum + entry.duration, 0)),
            wallMs: Math.round(wallMs),
            heapMb: heapMb(),
            settledHeapMb: settledHeap,
            slowFrames: frames.slow,
            jankMs: Math.round(frames.jank),
            shikiResources: performance
              .getEntriesByType('resource')
              .filter((entry) => /shiki|shikijs|onig/i.test(entry.name)).length,
          };
          (window as unknown as { __sessionBench?: BenchResult }).__sessionBench = next;
          setResult(next);
          setPhase('done');
        }, 1_000);
        return;
      }
      const text = STREAM_SCRIPT.slice(sent * chunk, (sent + 1) * chunk) || ' ';
      useSessionStateStore
        .getState()
        .applyPartDelta(SESSION_ID, target.messageId, target.partId, 'text', text, `evt_bench_${sent}`);
      sent += 1;
    }, DELTA_INTERVAL_MS);
  }, [target, deltaCount, messageCount, memoRows, withSession, realChat]);

  useEffect(() => {
    if (autorun && phase === 'ready') run();
  }, [autorun, phase, run]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-background min-h-dvh">
        <div className="border-border mx-auto flex min-h-dvh w-full max-w-[720px] flex-col border-x">
          <header className="border-border bg-background sticky top-0 z-10 flex flex-col gap-2 border-b px-4 py-3">
            <p className="text-sm font-medium">Session render bench</p>
            <button
              type="button"
              data-testid="bench-run"
              disabled={phase !== 'ready'}
              onClick={run}
              className="border-border text-muted-foreground hover:text-foreground w-fit rounded-md border px-3 py-1.5 text-xs"
            >
              {phase}
            </button>
            <pre data-testid="bench-result" className="text-muted-foreground text-xs whitespace-pre-wrap">
              {result ? JSON.stringify(result, null, 2) : ''}
            </pre>
          </header>
          <div className="min-w-0 flex-1 pb-12">
            <Profiler id="transcript" onRender={onRender}>
              {withSession ? (
                <SessionBackedChat />
              ) : realChat ? (
                <SessionChat sessionId={SESSION_ID} hideHeader readOnly />
              ) : (
                <Transcript streaming={streaming} memoRows={memoRows} />
              )}
            </Profiler>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}

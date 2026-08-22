/**
 * Transcript render benchmark — the committing-renderer half. Entry point and
 * knobs are documented in `transcript-render.bench.ts`; inputs in `fixture.ts`.
 *
 * Everything here is process-wide on purpose (a Bun loader plugin that rewrites
 * five component sources, a happy-dom global document), which is why this runs
 * as its own `bun run` process and never inside the shared `bun test` one.
 *
 * How the REAL components are reached without editing them:
 * - `SessionTurn` is module-private in `session-chat.tsx`. A `Bun.plugin`
 *   `onLoad` rewrites that file in memory to also export it as
 *   `__benchSessionTurn`. The file on disk is untouched.
 * - Render counting uses the same loader: each probed component's plain
 *   function body (`SessionTurnImpl`, `UserMessage`, `ActivityBurstImpl`,
 *   `ThrottledMarkdownImpl`, `ToolPartRendererImpl`, `TurnViewport`) is wrapped
 *   by `globalThis.__kortixBenchProbe(name, Impl)` BEFORE any `memo()` is
 *   applied, so the memo boundaries are the production ones and the counter
 *   increments exactly when a body runs. Every rewrite asserts a single match;
 *   a refactor that moves a declaration fails this bench loudly.
 */
import type { ComponentType, ReactNode } from 'react';

import type { BenchSession, PipelineFrame } from './fixture';
import type { MessageWithParts, Turn } from '@/ui';

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

type CellSpec = { n: number; m: number; oneTurn: boolean };

const QUICK_CELLS: CellSpec[] = [
  { n: 20, m: 0, oneTurn: false },
  { n: 20, m: 2, oneTurn: false },
];
const FULL_CELLS: CellSpec[] = [
  { n: 20, m: 0, oneTurn: false },
  { n: 20, m: 8, oneTurn: false },
  { n: 20, m: 32, oneTurn: false },
  { n: 200, m: 0, oneTurn: false },
  { n: 200, m: 8, oneTurn: false },
  { n: 200, m: 32, oneTurn: false },
  { n: 200, m: 8, oneTurn: true },
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return v;
}

function parseCells(raw: string): CellSpec[] {
  return raw.split(',').map((token) => {
    const t = token.trim();
    const match = /^(\d+):(\d+)(@one)?$/.exec(t);
    if (!match) throw new Error(`BENCH_CELLS token "${t}" must look like N:M or N:M@one`);
    const n = Number(match[1]);
    if (n % 2 !== 0) throw new Error(`BENCH_CELLS N must be even (2 messages per turn), got ${n}`);
    return { n, m: Number(match[2]), oneTurn: !!match[3] };
  });
}

function resolveConfig() {
  const full = process.env.KORTIX_BENCH === '1' || process.env.BENCH_PROFILE === 'full';
  const cells = process.env.BENCH_CELLS ? parseCells(process.env.BENCH_CELLS) : full ? FULL_CELLS : QUICK_CELLS;
  const steps = envInt('BENCH_STEPS', 50);
  const warmup = envInt('BENCH_WARMUP', 5);
  if (warmup >= steps) throw new Error(`BENCH_WARMUP (${warmup}) must be < BENCH_STEPS (${steps})`);
  return {
    profile: full ? 'full' : 'quick',
    cells,
    reps: Math.max(1, envInt('BENCH_REPS', 5)),
    steps,
    warmup,
    imageBytes: envInt('BENCH_IMAGE_BYTES', 512 * 1024),
    // Real-time wait after mount before any step runs. Must exceed the 2.5 s
    // status throttle in SessionTurnImpl (session-chat.tsx, `setThrottledStatus`
    // on a `setTimeout(2500 - elapsed)` armed by every turn's mount effect):
    // that timer re-renders EVERY turn twice ~2.5 s after mount, and if it
    // fires inside the step loop it shows up as settled-turn renders — which
    // it is, but it is the mount's cascade, not the step's. The wait makes the
    // steps measure steady state and the cascade is reported on its own as
    // `mountCascadeRenders`.
    mountQuiesceMs: envInt('BENCH_MOUNT_QUIESCE_MS', 3500),
    profiler: process.env.BENCH_PROFILER === '1',
    out: process.env.BENCH_OUT,
  };
}

// ---------------------------------------------------------------------------
// Probes (render counters) — installed on globalThis BEFORE the components load
// ---------------------------------------------------------------------------

const PROBE_NAMES = [
  'TurnViewport',
  'SessionTurn',
  'UserMessage',
  'ActivityBurst',
  'ThrottledMarkdown',
  'ToolPartRenderer',
] as const;
type ProbeName = (typeof PROBE_NAMES)[number];

type ProbeCounts = Record<ProbeName, number>;

interface ProbeState {
  counts: ProbeCounts;
  /** turn id → per-probe body runs under that turn. */
  perTurn: Map<string, ProbeCounts>;
}

function emptyCounts(): ProbeCounts {
  return {
    TurnViewport: 0,
    SessionTurn: 0,
    UserMessage: 0,
    ActivityBurst: 0,
    ThrottledMarkdown: 0,
    ToolPartRenderer: 0,
  };
}

function emptyProbeState(): ProbeState {
  return { counts: emptyCounts(), perTurn: new Map() };
}

/** Sum of every probe's body runs outside `workingTurnId`, plus the turn ids involved. */
function settledTurnRenders(state: ProbeState, workingTurnId: string | null): { counts: ProbeCounts; turnIds: string[] } {
  const counts = emptyCounts();
  const turnIds: string[] = [];
  for (const [turnId, c] of state.perTurn) {
    if (turnId === workingTurnId) continue;
    let any = false;
    for (const k of PROBE_NAMES) {
      counts[k] += c[k];
      if (c[k] > 0) any = true;
    }
    if (any) turnIds.push(turnId);
  }
  return { counts, turnIds };
}
let probeState: ProbeState = emptyProbeState();
function resetProbes() {
  probeState = emptyProbeState();
}

// Set once React is imported: the probe wrappers call `useContext` to learn
// which turn they render under (the bench wraps every turn in this context).
let BenchTurnContext: import('react').Context<string | null> | null = null;
let reactUseContext: typeof import('react').useContext | null = null;

function installProbeFactory() {
  (globalThis as any).__kortixBenchProbe = (name: ProbeName, Impl: (props: any) => any) => {
    if (!PROBE_NAMES.includes(name)) throw new Error(`unknown probe ${name}`);
    const Probed = function KortixBenchProbe(props: any) {
      probeState.counts[name]++;
      const turnId = BenchTurnContext && reactUseContext ? reactUseContext(BenchTurnContext) : null;
      if (turnId) {
        let c = probeState.perTurn.get(turnId);
        if (!c) {
          c = emptyCounts();
          probeState.perTurn.set(turnId, c);
        }
        c[name]++;
      }
      // Call-through: hooks inside `Impl` attach to this fiber, which is the
      // production fiber for this component (we replaced it, not wrapped it).
      return Impl(props);
    };
    Object.defineProperty(Probed, 'name', { value: name });
    (Probed as any).displayName = name;
    return Probed;
  };
}

/** Replace exactly one occurrence or throw — a moved declaration must fail loudly. */
function replaceOnce(src: string, file: string, from: string, to: string): string {
  const first = src.indexOf(from);
  if (first < 0) throw new Error(`bench source probe: "${from}" not found in ${file}`);
  if (src.indexOf(from, first + from.length) >= 0) {
    throw new Error(`bench source probe: "${from}" matched more than once in ${file}`);
  }
  return src.slice(0, first) + to + src.slice(first + from.length);
}

const PROBE_REWRITES: Record<string, (src: string, file: string) => string> = {
  'session-chat.tsx': (src, file) =>
    replaceOnce(
      src,
      file,
      'const SessionTurn = memo(SessionTurnImpl);',
      "const SessionTurn = memo(globalThis.__kortixBenchProbe('SessionTurn', SessionTurnImpl));",
    ) + '\nexport { SessionTurn as __benchSessionTurn };\n',
  'user-message.tsx': (src, file) =>
    replaceOnce(src, file, 'export function UserMessage({', 'function UserMessageBenchImpl({') +
    "\nexport const UserMessage = globalThis.__kortixBenchProbe('UserMessage', UserMessageBenchImpl);\n",
  'activity-burst.tsx': (src, file) =>
    replaceOnce(
      src,
      file,
      'export const ActivityBurst = memo(\n  ActivityBurstImpl,',
      "export const ActivityBurst = memo(\n  globalThis.__kortixBenchProbe('ActivityBurst', ActivityBurstImpl),",
    ),
  'throttled-markdown.tsx': (src, file) =>
    replaceOnce(
      src,
      file,
      'memo(ThrottledMarkdownImpl)',
      "memo(globalThis.__kortixBenchProbe('ThrottledMarkdown', ThrottledMarkdownImpl))",
    ),
  'tool-part-renderer.tsx': (src, file) =>
    replaceOnce(
      src,
      file,
      'memo(ToolPartRendererImpl)',
      "memo(globalThis.__kortixBenchProbe('ToolPartRenderer', ToolPartRendererImpl))",
    ),
  'turn-viewport.tsx': (src, file) =>
    replaceOnce(src, file, 'export function TurnViewport({', 'function TurnViewportBenchImpl({') +
    "\nexport const TurnViewport = globalThis.__kortixBenchProbe('TurnViewport', TurnViewportBenchImpl);\n",
};

const PROBE_FILTER =
  /features\/session\/(session-chat|turn\/user-message|turn\/activity-burst|turn\/throttled-markdown|turn\/turn-viewport|tool\/tool-part-renderer)\.tsx$/;

function installSourceProbes() {
  installProbeFactory();
  const seen = new Set<string>();
  Bun.plugin({
    name: 'kortix-transcript-bench-probes',
    setup(build) {
      build.onLoad({ filter: PROBE_FILTER }, async (args) => {
        const file = args.path.split('/').pop()!;
        const rewrite = PROBE_REWRITES[file];
        if (!rewrite) throw new Error(`bench: no rewrite registered for ${file}`);
        const src = await Bun.file(args.path).text();
        seen.add(file);
        return { contents: rewrite(src, file), loader: 'tsx' };
      });
    },
  });
  return () => {
    const missing = Object.keys(PROBE_REWRITES).filter((f) => !seen.has(f));
    if (missing.length) throw new Error(`bench: probe rewrite never ran for ${missing.join(', ')}`);
  };
}

// ---------------------------------------------------------------------------
// DOM (happy-dom) + deterministic rAF
// ---------------------------------------------------------------------------

type RafCb = (t: number) => void;
const rafQueue = new Map<number, RafCb>();
let rafSeq = 0;
let rafClock = 0;

/** Run every rAF callback queued so far; callbacks queued while draining wait for the next drain. */
function drainRaf(): number {
  const batch = [...rafQueue.entries()];
  rafQueue.clear();
  rafClock += 16;
  for (const [, cb] of batch) cb(rafClock);
  return batch.length;
}

async function registerDom() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register({ url: 'http://localhost:3000/', width: 1440, height: 900 });

  const g = globalThis as any;
  g.requestAnimationFrame = (cb: RafCb) => {
    const id = ++rafSeq;
    rafQueue.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number) => {
    rafQueue.delete(id);
  };
  g.window.requestAnimationFrame = g.requestAnimationFrame;
  g.window.cancelAnimationFrame = g.cancelAnimationFrame;

  if (typeof g.ResizeObserver === 'undefined') {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof g.IntersectionObserver === 'undefined') {
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  if (typeof g.URL.createObjectURL !== 'function') {
    g.URL.createObjectURL = () => 'blob:bench';
    g.URL.revokeObjectURL = () => {};
  }
  if (typeof g.Element.prototype.scrollIntoView !== 'function') {
    g.Element.prototype.scrollIntoView = () => {};
  }
  if (typeof g.window.matchMedia !== 'function') {
    g.window.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    });
    g.matchMedia = g.window.matchMedia;
  }
}

/** Let scheduler (MessageChannel) callbacks and happy-dom timers run. */
async function settle(ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    min: round(sorted[0] ?? Number.NaN),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

function median(values: number[]): number {
  return round(quantile([...values].sort((a, b) => a - b), 0.5));
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface StepRecord {
  frameMs: number;
  settleMs: number;
  newTurnObjects: number;
  counts: ProbeCounts;
  renderedTurnIds: string[];
  workingTurnBodyRenders: number;
  settledTurnBodyRenders: number;
  settledImgIdentityKept: boolean;
  settledImgCount: number;
  profilerMs?: { working: number; settled: number; settledCount: number };
}

interface VariantRep {
  frameMs: number[];
  settleMs: number[];
  counts: ProbeCounts[];
  renderedTurnCounts: number[];
  workingTurnBodyRenders: number[];
  settledTurnBodyRenders: number[];
  newTurnObjects: number[];
  imgIdentityViolations: number;
  profilerSettledMs: number[];
  profilerWorkingMs: number[];
}

interface RepResult {
  ssrFirstRenderMs: number;
  firstRenderMs: number;
  mountSettleMs: number;
  mountProbeCounts: ProbeCounts;
  /** Bodies rendered between mount settle and `mountQuiesceMs` later, with no input. */
  mountCascadeCounts: ProbeCounts;
  busyFlipMs: number;
  busyFlipProbeCounts: ProbeCounts;
  pipelineOnlyMs: number[];
  b1: VariantRep;
  b2: VariantRep;
  domNodes: number;
  imgNodes: number;
}

interface Violation {
  cell: string;
  rep: number;
  variant: string;
  step: number;
  rule: string;
  actual: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  const config = resolveConfig();
  const assertProbesRan = installSourceProbes();
  await registerDom();

  const React = await import('react');
  const ReactDOMClient = config.profiler
    ? // @ts-expect-error react-dom ships no types for the profiling entry; same surface as react-dom/client.
      ((await import('react-dom/profiling')) as unknown as typeof import('react-dom/client'))
    : await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { NextIntlClientProvider } = await import('next-intl');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const fixture = await import('./fixture');

  BenchTurnContext = React.createContext<string | null>(null);
  reactUseContext = React.useContext;

  const sessionChat = (await import('../session-chat')) as any;
  const SessionTurn = sessionChat.__benchSessionTurn as ComponentType<any>;
  if (!SessionTurn) throw new Error('bench: __benchSessionTurn export missing — source probe did not apply');
  const { TurnViewport } = await import('../turn/turn-viewport');
  assertProbesRan();

  const reactBuild = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const reactVersion = React.version;

  // Stable props — pinned once for the whole process (the real host pins them
  // per render via useCallback / module constants; identity is what matters).
  const noop = () => {};
  const noopAsync = async () => {};
  const EMPTY_PERMISSIONS: any[] = [];
  const EMPTY_QUESTIONS: any[] = [];
  const EMPTY_COMMANDS: any[] = [];
  const COMMAND_MESSAGES = new Map<string, { name: string; args?: string }>();
  // next-intl derives its context value from the `messages` object identity; a
  // fresh `{}` per render would re-render every `useTranslations` consumer
  // (SessionTurnImpl, UserMessage) through context and bypass their memo.
  // The real host passes one stable messages object, so the bench does too.
  const INTL_MESSAGES: Record<string, never> = {};

  interface TranscriptProps {
    turns: Turn[];
    planAnchorId: string | null;
    working: boolean;
    onProfilerRender?: (id: string, phase: string, actualDuration: number) => void;
  }

  /**
   * The `turns.map(...)` block of `SessionChat` (session-chat.tsx) with every
   * host-derived prop pinned: the last turn is the working turn while `working`,
   * no queue rows, no permissions, no compaction.
   */
  const TurnCtx = BenchTurnContext;
  function Transcript({ turns, planAnchorId, working, onProfilerRender }: TranscriptProps) {
    const lastId = turns.length ? turns[turns.length - 1].userMessage.info.id : null;
    return (
      <div className="flex flex-col">
        {turns.map((turn, turnIndex) => {
          const id = turn.userMessage.info.id;
          const isLast = id === lastId;
          let node: ReactNode = (
            <TurnCtx.Provider value={id}>
              <SessionTurn
                turn={turn}
                isLast={isLast}
                ownsPlan={id === planAnchorId}
                sessionId={fixture.SESSION_ID}
                sessionStatus={undefined}
                permissions={EMPTY_PERMISSIONS}
                questions={EMPTY_QUESTIONS}
                agentNames={undefined}
                isFirstTurn={turnIndex === 0}
                sessionWorking={working}
                isWorkingTurn={working && isLast}
                pending={false}
                queueRow={null}
                queueHeld={false}
                onQueueRemove={noop}
                onQueueSendNow={noop}
                onQueueRetry={noop}
                interruptedBeforeRun={false}
                isCompaction={false}
                providers={undefined}
                commandMessages={COMMAND_MESSAGES}
                commands={EMPTY_COMMANDS}
                disableToolNavigation={false}
                onPermissionReply={noopAsync}
                onRewind={noop}
                rewindDisabled={working}
              />
            </TurnCtx.Provider>
          );
          if (onProfilerRender) {
            node = (
              <React.Profiler
                id={id}
                onRender={(pid, phase, actualDuration) => onProfilerRender(pid, phase, actualDuration)}
              >
                {node}
              </React.Profiler>
            );
          }
          return (
            <TurnViewport key={id} turnId={id} className={turnIndex === 0 ? '' : 'mt-12'}>
              {node}
            </TurnViewport>
          );
        })}
      </div>
    );
  }

  /**
   * Providers mount ONCE per rep and never re-render, exactly like the real
   * host (they sit above SessionChat). Each frame updates `Host` state only, so
   * the work measured per step is the transcript's, not a provider tree's.
   */
  type HostHandle = { set: (p: TranscriptProps) => void };
  function Host({ initial, handle }: { initial: TranscriptProps; handle: HostHandle }) {
    const [props, setProps] = React.useState(initial);
    handle.set = setProps;
    return <Transcript {...props} />;
  }

  function App({
    initial,
    handle,
    queryClient,
  }: {
    initial: TranscriptProps;
    handle: HostHandle;
    queryClient: InstanceType<typeof QueryClient>;
  }) {
    return (
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider locale="en" messages={INTL_MESSAGES} onError={noop} timeZone="UTC">
          <TooltipProvider>
            <Host initial={initial} handle={handle} />
          </TooltipProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
  }

  const violations: Violation[] = [];
  const cellResults: any[] = [];
  const renderErrors: string[] = [];

  for (const cell of config.cells) {
    const cellName = `N=${cell.n} M=${cell.m}${cell.oneTurn ? '@one' : ''}`;
    const turnsCount = cell.n / 2;
    const session0 = fixture.buildSession({
      turns: turnsCount,
      images: cell.m,
      imageBytes: config.imageBytes,
      imagesOnOneTurn: cell.oneTurn,
    });
    process.stderr.write(
      `[bench] ${cellName}: ${session0.messages.length} messages, ${round(session0.imageChars / 1024 / 1024)} MiB base64 in image parts\n`,
    );

    const reps: RepResult[] = [];
    for (let rep = 0; rep < config.reps; rep++) {
      Bun.gc(true);
      reps.push(await runRep(session0, rep));
      await settle(2);
      if (renderErrors.length) {
        throw new Error(`bench: React reported ${renderErrors.length} error(s) in ${cellName} rep ${rep}:\n${renderErrors.join('\n')}`);
      }
    }

    const pick = (f: (r: RepResult) => number) => reps.map(f);
    const variantSummary = (v: (r: RepResult) => VariantRep) => {
      const frame = reps.map((r) => summarize(v(r).frameMs.slice(config.warmup)));
      const settleS = reps.map((r) => summarize(v(r).settleMs.slice(config.warmup)));
      const countsAfterWarmup = reps.flatMap((r) => v(r).counts.slice(config.warmup));
      const maxCounts = emptyCounts();
      for (const c of countsAfterWarmup) for (const k of PROBE_NAMES) maxCounts[k] = Math.max(maxCounts[k], c[k]);
      const renderedTurns = reps.flatMap((r) => v(r).renderedTurnCounts.slice(config.warmup));
      const workingRenders = reps.flatMap((r) => v(r).workingTurnBodyRenders.slice(config.warmup));
      const settledRenders = reps.flatMap((r) => v(r).settledTurnBodyRenders.slice(config.warmup));
      return {
        frameMs: {
          p50: median(frame.map((s) => s.p50)),
          p95: median(frame.map((s) => s.p95)),
          max: Math.max(...frame.map((s) => s.max)),
        },
        settleMs: { p50: median(settleS.map((s) => s.p50)) },
        rendersPerStepMax: maxCounts,
        sessionTurnRendersPerStep: { min: Math.min(...renderedTurns), max: Math.max(...renderedTurns) },
        workingTurnBodyRendersPerStep: { min: Math.min(...workingRenders), max: Math.max(...workingRenders) },
        settledTurnBodyRendersPerStep: { min: Math.min(...settledRenders), max: Math.max(...settledRenders) },
        newTurnObjectsPerStep: {
          min: Math.min(...reps.flatMap((r) => v(r).newTurnObjects)),
          max: Math.max(...reps.flatMap((r) => v(r).newTurnObjects)),
        },
        imgIdentityViolations: reps.reduce((a, r) => a + v(r).imgIdentityViolations, 0),
        ...(config.profiler
          ? {
              profilerMs: {
                settledTurnsPerStepP50: median(reps.flatMap((r) => v(r).profilerSettledMs.slice(config.warmup))),
                workingTurnPerStepP50: median(reps.flatMap((r) => v(r).profilerWorkingMs.slice(config.warmup))),
              },
            }
          : {}),
      };
    };

    const summary = {
      cell: cellName,
      messages: cell.n,
      turns: turnsCount,
      images: cell.m,
      imagesOnOneTurn: cell.oneTurn,
      imageBytes: config.imageBytes,
      imageBase64MiB: round(session0.imageChars / 1024 / 1024),
      domNodes: reps[0].domNodes,
      imgNodes: reps[0].imgNodes,
      ssrFirstRenderMs: median(pick((r) => r.ssrFirstRenderMs)),
      firstRenderMs: median(pick((r) => r.firstRenderMs)),
      firstRenderMsReps: pick((r) => round(r.firstRenderMs)),
      mountSettleMs: median(pick((r) => r.mountSettleMs)),
      mountRenders: reps[0].mountProbeCounts,
      mountCascadeRenders: reps[0].mountCascadeCounts,
      mountQuiesceMs: config.mountQuiesceMs,
      busyFlipMs: median(pick((r) => r.busyFlipMs)),
      busyFlipRenders: reps[0].busyFlipProbeCounts,
      pipelineOnlyMs: {
        p50: median(reps.map((r) => summarize(r.pipelineOnlyMs.slice(config.warmup)).p50)),
        p95: median(reps.map((r) => summarize(r.pipelineOnlyMs.slice(config.warmup)).p95)),
      },
      b1_appendPart: variantSummary((r) => r.b1),
      b2_delta: variantSummary((r) => r.b2),
    };
    cellResults.push(summary);

    // ---- one rep: mount, busy flip, b1 steps, b2 steps, unmount ----
    async function runRep(base: BenchSession, repIndex: number): Promise<RepResult> {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      let session = base;
      let frame: PipelineFrame = fixture.pipelineFrame(session.messages, []);

      // L1: renderToStaticMarkup of the same tree (no commit phase).
      const ssrT0 = performance.now();
      const html = renderToStaticMarkup(
        <App
          queryClient={queryClient}
          initial={{ turns: frame.turns, planAnchorId: frame.planAnchorId, working: false }}
          handle={{ set: noop }}
        />,
      );
      const ssrFirstRenderMs = performance.now() - ssrT0;
      if (html.length === 0) throw new Error('bench: SSR produced empty markup');
      resetProbes();

      // L2: committing renderer.
      const container = document.createElement('div');
      document.body.appendChild(container);
      // Any React error is a bench failure. Without these hooks React retries
      // the whole root once (every turn renders again) and then unmounts the
      // tree silently — both look like "numbers", not like a crash.
      const root = ReactDOMClient.createRoot(container, {
        onUncaughtError: (err) => renderErrors.push(`uncaught: ${String((err as Error)?.stack ?? err)}`),
        onCaughtError: (err) => renderErrors.push(`caught: ${String((err as Error)?.stack ?? err)}`),
        onRecoverableError: (err) => renderErrors.push(`recoverable: ${String((err as Error)?.stack ?? err)}`),
      });

      let profilerAcc: { working: number; settled: number; settledCount: number } | null = null;
      let workingTurnId: string | null = null;
      const onProfilerRender = config.profiler
        ? (id: string, _phase: string, actualDuration: number) => {
            if (!profilerAcc) return;
            if (id === workingTurnId) profilerAcc.working += actualDuration;
            else {
              profilerAcc.settled += actualDuration;
              profilerAcc.settledCount++;
            }
          }
        : undefined;

      const handle: HostHandle = {
        set: () => {
          throw new Error('bench: Host not mounted');
        },
      };
      let mounted = false;
      const render = (turns: Turn[], planAnchorId: string | null, working: boolean) => {
        const props: TranscriptProps = { turns, planAnchorId, working, onProfilerRender };
        flushSync(() => {
          if (!mounted) {
            mounted = true;
            root.render(<App queryClient={queryClient} initial={props} handle={handle} />);
          } else {
            handle.set(props);
          }
        });
      };

      const t0 = performance.now();
      render(frame.turns, frame.planAnchorId, false);
      const firstRenderMs = performance.now() - t0;
      const mountProbeCounts = { ...probeState.counts };

      // Mount settle: the two-rAF containment flip (TurnViewport), UserMessage
      // overflow measure, scheduler callbacks from effects.
      const s0 = performance.now();
      flushSync(() => drainRaf());
      flushSync(() => drainRaf());
      await settle(3);
      flushSync(() => drainRaf());
      await settle(1);
      const mountSettleMs = performance.now() - s0;

      // Let the mount's own timers fire (see `mountQuiesceMs`) and count what
      // renders with no input at all. Scheduler work is time-sliced, so poll.
      resetProbes();
      const q0 = performance.now();
      let lastTotal = -1;
      let stableSince = performance.now();
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        flushSync(() => drainRaf());
        const total = PROBE_NAMES.reduce((a, k) => a + probeState.counts[k], 0);
        if (total !== lastTotal) {
          lastTotal = total;
          stableSince = performance.now();
        }
        const now = performance.now();
        // Window elapsed AND nothing rendered for 300 ms (time-sliced work done).
        if (now - q0 >= config.mountQuiesceMs && now - stableSince >= 300) break;
      }
      await settle(3);
      const mountCascadeCounts = { ...probeState.counts };

      const domNodes = container.querySelectorAll('*').length;
      const imgNodes = container.querySelectorAll('img').length;
      if (repIndex === 0) {
        const turnNodes = container.querySelectorAll('[data-turn-id]').length;
        if (turnNodes !== frame.turns.length) {
          throw new Error(`bench: expected ${frame.turns.length} [data-turn-id] nodes, found ${turnNodes}`);
        }
        if (cell.m > 0 && imgNodes === 0) {
          throw new Error('bench: image file parts produced no <img> — attachment path changed');
        }
      }

      // The session goes busy (user sent a prompt): every turn sees
      // sessionWorking flip, so all T turn bodies render once. Measured apart
      // from the streaming steps so those stay clean.
      resetProbes();
      const bf0 = performance.now();
      render(frame.turns, frame.planAnchorId, true);
      const busyFlipMs = performance.now() - bf0;
      const busyFlipProbeCounts = { ...probeState.counts };
      flushSync(() => drainRaf());
      await settle(2);

      workingTurnId = frame.turns[frame.turns.length - 1].userMessage.info.id;

      // L0: pipeline only, no React, same step shape as b1.
      const pipelineOnlyMs: number[] = [];
      {
        let s = session;
        let f = frame;
        for (let i = 0; i < config.steps; i++) {
          const next = fixture.appendTextPart(s, 1000 + i);
          const p0 = performance.now();
          const nf = fixture.pipelineFrame(next.session.messages, f.turns);
          pipelineOnlyMs.push(performance.now() - p0);
          s = next.session;
          f = nf;
        }
      }

      const settledImgs = () => {
        const out: Element[] = [];
        const wrappers = container.querySelectorAll('[data-turn-id]');
        for (const w of wrappers) {
          if (w.getAttribute('data-turn-id') === workingTurnId) continue;
          for (const img of w.querySelectorAll('img')) out.push(img);
        }
        return out;
      };

      const runVariant = async (
        name: 'b1' | 'b2',
        mutate: (s: BenchSession, step: number) => { session: BenchSession },
      ): Promise<VariantRep> => {
        const v: VariantRep = {
          frameMs: [],
          settleMs: [],
          counts: [],
          renderedTurnCounts: [],
          workingTurnBodyRenders: [],
          settledTurnBodyRenders: [],
          newTurnObjects: [],
          imgIdentityViolations: 0,
          profilerSettledMs: [],
          profilerWorkingMs: [],
        };
        for (let step = 0; step < config.steps; step++) {
          const before = settledImgs();
          const next = mutate(session, step);
          const nf = fixture.pipelineFrame(next.session.messages, frame.turns);
          resetProbes();
          profilerAcc = { working: 0, settled: 0, settledCount: 0 };

          const f0 = performance.now();
          render(nf.turns, nf.planAnchorId, true);
          const frameMs = performance.now() - f0;

          const st0 = performance.now();
          flushSync(() => drainRaf());
          await settle(1);
          const settleMs = performance.now() - st0;

          // Counts cover the frame AND its settle (effects, rAF, scheduler
          // tasks): a cascade that re-renders a settled turn after the commit
          // is as real as one inside it.
          const counts = { ...probeState.counts };
          const working = probeState.perTurn.get(workingTurnId!) ?? emptyCounts();
          const settled = settledTurnRenders(probeState, workingTurnId);
          const renderedTurnIds = [...probeState.perTurn.keys()];
          const workingTurnBodyRenders = working.SessionTurn;
          const settledTurnBodyRenders = settled.counts.SessionTurn;

          const after = settledImgs();
          const identityKept =
            before.length === after.length && before.every((el, i) => el === after[i]);

          const rec: StepRecord = {
            frameMs,
            settleMs,
            newTurnObjects: nf.newTurnObjects,
            counts,
            renderedTurnIds,
            workingTurnBodyRenders,
            settledTurnBodyRenders,
            settledImgIdentityKept: identityKept,
            settledImgCount: before.length,
            profilerMs: profilerAcc ?? undefined,
          };
          profilerAcc = null;

          v.frameMs.push(rec.frameMs);
          v.settleMs.push(rec.settleMs);
          v.counts.push(rec.counts);
          v.renderedTurnCounts.push(rec.counts.SessionTurn);
          v.workingTurnBodyRenders.push(rec.workingTurnBodyRenders);
          v.settledTurnBodyRenders.push(rec.settledTurnBodyRenders);
          v.newTurnObjects.push(rec.newTurnObjects);
          if (!identityKept) v.imgIdentityViolations++;
          if (rec.profilerMs) {
            v.profilerSettledMs.push(rec.profilerMs.settled);
            v.profilerWorkingMs.push(rec.profilerMs.working);
          }

          // Invariants — every rep, every step past warm-up (they do not
          // depend on timing). Warm-up steps are excluded because step 0 is a
          // legitimate transition: the tool burst stops being the last segment
          // when the first text part lands after it.
          if (step >= config.warmup) {
            const fail = (rule: string, actual: string) =>
              violations.push({ cell: cellName, rep: repIndex, variant: name, step, rule, actual });
            if (rec.newTurnObjects !== 1) fail('stabilizeTurns yields exactly 1 new turn object', String(rec.newTurnObjects));
            // The load-bearing fact: nothing under a settled turn renders.
            for (const k of PROBE_NAMES) {
              if (k === 'TurnViewport') continue; // not memoized; re-renders with the list by design
              if (settled.counts[k] !== 0) {
                fail(`settled-turn ${k} bodies render 0 times per step`, `${settled.counts[k]} in ${settled.turnIds.join(',')}`);
              }
            }
            // The working turn renders, and exactly its streaming segment re-parses.
            if (working.SessionTurn < 1) fail('working-turn SessionTurn body renders at least once per step', '0');
            if (working.UserMessage < 1) fail('working-turn UserMessage renders at least once per step', '0');
            if (working.ThrottledMarkdown < 1) fail('working-turn ThrottledMarkdown renders at least once per step', '0');
            // The burst (bash, read) is untouched by either step shape once the
            // first appended text sits after it; its memo must hold.
            if (working.ActivityBurst !== 0) fail(`working-turn ActivityBurst renders per ${name} step == 0`, String(working.ActivityBurst));
            if (working.ToolPartRenderer !== 0) {
              fail(`working-turn ToolPartRenderer renders per ${name} step == 0`, String(working.ToolPartRenderer));
            }
            if (!identityKept) fail('settled-turn <img> elements keep identity', `${before.length}→${after.length}`);
          }

          session = next.session;
          frame = nf;
        }
        return v;
      };

      const b1 = await runVariant('b1', (s, step) => fixture.appendTextPart(s, step));
      const b2 = await runVariant('b2', (s, step) => fixture.growTrailingText(s, step));

      flushSync(() => root.unmount());
      container.remove();
      queryClient.clear();
      await settle(1);

      return {
        ssrFirstRenderMs,
        firstRenderMs,
        mountSettleMs,
        mountProbeCounts,
        mountCascadeCounts,
        busyFlipMs,
        busyFlipProbeCounts,
        pipelineOnlyMs,
        b1,
        b2,
        domNodes,
        imgNodes,
      };
    }
  }

  // ---- output ----
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const gitSha = (() => {
    try {
      return Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], stdout: 'pipe', stderr: 'ignore' })
        .stdout.toString()
        .trim();
    } catch {
      return 'unknown';
    }
  })();
  const timestamp = new Date().toISOString();
  const result = {
    bench: 'transcript-render',
    version: 1,
    timestamp,
    env: {
      gitSha,
      bun: process.versions.bun,
      react: reactVersion,
      reactBuild,
      reactDom: config.profiler ? 'react-dom/profiling' : 'react-dom/client',
      dom: 'happy-dom (GlobalRegistrator)',
      cpu: os.cpus()[0]?.model ?? 'unknown',
      platform: `${process.platform} ${os.release()}`,
    },
    config: {
      profile: config.profile,
      reps: config.reps,
      steps: config.steps,
      warmup: config.warmup,
      imageBytes: config.imageBytes,
      mountQuiesceMs: config.mountQuiesceMs,
      cells: config.cells.map((c) => `${c.n}:${c.m}${c.oneTurn ? '@one' : ''}`),
    },
    cells: cellResults,
    violations,
    ok: violations.length === 0,
  };

  const repoRoot = path.resolve(import.meta.dir, '../../../../../..');
  const outDir = path.join(repoRoot, 'tests', 'test-results', 'local');
  const outPath = config.out ?? path.join(outDir, `bench-transcript-${timestamp.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

  printTable(result, outPath);
  process.stdout.write(JSON.stringify(result) + '\n');
  return violations.length === 0 ? 0 : 1;
}

function printTable(result: any, outPath: string) {
  const e = result.env;
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `transcript-render bench  sha=${String(e.gitSha).slice(0, 10)}  bun=${e.bun}  react=${e.react} (${e.reactBuild}, ${e.reactDom})  reps=${result.config.reps} steps=${result.config.steps} warmup=${result.config.warmup}`,
  );
  lines.push(`cpu=${e.cpu}`);
  lines.push('');
  const head = [
    'cell'.padEnd(16),
    'dom'.padStart(6),
    'img'.padStart(4),
    'ssr ms'.padStart(8),
    'first ms'.padStart(9),
    'busy ms'.padStart(8),
    'casc'.padStart(6),
    'pipe p50'.padStart(9),
    'b1 p50'.padStart(8),
    'b1 p95'.padStart(8),
    'b2 p50'.padStart(8),
    'b2 p95'.padStart(8),
    'settled/work'.padStart(12),
    'rows/step'.padStart(10),
    'UM'.padStart(4),
    'TM'.padStart(4),
    'AB'.padStart(4),
    'TPR'.padStart(4),
  ].join(' ');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const c of result.cells) {
    const b1 = c.b1_appendPart;
    const b2 = c.b2_delta;
    const r = b1.rendersPerStepMax;
    lines.push(
      [
        c.cell.padEnd(16),
        String(c.domNodes).padStart(6),
        String(c.imgNodes).padStart(4),
        fmt(c.ssrFirstRenderMs).padStart(8),
        fmt(c.firstRenderMs).padStart(9),
        fmt(c.busyFlipMs).padStart(8),
        String(c.mountCascadeRenders.SessionTurn).padStart(6),
        fmt(c.pipelineOnlyMs.p50).padStart(9),
        fmt(b1.frameMs.p50).padStart(8),
        fmt(b1.frameMs.p95).padStart(8),
        fmt(b2.frameMs.p50).padStart(8),
        fmt(b2.frameMs.p95).padStart(8),
        `${rng(b1.settledTurnBodyRendersPerStep)}/${rng(b1.workingTurnBodyRendersPerStep)} of ${c.turns}`.padStart(12),
        String(r.TurnViewport).padStart(10),
        String(r.UserMessage).padStart(4),
        String(r.ThrottledMarkdown).padStart(4),
        String(r.ActivityBurst).padStart(4),
        String(r.ToolPartRenderer).padStart(4),
      ].join(' '),
    );
  }
  lines.push('');
  lines.push(
    'cols: ssr=renderToStaticMarkup first render; first=createRoot first commit (idle session); busy=all-turns sessionWorking flip;',
  );
  lines.push(
    `      casc=SessionTurn bodies that render with NO input in the ${result.config.mountQuiesceMs} ms after mount (the 2.5 s status-throttle cascade);`,
  );
  lines.push(
    '      pipe=groupMessagesIntoTurns+stabilizeTurns+planAnchorMessageId per frame (no React); b1=append one text part; b2=delta on trailing text;',
  );
  lines.push(
    '      settled/work=SessionTurn bodies rendered per b1 step in settled turns / in the working turn (min-max), of total turns; rows/step=TurnViewport wrappers rendered;',
  );
  lines.push('      UM/TM/AB/TPR=max UserMessage/ThrottledMarkdown/ActivityBurst/ToolPartRenderer bodies per b1 step');
  if (result.violations.length) {
    lines.push('');
    lines.push(`INVARIANT VIOLATIONS: ${result.violations.length}`);
    const shown = new Map<string, number>();
    for (const v of result.violations) {
      const key = `${v.cell} ${v.variant} — ${v.rule} (got ${v.actual})`;
      shown.set(key, (shown.get(key) ?? 0) + 1);
    }
    for (const [k, n] of shown) lines.push(`  ${k} ×${n}`);
  } else {
    lines.push('');
    lines.push('invariants: OK (1 new turn object per step; 0 bodies rendered under settled turns; working-turn burst memo holds; settled <img> identity kept)');
  }
  lines.push('');
  lines.push(`json: ${outPath}`);
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

function rng(r: { min: number; max: number }): string {
  return r.min === r.max ? String(r.min) : `${r.min}-${r.max}`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '-';
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

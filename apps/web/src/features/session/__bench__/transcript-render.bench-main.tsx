/**
 * Transcript render benchmark — the committing-renderer half. Entry point and
 * knobs are documented in `transcript-render.bench.ts`; inputs in `fixture.ts`.
 *
 * Everything here is process-wide on purpose (a Bun loader plugin that rewrites
 * component sources, a happy-dom global document), which is why this runs
 * as its own `bun run` process and never inside the shared `bun test` one.
 *
 * ONE HARNESS, TWO TREES. The bench detects which transcript tree the checkout
 * has and drives it with the same mount, the same steps, the same probes and
 * the same table, so a BEFORE json (legacy) and an AFTER json (rows) compare
 * cell for cell:
 *
 * - `legacy` (turn-based, before Stage 2): `session-chat.tsx` renders one
 *   `SessionTurn` per turn. `SessionTurn` is module-private; a `Bun.plugin`
 *   `onLoad` rewrites that file in memory to also export it as
 *   `__benchSessionTurn`. The bench renders the `turns.map(...)` block of
 *   `SessionChat` with every host prop pinned.
 * - `rows` (Stage 2): `timeline/session-timeline-list.tsx` exists and
 *   `SessionChat` renders `buildChatRows(...)` → `<SessionTimelineList>`. The
 *   bench runs the same host pipeline (`stabilizeTurns` → `buildChatRows` with
 *   the previous rows → `turnsById` / `turnRenderKeys`) outside React, exactly
 *   like `__fixtures__/render-list.tsx` and `SessionChat`, and renders
 *   `<SessionTimelineList>` with every host prop pinned.
 *
 * How the REAL components are reached without editing them: render counting
 * uses the loader. Each probed component's plain function body is wrapped by
 * `globalThis.__kortixBenchProbe(name, Impl)` BEFORE any `memo()` is applied,
 * so the memo boundaries are the production ones and the counter increments
 * exactly when a body runs. Shared leaves on both trees: `UserMessage`,
 * `ActivityBurstImpl`, `ThrottledMarkdownImpl`, `ToolPartRendererImpl`,
 * `TurnViewport`. Legacy only: `SessionTurnImpl`. Rows only: `TurnFrame`,
 * `UserMessageRowImpl`, `AssistantPartRowImpl`, `TurnTailRowImpl`. Every
 * rewrite asserts a single match; a refactor that moves a declaration fails
 * this bench loudly.
 *
 * Per-turn attribution (settled vs working): on the legacy tree the bench
 * wraps every `SessionTurn` in a `BenchTurnContext.Provider`; on the rows tree
 * the list owns the per-turn element, so the `TurnFrame` probe provides the
 * same context from `props.group.userMessageID`. The leaf probes read it.
 *
 * TWO LIST MODES on the rows tree (`BENCH_LIST`, Stage 3):
 * - `flat` (default): `<SessionTimelineList>` with NO scroll element — the
 *   static render path, every turn in the DOM. What a BEFORE (legacy) json
 *   compares against cell for cell.
 * - `virtual`: the list sits in a scroll container and gets `scrollElement` +
 *   `virtualizerTestSeam` — an injected 800×900 viewport rect, a 160 px
 *   per-turn measure (happy-dom lays nothing out, so every turn IS its
 *   estimate) and a `scrollToFn` that clamps like a browser and reports the
 *   offset through a scroll event on the next macrotask. The list mounts once
 *   the scroll element exists (the ref-callback state write is flushed inside
 *   the same `flushSync`), exactly as `SessionChat` does, so the first paint is
 *   the virtual window at the end — never every turn flat first. The `mounted`
 *   column is `[data-turn-id]` elements in the DOM after mount / total turns.
 */
import type { ComponentType, ReactNode } from 'react';

import type { Turn } from '@/ui';
import type { TimelineRow } from '@kortix/sdk';
import type { BenchSession, PipelineFrame } from './fixture';

// ---------------------------------------------------------------------------
// Tree detection
// ---------------------------------------------------------------------------

export type TranscriptTree = 'legacy' | 'rows';

async function detectTree(): Promise<TranscriptTree> {
  const path = await import('node:path');
  const rowsList = path.join(import.meta.dir, '..', 'timeline', 'session-timeline-list.tsx');
  return (await Bun.file(rowsList).exists()) ? 'rows' : 'legacy';
}

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
  if (!Number.isFinite(v) || v < 0)
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
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

export type ListMode = 'flat' | 'virtual';

function resolveConfig() {
  const full = process.env.KORTIX_BENCH === '1' || process.env.BENCH_PROFILE === 'full';
  const listRaw = process.env.BENCH_LIST ?? 'flat';
  if (listRaw !== 'flat' && listRaw !== 'virtual') {
    throw new Error(`BENCH_LIST must be "flat" or "virtual", got ${listRaw}`);
  }
  const list: ListMode = listRaw;
  const cells = process.env.BENCH_CELLS
    ? parseCells(process.env.BENCH_CELLS)
    : full
      ? FULL_CELLS
      : QUICK_CELLS;
  const steps = envInt('BENCH_STEPS', 50);
  const warmup = envInt('BENCH_WARMUP', 5);
  if (warmup >= steps) throw new Error(`BENCH_WARMUP (${warmup}) must be < BENCH_STEPS (${steps})`);
  return {
    profile: full ? 'full' : 'quick',
    /** Rows tree only: `flat` (no scroll element, static path) or `virtual` (seam). */
    list,
    cells,
    reps: Math.max(1, envInt('BENCH_REPS', 5)),
    steps,
    warmup,
    imageBytes: envInt('BENCH_IMAGE_BYTES', 512 * 1024),
    // Real-time wait after mount before any step runs. Must exceed the 2.5 s
    // status throttle (legacy: `SessionTurnImpl`; rows: `TurnFrame` — both
    // `setThrottledStatus` on a `setTimeout(2500 - elapsed)` armed by every
    // turn's mount effect): that timer re-renders EVERY turn body ~2.5 s
    // after mount, and if it fires inside the step loop it shows up as
    // settled-turn renders — which it is, but it is the mount's cascade, not
    // the step's. The wait makes the steps measure steady state and the
    // cascade is reported on its own as `mountCascadeRenders`.
    mountQuiesceMs: envInt('BENCH_MOUNT_QUIESCE_MS', 3500),
    profiler: process.env.BENCH_PROFILER === '1',
    out: process.env.BENCH_OUT,
    /** A previous result json to print a BEFORE/AFTER delta table against. */
    compare: process.env.BENCH_COMPARE,
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
  'TurnFrame',
  'UserMessageRow',
  'AssistantPartRow',
  'TurnTailRow',
] as const;
type ProbeName = (typeof PROBE_NAMES)[number];

/** Probes that exist only on one tree (always 0 on the other). */
const LEGACY_ONLY_PROBES: ReadonlySet<ProbeName> = new Set<ProbeName>(['SessionTurn']);
const ROWS_ONLY_PROBES: ReadonlySet<ProbeName> = new Set<ProbeName>([
  'TurnFrame',
  'UserMessageRow',
  'AssistantPartRow',
  'TurnTailRow',
]);
/**
 * Not memoized by design — they re-render with the list every frame and are
 * reported (`rows/step`, `TF`) but never asserted 0 under a settled turn.
 * `TurnViewport` is the `[data-turn-id]` wrapper on both trees. `TurnFrame`
 * (rows tree) was unmemoized through Stage 2 — it owns the per-turn hooks and
 * re-derived the (cached) view every frame; since Stage 3 it is `memo`'d over
 * a stable `group` (`groupRowsByTurn` reuses the previous group object when
 * its rows did not change), so on that tree its settled-turn bodies ARE
 * asserted 0. `installSourceProbes` detects which declaration the checkout has
 * (`turnFrameMemoized`).
 */
const UNMEMOIZED_PROBES: Set<ProbeName> = new Set<ProbeName>(['TurnViewport', 'TurnFrame']);
let turnFrameMemoized = false;

type ProbeCounts = Record<ProbeName, number>;

interface ProbeState {
  counts: ProbeCounts;
  /** turn id → per-probe body runs under that turn. */
  perTurn: Map<string, ProbeCounts>;
}

function emptyCounts(): ProbeCounts {
  const c = {} as ProbeCounts;
  for (const k of PROBE_NAMES) c[k] = 0;
  return c;
}

function emptyProbeState(): ProbeState {
  return { counts: emptyCounts(), perTurn: new Map() };
}

/** Sum of every probe's body runs outside `workingTurnId`, plus the turn ids involved. */
function settledTurnRenders(
  state: ProbeState,
  workingTurnId: string | null,
): { counts: ProbeCounts; turnIds: string[] } {
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

/**
 * "Row bodies" — the per-turn unit the `settled/work` column counts and the
 * settled-turn invariant guards. Legacy: the `SessionTurn` body (one per turn).
 * Rows: the `SessionTimelineList` row components (`AssistantPartRow` +
 * `UserMessageRow` + `TurnTailRow`) — several per turn.
 */
function rowBodies(tree: TranscriptTree, c: ProbeCounts): number {
  return tree === 'legacy' ? c.SessionTurn : c.AssistantPartRow + c.UserMessageRow + c.TurnTailRow;
}

/** The per-turn body that owns the status throttle (the `casc` / `busy` column). */
function turnBodyProbe(tree: TranscriptTree): ProbeName {
  return tree === 'legacy' ? 'SessionTurn' : 'TurnFrame';
}

// Set once React is imported: the leaf probe wrappers call `useContext` to
// learn which turn they render under; the TurnFrame probe (rows tree)
// PROVIDES it from its own props.
let BenchTurnContext: import('react').Context<string | null> | null = null;
let ReactRef: typeof import('react') | null = null;
/** `React.useContext`, aliased: the leaf probes call it on every render of
 *  their component (a turn-owning probe never does) — the order is fixed per
 *  component, which is what the hooks rule requires. */
let reactUseContext: typeof import('react').useContext | null = null;
/** `BENCH_PROFILER=1`: per-turn `<React.Profiler>` sink (rows tree wraps inside the TurnFrame probe). */
let profilerSink: ((id: string, phase: string, actualDuration: number) => void) | null = null;

function installProbeFactory() {
  (globalThis as any).__kortixBenchProbe = (
    name: ProbeName,
    Impl: (props: any) => any,
    turnIdOf?: (props: any) => string,
  ) => {
    if (!PROBE_NAMES.includes(name)) throw new Error(`unknown probe ${name}`);
    const Probed = function KortixBenchProbe(props: any) {
      probeState.counts[name]++;
      const turnId: string | null = turnIdOf
        ? turnIdOf(props)
        : BenchTurnContext && reactUseContext
          ? reactUseContext(BenchTurnContext)
          : null;
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
      const out = Impl(props);
      if (!turnIdOf || !ReactRef || !BenchTurnContext) return out;
      // A turn-owning probe provides the turn id to the leaf probes below it —
      // the same `BenchTurnContext.Provider` the legacy mount puts around each
      // `SessionTurn` — and hosts the optional per-turn Profiler.
      let node: ReactNode = out;
      if (profilerSink) {
        const sink = profilerSink;
        node = ReactRef.createElement(
          ReactRef.Profiler,
          { id: turnId!, onRender: (id: string, phase: string, d: number) => sink(id, phase, d) },
          node,
        );
      }
      return ReactRef.createElement(BenchTurnContext.Provider, { value: turnId }, node);
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

type Rewrite = (src: string, file: string) => string;

/** Leaves shared by both trees. */
const SHARED_REWRITES: Record<string, Rewrite> = {
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

const LEGACY_REWRITES: Record<string, Rewrite> = {
  'session-chat.tsx': (src, file) =>
    replaceOnce(
      src,
      file,
      'const SessionTurn = memo(SessionTurnImpl);',
      "const SessionTurn = memo(globalThis.__kortixBenchProbe('SessionTurn', SessionTurnImpl));",
    ) + '\nexport { SessionTurn as __benchSessionTurn };\n',
  ...SHARED_REWRITES,
};

const ROWS_REWRITES: Record<string, Rewrite> = {
  'session-timeline-list.tsx': (src, file) => {
    // Stage 3: `function TurnFrameImpl({` + `const TurnFrame = memo(TurnFrameImpl, sameTurnFrameProps)`.
    // Stage 2: `function TurnFrame({` alone (unmemoized; `TurnFrame` bound at the end, below).
    const memoized = src.includes('const TurnFrame = memo(TurnFrameImpl, sameTurnFrameProps);');
    turnFrameMemoized = memoized;
    if (memoized) UNMEMOIZED_PROBES.delete('TurnFrame');
    let s = memoized
      ? replaceOnce(
          replaceOnce(src, file, 'function TurnFrameImpl({', 'function TurnFrameBenchImpl({'),
          file,
          'const TurnFrame = memo(TurnFrameImpl, sameTurnFrameProps);',
          "const TurnFrame = memo(globalThis.__kortixBenchProbe('TurnFrame', TurnFrameBenchImpl, (p) => p.group.userMessageID), sameTurnFrameProps);",
        )
      : replaceOnce(src, file, 'function TurnFrame({', 'function TurnFrameBenchImpl({');
    s = replaceOnce(
      s,
      file,
      'export const UserMessageRow = memo(UserMessageRowImpl);',
      "export const UserMessageRow = memo(globalThis.__kortixBenchProbe('UserMessageRow', UserMessageRowImpl));",
    );
    s = replaceOnce(
      s,
      file,
      'export const AssistantPartRow = memo(\n  AssistantPartRowImpl,',
      "export const AssistantPartRow = memo(\n  globalThis.__kortixBenchProbe('AssistantPartRow', AssistantPartRowImpl),",
    );
    s = replaceOnce(
      s,
      file,
      'export const TurnTailRow = memo(TurnTailRowImpl);',
      "export const TurnTailRow = memo(globalThis.__kortixBenchProbe('TurnTailRow', TurnTailRowImpl));",
    );
    if (memoized) return s;
    // Stage 2: `SessionTimelineList` references `TurnFrame` at render time
    // only, so the probed binding can sit at the end of the module. The probe
    // provides `BenchTurnContext` from the frame's own `group.userMessageID`.
    return (
      s +
      "\nconst TurnFrame = globalThis.__kortixBenchProbe('TurnFrame', TurnFrameBenchImpl, (p) => p.group.userMessageID);\n"
    );
  },
  ...SHARED_REWRITES,
};

const LEGACY_FILTER =
  /features\/session\/(session-chat|turn\/user-message|turn\/activity-burst|turn\/throttled-markdown|turn\/turn-viewport|tool\/tool-part-renderer)\.tsx$/;
const ROWS_FILTER =
  /features\/session\/(timeline\/session-timeline-list|turn\/user-message|turn\/activity-burst|turn\/throttled-markdown|turn\/turn-viewport|tool\/tool-part-renderer)\.tsx$/;

function installSourceProbes(tree: TranscriptTree) {
  installProbeFactory();
  const rewrites = tree === 'legacy' ? LEGACY_REWRITES : ROWS_REWRITES;
  const filter = tree === 'legacy' ? LEGACY_FILTER : ROWS_FILTER;
  const seen = new Set<string>();
  Bun.plugin({
    name: 'kortix-transcript-bench-probes',
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const file = args.path.split('/').pop()!;
        const rewrite = rewrites[file];
        if (!rewrite) throw new Error(`bench: no rewrite registered for ${file}`);
        const src = await Bun.file(args.path).text();
        seen.add(file);
        return { contents: rewrite(src, file), loader: 'tsx' };
      });
    },
  });
  return () => {
    const missing = Object.keys(rewrites).filter((f) => !seen.has(f));
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
  return round(
    quantile(
      [...values].sort((a, b) => a - b),
      0.5,
    ),
  );
}

// ---------------------------------------------------------------------------
// Host frame — the per-frame host pipeline of `SessionChat`, outside React
// ---------------------------------------------------------------------------

/**
 * One frame of host-derived state. Both trees: `groupMessagesIntoTurns` →
 * `stabilizeTurns(raw, prev)` → `planAnchorMessageId` (`fixture.pipelineFrame`).
 * Rows tree additionally: `deriveAnsweredQuestionIds` → `buildChatRows(…, prev
 * rows)` → `turnsById` → `turnRenderKeys` — the `useMemo`s of the same names in
 * `session-chat.tsx`, fed the SAME inputs as `__fixtures__/render-list.tsx`.
 */
interface HostFrame extends PipelineFrame {
  /** `resolveWorkingTurn`: the newest turn whose last assistant message has no
   *  `time.completed` — the fixture's last turn, busy or idle. */
  workingTurnId: string | null;
  rows: TimelineRow[] | null;
  turnsById: Map<string, Turn> | null;
  turnRenderKeys: Map<string, string> | null;
  /** Rows in this frame that are not the same object as the row with that key in `prev`. */
  newRowObjects: number;
  /** ms spent in the rows half (`deriveAnsweredQuestionIds` + `buildChatRows`). */
  rowsMs: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface StepRecord {
  frameMs: number;
  settleMs: number;
  newTurnObjects: number;
  newRowObjects: number;
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
  newRowObjects: number[];
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
  rowsOnlyMs: number[];
  b1: VariantRep;
  b2: VariantRep;
  domNodes: number;
  imgNodes: number;
  rowCount: number;
  /** `[data-turn-id]` elements in the DOM after the mount settled — every
   *  turn for a flat list, the window + overscan + pinned tail for a virtual one. */
  mountedTurns: number;
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
  const tree = await detectTree();
  if (tree === 'legacy' && config.list === 'virtual') {
    throw new Error('BENCH_LIST=virtual needs the rows tree (timeline/session-timeline-list.tsx)');
  }
  const assertProbesRan = installSourceProbes(tree);
  await registerDom();
  // The mounted list prefetches models.dev pricing (`useModelPricingLookup`)
  // — a real fetch whose `.then` would re-render every turn mid-run. Seed
  // the module cache: no network, no late pricing flip.
  (await import('@/lib/model-pricing')).__testing.seed();

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
  ReactRef = React;
  reactUseContext = React.useContext;

  // ---- tree-specific imports (the probes apply while these load) ----
  let SessionTurn: ComponentType<any> | null = null;
  let SessionTimelineList: ComponentType<any> | null = null;
  let buildChatRows: typeof import('../timeline/build-chat-rows').buildChatRows | null = null;
  let deriveAnsweredQuestionIds:
    typeof import('../timeline/project-rows').deriveAnsweredQuestionIds | null = null;
  if (tree === 'legacy') {
    const sessionChat = (await import('../session-chat')) as any;
    SessionTurn = sessionChat.__benchSessionTurn as ComponentType<any>;
    if (!SessionTurn)
      throw new Error('bench: __benchSessionTurn export missing — source probe did not apply');
  } else {
    // Dynamic specifiers: on the legacy tree these files do not exist and a
    // static import would fail to resolve before `detectTree` ever ran.
    const listModule = '../timeline/session-timeline-list';
    const rowsModule = '../timeline/build-chat-rows';
    const projectModule = '../timeline/project-rows';
    SessionTimelineList = (
      (await import(listModule)) as typeof import('../timeline/session-timeline-list')
    ).SessionTimelineList as ComponentType<any>;
    buildChatRows = ((await import(rowsModule)) as typeof import('../timeline/build-chat-rows'))
      .buildChatRows;
    deriveAnsweredQuestionIds = (
      (await import(projectModule)) as typeof import('../timeline/project-rows')
    ).deriveAnsweredQuestionIds;
  }
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
  const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
  const EMPTY_INBOX: ReadonlyMap<string, any> = new Map();
  const COMMAND_MESSAGES = new Map<string, { name: string; args?: string }>();
  const STATUS_BUSY = { type: 'busy' } as any;
  const STATUS_IDLE = { type: 'idle' } as any;
  // next-intl derives its context value from the `messages` object identity; a
  // fresh `{}` per render would re-render every `useTranslations` consumer
  // (SessionTurnImpl, UserMessage, TurnTailRow) through context and bypass
  // their memo. The real host passes one stable messages object, so the bench
  // does too.
  const INTL_MESSAGES: Record<string, never> = {};

  /** Host pipeline for one frame — see `HostFrame`. */
  function hostFrame(
    messages: BenchSession['messages'],
    prev: HostFrame | null,
    working: boolean,
  ): HostFrame {
    const pipeline = fixture.pipelineFrame(messages, prev?.turns ?? []);
    const { turns } = pipeline;
    const workingTurnId = turns.length ? turns[turns.length - 1].userMessage.info.id : null;
    if (tree === 'legacy') {
      return {
        ...pipeline,
        workingTurnId,
        rows: null,
        turnsById: null,
        turnRenderKeys: null,
        newRowObjects: 0,
        rowsMs: 0,
      };
    }
    const r0 = performance.now();
    const answeredQuestionIds = deriveAnsweredQuestionIds!(
      turns,
      EMPTY_QUESTIONS,
      fixture.SESSION_ID,
    );
    const rows = buildChatRows!({
      messages,
      activeUserMessageID: workingTurnId,
      status: working ? 'busy' : 'idle',
      standaloneCallIds: EMPTY_ID_SET,
      answeredQuestionIds,
      prev: prev?.rows ?? undefined,
    });
    const rowsMs = performance.now() - r0;
    // `turnsById` / `turnRenderKeys`: the `useMemo`s on `turns` in SessionChat —
    // a new Map per frame whose `turns` changed, which is every step.
    const turnsById = new Map<string, Turn>();
    const turnRenderKeys = new Map<string, string>();
    for (const turn of turns) {
      const id = turn.userMessage.info.id;
      turnsById.set(id, turn);
      turnRenderKeys.set(id, id);
    }
    let newRowObjects = 0;
    if (prev?.rows) {
      const byKey = new Map<string, TimelineRow>();
      for (const row of prev.rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
      for (const row of rows) if (byKey.get(row.key) !== row) newRowObjects++;
    } else {
      newRowObjects = rows.length;
    }
    return { ...pipeline, workingTurnId, rows, turnsById, turnRenderKeys, newRowObjects, rowsMs };
  }

  interface TranscriptProps {
    frame: HostFrame;
    working: boolean;
    /** The static (SSR) measurement: the list with no scroll element, in either mode. */
    forceFlat?: boolean;
    onProfilerRender?: (id: string, phase: string, actualDuration: number) => void;
  }

  /** Virtual mode: the injected scroll rect (happy-dom lays nothing out). */
  const VIEWPORT_HEIGHT = 900;
  const VIEWPORT_WIDTH = 800;
  /** Virtual mode: every turn measures this tall (no layout → estimate path). */
  const TURN_ESTIMATE_PX = 160;

  /**
   * LEGACY: the `turns.map(...)` block of `SessionChat` (session-chat.tsx)
   * with every host-derived prop pinned: the last turn is the working turn
   * while `working`, no queue rows, no permissions, no compaction.
   */
  const TurnCtx = BenchTurnContext;
  function LegacyTranscript({ frame, working, onProfilerRender }: TranscriptProps) {
    const { turns, planAnchorId } = frame;
    const lastId = turns.length ? turns[turns.length - 1].userMessage.info.id : null;
    const SessionTurnC = SessionTurn!;
    return (
      <div className="flex flex-col">
        {turns.map((turn, turnIndex) => {
          const id = turn.userMessage.info.id;
          const isLast = id === lastId;
          let node: ReactNode = (
            <TurnCtx.Provider value={id}>
              <SessionTurnC
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
                onRender={(pid, phase, actualDuration) =>
                  onProfilerRender(pid, phase, actualDuration)
                }
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
   * ROWS (Stage 2): what `SessionChat` renders for the transcript —
   * `<SessionTimelineList>` over `buildChatRows` + the host facts, with every
   * prop pinned exactly like `__fixtures__/render-list.tsx`: no pending /
   * interrupted turns, no inbox rows, no permissions, no questions, no
   * providers, `sessionStatus` busy while working and idle otherwise.
   * `workingTurnId` is the last turn on every frame (`resolveWorkingTurn`);
   * `sessionWorking` decides whether it IS working — same as the host.
   * The per-turn Profiler (`BENCH_PROFILER=1`) rides inside the TurnFrame
   * probe (`profilerSink`).
   */
  function RowsTranscript({ frame, working, forceFlat }: TranscriptProps) {
    const List = SessionTimelineList!;
    const virtual = config.list === 'virtual' && !forceFlat;
    // The scroll container, as STATE (the list virtualizes against it) —
    // `SessionChat.scrollContainerCallbackRef` → `setScrollElement`.
    const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
    const seam = React.useMemo(
      () =>
        scrollEl
          ? {
              initialRect: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
              observeElementRect: (
                _instance: unknown,
                cb: (rect: { width: number; height: number }) => void,
              ) => {
                cb({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
              },
              measureElement: () => TURN_ESTIMATE_PX,
              // A browser clamps scrollTop to the scrollable range and reports
              // it through a scroll event on the next frame; happy-dom does
              // neither.
              scrollToFn: (offset: number, _opts: unknown, instance: any) => {
                const max = Math.max(0, instance.getTotalSize() - VIEWPORT_HEIGHT);
                scrollEl.scrollTop = Math.max(0, Math.min(offset, max));
                setTimeout(() => {
                  const view = scrollEl.ownerDocument.defaultView as unknown as {
                    Event: typeof Event;
                  };
                  scrollEl.dispatchEvent(new view.Event('scroll'));
                }, 0);
              },
            }
          : undefined,
      [scrollEl],
    );
    const list = (
      <List
        rows={frame.rows!}
        turnsById={frame.turnsById!}
        turnRenderKeys={frame.turnRenderKeys!}
        pendingTurnIds={EMPTY_ID_SET}
        interruptedTurnIds={EMPTY_ID_SET}
        sessionWorking={working}
        workingTurnId={frame.workingTurnId}
        planAnchorId={frame.planAnchorId}
        inboxRowsByMessageId={EMPTY_INBOX}
        queueHeld={false}
        onQueueRemove={noop}
        onQueueSendNow={noop}
        onQueueRetry={noop}
        sessionId={fixture.SESSION_ID}
        sessionStatus={working ? STATUS_BUSY : STATUS_IDLE}
        permissions={EMPTY_PERMISSIONS}
        questions={EMPTY_QUESTIONS}
        agentNames={undefined}
        providers={undefined}
        commandMessages={COMMAND_MESSAGES}
        commands={EMPTY_COMMANDS}
        disableToolNavigation={false}
        onPermissionReply={noopAsync}
        onRewind={noop}
        rewindDisabled={working}
        {...(virtual
          ? { scrollElement: scrollEl, initialAtEnd: true, virtualizerTestSeam: seam }
          : {})}
      />
    );
    if (!virtual) return <div className="flex flex-col">{list}</div>;
    // As `SessionChat` does: the list mounts once the scroll container exists
    // (the ref-callback state write is flushed inside the same `flushSync`),
    // so the virtualizing list never paints every turn flat first.
    return (
      <div
        ref={setScrollEl}
        data-bench-scroll
        style={{ height: VIEWPORT_HEIGHT, overflowY: 'auto' }}
      >
        <div className="flex flex-col">{scrollEl ? list : null}</div>
      </div>
    );
  }

  const Transcript = tree === 'legacy' ? LegacyTranscript : RowsTranscript;

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
  const TURN_BODY = turnBodyProbe(tree);

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
        throw new Error(
          `bench: React reported ${renderErrors.length} error(s) in ${cellName} rep ${rep}:\n${renderErrors.join('\n')}`,
        );
      }
    }

    const pick = (f: (r: RepResult) => number) => reps.map(f);
    const variantSummary = (v: (r: RepResult) => VariantRep) => {
      const frame = reps.map((r) => summarize(v(r).frameMs.slice(config.warmup)));
      const settleS = reps.map((r) => summarize(v(r).settleMs.slice(config.warmup)));
      const countsAfterWarmup = reps.flatMap((r) => v(r).counts.slice(config.warmup));
      const maxCounts = emptyCounts();
      for (const c of countsAfterWarmup)
        for (const k of PROBE_NAMES) maxCounts[k] = Math.max(maxCounts[k], c[k]);
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
        /** Legacy: SessionTurn bodies per step. Rows: TurnFrame bodies per step (the turn-owning body). */
        sessionTurnRendersPerStep: {
          min: Math.min(...renderedTurns),
          max: Math.max(...renderedTurns),
        },
        workingTurnBodyRendersPerStep: {
          min: Math.min(...workingRenders),
          max: Math.max(...workingRenders),
        },
        settledTurnBodyRendersPerStep: {
          min: Math.min(...settledRenders),
          max: Math.max(...settledRenders),
        },
        newTurnObjectsPerStep: {
          min: Math.min(...reps.flatMap((r) => v(r).newTurnObjects)),
          max: Math.max(...reps.flatMap((r) => v(r).newTurnObjects)),
        },
        newRowObjectsPerStep: {
          min: Math.min(...reps.flatMap((r) => v(r).newRowObjects)),
          max: Math.max(...reps.flatMap((r) => v(r).newRowObjects)),
        },
        imgIdentityViolations: reps.reduce((a, r) => a + v(r).imgIdentityViolations, 0),
        ...(config.profiler
          ? {
              profilerMs: {
                settledTurnsPerStepP50: median(
                  reps.flatMap((r) => v(r).profilerSettledMs.slice(config.warmup)),
                ),
                workingTurnPerStepP50: median(
                  reps.flatMap((r) => v(r).profilerWorkingMs.slice(config.warmup)),
                ),
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
      /** `[data-turn-id]` elements after mount (flat: every turn; virtual: the window). */
      mountedTurns: reps[0].mountedTurns,
      /** Row components mounted (rows tree: AssistantPartRow+UserMessageRow+TurnTailRow; legacy: SessionTurn). */
      rowComponents: reps[0].rowCount,
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
      /** The rows half of the pipeline (`deriveAnsweredQuestionIds` + `buildChatRows`); 0 on legacy. */
      rowsOnlyMs: {
        p50: median(reps.map((r) => summarize(r.rowsOnlyMs.slice(config.warmup)).p50)),
        p95: median(reps.map((r) => summarize(r.rowsOnlyMs.slice(config.warmup)).p95)),
      },
      b1_appendPart: variantSummary((r) => r.b1),
      b2_delta: variantSummary((r) => r.b2),
    };
    cellResults.push(summary);

    // ---- one rep: mount, busy flip, b1 steps, b2 steps, unmount ----
    async function runRep(base: BenchSession, repIndex: number): Promise<RepResult> {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      let session = base;
      let frame: HostFrame = hostFrame(session.messages, null, false);

      // L1: renderToStaticMarkup of the same tree (no commit phase).
      const ssrT0 = performance.now();
      const html = renderToStaticMarkup(
        <App
          queryClient={queryClient}
          initial={{ frame, working: false, forceFlat: true }}
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
        onUncaughtError: (err) =>
          renderErrors.push(`uncaught: ${String((err as Error)?.stack ?? err)}`),
        onCaughtError: (err) =>
          renderErrors.push(`caught: ${String((err as Error)?.stack ?? err)}`),
        onRecoverableError: (err) =>
          renderErrors.push(`recoverable: ${String((err as Error)?.stack ?? err)}`),
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
      profilerSink = tree === 'rows' && onProfilerRender ? onProfilerRender : null;

      const handle: HostHandle = {
        set: () => {
          throw new Error('bench: Host not mounted');
        },
      };
      let mounted = false;
      const render = (f: HostFrame, working: boolean) => {
        const props: TranscriptProps = { frame: f, working, onProfilerRender };
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
      render(frame, false);
      const firstRenderMs = performance.now() - t0;
      const mountProbeCounts = { ...probeState.counts };
      const rowCount = rowBodies(tree, mountProbeCounts);

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
      const mountedTurns = container.querySelectorAll('[data-turn-id]').length;
      if (repIndex === 0) {
        // A flat list mounts every turn; a virtual one the window at the end
        // (+ overscan + the pinned tail). Either way the LAST turn is in the
        // DOM — it is the working turn every step measures.
        const virtual = tree === 'rows' && config.list === 'virtual';
        if (!virtual && mountedTurns !== frame.turns.length) {
          throw new Error(
            `bench: expected ${frame.turns.length} [data-turn-id] nodes, found ${mountedTurns}`,
          );
        }
        if (virtual && (mountedTurns < 1 || mountedTurns > frame.turns.length)) {
          throw new Error(
            `bench: expected 1..${frame.turns.length} [data-turn-id] nodes, found ${mountedTurns}`,
          );
        }
        const lastId = frame.turns[frame.turns.length - 1].userMessage.info.id;
        if (!container.querySelector(`[data-turn-id="${lastId}"]`)) {
          throw new Error(`bench: the last turn ${lastId} is not mounted after the mount settle`);
        }
        if (cell.m > 0 && imgNodes === 0 && mountedTurns === frame.turns.length) {
          throw new Error('bench: image file parts produced no <img> — attachment path changed');
        }
      }

      // The session goes busy (user sent a prompt): every turn sees
      // sessionWorking flip, so all T turn bodies render once. Measured apart
      // from the streaming steps so those stay clean. On the rows tree the
      // rows are rebuilt with `status: 'busy'` first (outside the timed span,
      // like every other host frame).
      resetProbes();
      frame = hostFrame(session.messages, frame, true);
      const bf0 = performance.now();
      render(frame, true);
      const busyFlipMs = performance.now() - bf0;
      const busyFlipProbeCounts = { ...probeState.counts };
      flushSync(() => drainRaf());
      await settle(2);

      workingTurnId = frame.workingTurnId;

      // L0: host pipeline only, no React, same step shape as b1.
      const pipelineOnlyMs: number[] = [];
      const rowsOnlyMs: number[] = [];
      {
        let s = session;
        let f = frame;
        for (let i = 0; i < config.steps; i++) {
          const next = fixture.appendTextPart(s, 1000 + i);
          const p0 = performance.now();
          const nf = hostFrame(next.session.messages, f, true);
          pipelineOnlyMs.push(performance.now() - p0);
          rowsOnlyMs.push(nf.rowsMs);
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
          newRowObjects: [],
          imgIdentityViolations: 0,
          profilerSettledMs: [],
          profilerWorkingMs: [],
        };
        for (let step = 0; step < config.steps; step++) {
          const before = settledImgs();
          const next = mutate(session, step);
          const nf = hostFrame(next.session.messages, frame, true);
          resetProbes();
          profilerAcc = { working: 0, settled: 0, settledCount: 0 };

          const f0 = performance.now();
          render(nf, true);
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
          const workingTurnBodyRenders = rowBodies(tree, working);
          const settledTurnBodyRenders = rowBodies(tree, settled.counts);

          const after = settledImgs();
          const identityKept =
            before.length === after.length && before.every((el, i) => el === after[i]);

          const rec: StepRecord = {
            frameMs,
            settleMs,
            newTurnObjects: nf.newTurnObjects,
            newRowObjects: nf.newRowObjects,
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
          v.renderedTurnCounts.push(rec.counts[TURN_BODY]);
          v.workingTurnBodyRenders.push(rec.workingTurnBodyRenders);
          v.settledTurnBodyRenders.push(rec.settledTurnBodyRenders);
          v.newTurnObjects.push(rec.newTurnObjects);
          v.newRowObjects.push(rec.newRowObjects);
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
            if (rec.newTurnObjects !== 1)
              fail('stabilizeTurns yields exactly 1 new turn object', String(rec.newTurnObjects));
            if (tree === 'rows') {
              // b1 appends one part → exactly one new row object. b2 grows the
              // trailing text → NO new row: a row references its part by id
              // (`reuseTimelineRows` keeps the object); the placement re-reads
              // the part's text, so only the `AssistantPartRow` re-renders.
              const want = name === 'b1' ? 1 : 0;
              if (rec.newRowObjects !== want) {
                fail(
                  `buildChatRows yields exactly ${want} new row object(s) per ${name} step`,
                  String(rec.newRowObjects),
                );
              }
            }
            // The load-bearing fact: nothing under a settled turn renders.
            for (const k of PROBE_NAMES) {
              if (UNMEMOIZED_PROBES.has(k)) continue; // re-render with the list by design
              if (settled.counts[k] !== 0) {
                fail(
                  `settled-turn ${k} bodies render 0 times per step`,
                  `${settled.counts[k]} in ${settled.turnIds.join(',')}`,
                );
              }
            }
            // The working turn renders, and exactly its streaming segment re-parses.
            if (workingTurnBodyRenders < 1)
              fail('working-turn row bodies render at least once per step', '0');
            if (working.ThrottledMarkdown < 1)
              fail('working-turn ThrottledMarkdown renders at least once per step', '0');
            if (tree === 'legacy') {
              // The legacy card re-renders its bubble with the turn (no memo below SessionTurn).
              if (working.UserMessage < 1)
                fail('working-turn UserMessage renders at least once per step', '0');
            }
            // Rows tree: the working turn's `UserMessageRow` is NOT asserted 0.
            // `buildSessionMessages` (sync-store.ts) rewraps `{ info, parts }` for
            // EVERY message on every frame (the fixture's `rewrap` mirrors it);
            // `stabilizeTurns` keeps whole-turn identity only, so the WORKING
            // turn's `turn.userMessage` is a new wrapper per step and the
            // bubble row's memo cannot hold. Reported as UMR / UM; see the
            // table note. (`session-timeline-list.render-count.test.tsx` feeds
            // the same `u2` object per frame, which is why it sees 0.)
            // The burst (bash, read) is untouched by either step shape once the
            // first appended text sits after it; its memo must hold.
            if (working.ActivityBurst !== 0)
              fail(
                `working-turn ActivityBurst renders per ${name} step == 0`,
                String(working.ActivityBurst),
              );
            if (working.ToolPartRenderer !== 0) {
              fail(
                `working-turn ToolPartRenderer renders per ${name} step == 0`,
                String(working.ToolPartRenderer),
              );
            }
            if (!identityKept)
              fail('settled-turn <img> elements keep identity', `${before.length}→${after.length}`);
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
      profilerSink = null;
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
        rowsOnlyMs,
        b1,
        b2,
        domNodes,
        imgNodes,
        rowCount,
        mountedTurns,
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
    version: 2,
    tree,
    /** Rows tree: `flat` or `virtual` (see `BENCH_LIST`); legacy is always flat. */
    list: tree === 'rows' ? config.list : 'flat',
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
      list: config.list,
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
  const outPath =
    config.out ?? path.join(outDir, `bench-transcript-${timestamp.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

  printTable(result, outPath);
  if (config.compare) {
    const before = JSON.parse(fs.readFileSync(config.compare, 'utf8'));
    printCompare(before, result, config.compare);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  return violations.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** The table columns, one source for the live table and the BEFORE/AFTER compare. */
type Col = {
  head: string;
  width: number;
  get: (c: any, tree: TranscriptTree) => string;
  num?: (c: any, tree: TranscriptTree) => number;
};

function treeOf(result: any): TranscriptTree {
  return result.tree === 'rows' ? 'rows' : 'legacy';
}

const COLUMNS: Col[] = [
  { head: 'cell', width: 16, get: (c) => c.cell },
  {
    head: 'mounted',
    width: 8,
    // A json from before the column (flat by construction) mounted every turn.
    get: (c) => `${c.mountedTurns ?? c.turns}/${c.turns}`,
    num: (c) => c.mountedTurns ?? c.turns,
  },
  { head: 'dom', width: 6, get: (c) => String(c.domNodes), num: (c) => c.domNodes },
  { head: 'img', width: 4, get: (c) => String(c.imgNodes), num: (c) => c.imgNodes },
  { head: 'ssr ms', width: 8, get: (c) => fmt(c.ssrFirstRenderMs), num: (c) => c.ssrFirstRenderMs },
  { head: 'first ms', width: 9, get: (c) => fmt(c.firstRenderMs), num: (c) => c.firstRenderMs },
  { head: 'busy ms', width: 8, get: (c) => fmt(c.busyFlipMs), num: (c) => c.busyFlipMs },
  {
    head: 'casc',
    width: 6,
    get: (c, tree) => String(c.mountCascadeRenders[turnBodyProbe(tree)] ?? 0),
    num: (c, tree) => c.mountCascadeRenders[turnBodyProbe(tree)] ?? 0,
  },
  {
    head: 'pipe p50',
    width: 9,
    get: (c) => fmt(c.pipelineOnlyMs.p50),
    num: (c) => c.pipelineOnlyMs.p50,
  },
  {
    head: 'b1 p50',
    width: 8,
    get: (c) => fmt(c.b1_appendPart.frameMs.p50),
    num: (c) => c.b1_appendPart.frameMs.p50,
  },
  {
    head: 'b1 p95',
    width: 8,
    get: (c) => fmt(c.b1_appendPart.frameMs.p95),
    num: (c) => c.b1_appendPart.frameMs.p95,
  },
  {
    head: 'b2 p50',
    width: 8,
    get: (c) => fmt(c.b2_delta.frameMs.p50),
    num: (c) => c.b2_delta.frameMs.p50,
  },
  {
    head: 'b2 p95',
    width: 8,
    get: (c) => fmt(c.b2_delta.frameMs.p95),
    num: (c) => c.b2_delta.frameMs.p95,
  },
  {
    head: 'settled/work',
    width: 14,
    get: (c, tree) =>
      `${rng(c.b1_appendPart.settledTurnBodyRendersPerStep)}/${rng(c.b1_appendPart.workingTurnBodyRendersPerStep)} of ${
        tree === 'legacy' ? c.turns : (c.rowComponents ?? '?')
      }`,
  },
  {
    head: 'rows/step',
    width: 10,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.TurnViewport),
    num: (c) => c.b1_appendPart.rendersPerStepMax.TurnViewport,
  },
  {
    head: 'UM',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.UserMessage),
    num: (c) => c.b1_appendPart.rendersPerStepMax.UserMessage,
  },
  {
    head: 'TM',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.ThrottledMarkdown),
    num: (c) => c.b1_appendPart.rendersPerStepMax.ThrottledMarkdown,
  },
  {
    head: 'AB',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.ActivityBurst),
    num: (c) => c.b1_appendPart.rendersPerStepMax.ActivityBurst,
  },
  {
    head: 'TPR',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.ToolPartRenderer),
    num: (c) => c.b1_appendPart.rendersPerStepMax.ToolPartRenderer,
  },
  {
    head: 'APR',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.AssistantPartRow ?? 0),
    num: (c) => c.b1_appendPart.rendersPerStepMax.AssistantPartRow ?? 0,
  },
  {
    head: 'UMR',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.UserMessageRow ?? 0),
    num: (c) => c.b1_appendPart.rendersPerStepMax.UserMessageRow ?? 0,
  },
  {
    head: 'TTR',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.TurnTailRow ?? 0),
    num: (c) => c.b1_appendPart.rendersPerStepMax.TurnTailRow ?? 0,
  },
  {
    head: 'TF',
    width: 4,
    get: (c) => String(c.b1_appendPart.rendersPerStepMax.TurnFrame ?? 0),
    num: (c) => c.b1_appendPart.rendersPerStepMax.TurnFrame ?? 0,
  },
];

function tableLines(result: any): string[] {
  const tree = treeOf(result);
  const lines: string[] = [];
  const head = COLUMNS.map((col, i) =>
    i === 0 ? col.head.padEnd(col.width) : col.head.padStart(col.width),
  ).join(' ');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const c of result.cells) {
    lines.push(
      COLUMNS.map((col, i) =>
        i === 0 ? col.get(c, tree).padEnd(col.width) : col.get(c, tree).padStart(col.width),
      ).join(' '),
    );
  }
  return lines;
}

function listOf(result: any): ListMode {
  return result.list === 'virtual' ? 'virtual' : 'flat';
}

function printTable(result: any, outPath: string) {
  const e = result.env;
  const tree = treeOf(result);
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `transcript-render bench  tree=${tree}  list=${listOf(result)}  sha=${String(e.gitSha).slice(0, 10)}  bun=${e.bun}  react=${e.react} (${e.reactBuild}, ${e.reactDom})  reps=${result.config.reps} steps=${result.config.steps} warmup=${result.config.warmup}`,
  );
  lines.push(`cpu=${e.cpu}`);
  lines.push('');
  lines.push(...tableLines(result));
  lines.push('');
  lines.push(
    'cols: mounted=[data-turn-id] elements in the DOM after mount / total turns (flat: every turn; virtual: the window at the end + overscan + pinned tail);',
  );
  lines.push(
    '      dom=DOM nodes after mount; ssr=renderToStaticMarkup first render (always the flat list); first=createRoot first commit (idle session); busy=all-turns sessionWorking flip;',
  );
  lines.push(
    `      casc=turn bodies (legacy SessionTurn / rows TurnFrame) that render with NO input in the ${result.config.mountQuiesceMs} ms after mount (the 2.5 s status-throttle cascade);`,
  );
  lines.push(
    '      pipe=host pipeline per frame, no React (groupMessagesIntoTurns+stabilizeTurns+planAnchorMessageId; rows tree adds deriveAnsweredQuestionIds+buildChatRows+turnsById+turnRenderKeys);',
  );
  lines.push('      b1=append one text part; b2=delta on trailing text;');
  lines.push(
    '      settled/work=row bodies rendered per b1 step in settled turns / in the working turn (min-max), of total mounted (legacy: SessionTurn bodies of T turns; rows: AssistantPartRow+UserMessageRow+TurnTailRow of R row components);',
  );
  lines.push(
    '      rows/step=TurnViewport wrappers rendered; UM/TM/AB/TPR=max UserMessage/ThrottledMarkdown/ActivityBurst/ToolPartRenderer bodies per b1 step;',
  );
  lines.push(
    '      APR/UMR/TTR/TF=max AssistantPartRow/UserMessageRow/TurnTailRow/TurnFrame bodies per b1 step (rows tree only; 0 on legacy)',
  );
  if (tree === 'rows') {
    lines.push(
      `      rows-only pipeline p50 (deriveAnsweredQuestionIds+buildChatRows): ${result.cells.map((c: any) => `${c.cell}=${fmt(c.rowsOnlyMs.p50)}`).join('  ')}`,
    );
    if (
      result.cells.some((c: any) => (c.b1_appendPart.rendersPerStepMax.UserMessageRow ?? 0) > 0)
    ) {
      lines.push(
        "      note: UMR>0 = the WORKING turn's bubble row re-renders per step: buildSessionMessages rewraps turn.userMessage every frame and stabilizeTurns keeps whole-turn identity only (not asserted; settled bubbles stay 0).",
      );
    }
  }
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
    lines.push(
      tree === 'legacy'
        ? 'invariants: OK (1 new turn object per step; 0 bodies rendered under settled turns; working-turn burst memo holds; settled <img> identity kept)'
        : `invariants: OK (1 new turn object per step, 1 new row object per appended part; 0 bodies rendered under settled turns${turnFrameMemoized ? ', TurnFrame included' : ''}; working-turn burst memo holds; settled <img> identity kept)`,
    );
  }
  lines.push('');
  lines.push(`json: ${outPath}`);
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

/** BEFORE (a previous json, any tree) vs AFTER (this run): the same columns, then a delta row per cell. */
function printCompare(before: any, after: any, beforePath: string) {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `BEFORE  tree=${treeOf(before)}  list=${listOf(before)}  sha=${String(before.env?.gitSha).slice(0, 10)}  (${beforePath})`,
  );
  lines.push(...tableLines(before));
  lines.push('');
  lines.push(
    `AFTER   tree=${treeOf(after)}  list=${listOf(after)}  sha=${String(after.env?.gitSha).slice(0, 10)}`,
  );
  lines.push(...tableLines(after));
  lines.push('');
  lines.push('DELTA (after - before; ms columns also as %)');
  const head = COLUMNS.map((col, i) =>
    i === 0 ? col.head.padEnd(col.width) : col.head.padStart(col.width),
  ).join(' ');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  const bt = treeOf(before);
  const at = treeOf(after);
  for (const ac of after.cells) {
    const bc = before.cells.find((c: any) => c.cell === ac.cell);
    if (!bc) continue;
    const cells = COLUMNS.map((col, i) => {
      if (i === 0) return ac.cell.padEnd(col.width);
      if (!col.num) {
        // settled/work: show "before → after" compactly
        return `${col.get(bc, bt)}→${col.get(ac, at)}`.padStart(col.width);
      }
      const b = col.num(bc, bt);
      const a = col.num(ac, at);
      const d = a - b;
      const isMs = col.head.includes('ms') || col.head.includes('p50') || col.head.includes('p95');
      if (isMs) {
        const pct = b === 0 ? (a === 0 ? 0 : Number.POSITIVE_INFINITY) : (d / b) * 100;
        return `${d >= 0 ? '+' : ''}${fmt(d)}${Number.isFinite(pct) ? `(${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}`.padStart(
          col.width,
        );
      }
      return `${d >= 0 ? '+' : ''}${d}`.padStart(col.width);
    });
    lines.push(cells.join(' '));
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

function rng(r: { min: number; max: number }): string {
  return r.min === r.max ? String(r.min) : `${r.min}-${r.max}`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

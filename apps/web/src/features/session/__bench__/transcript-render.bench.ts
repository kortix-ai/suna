#!/usr/bin/env bun
/**
 * Transcript render benchmark — ONE harness for BOTH transcript trees, so a
 * BEFORE json (legacy, turn-based) and an AFTER json (Stage 2, row-based)
 * compare cell for cell.
 *
 * Tree detection (`transcript-render.bench-main.tsx`, `detectTree`):
 *   - `legacy`: no `timeline/session-timeline-list.tsx`. Mounts the REAL
 *     `SessionTurn` list (session-chat.tsx, unmodified) — the `turns.map(...)`
 *     block of `SessionChat` with every host prop pinned.
 *   - `rows`: `timeline/session-timeline-list.tsx` exists. Runs the host
 *     pipeline (`stabilizeTurns` → `buildChatRows` with the previous rows →
 *     `turnsById` / `turnRenderKeys`) outside React and mounts the REAL
 *     `<SessionTimelineList>` with every host prop pinned, exactly like
 *     `timeline/__fixtures__/render-list.tsx`.
 *
 * Both under a happy-dom document with `react-dom/client` (or
 * `react-dom/profiling`), fed the same deterministic synthetic session
 * (`fixture.ts`), measuring:
 *
 *   1. first render ms        — `flushSync(root.render(...))` for the whole transcript
 *   2. append-one-part ms     — one `message.part.updated` frame (b1) and one
 *                               `message.part.delta` frame (b2), K steps each
 *   3. rendered components    — how many bodies ran on that append, split settled
 *                               turns vs the working turn (source-level counting
 *                               wrappers, see `installSourceProbes`):
 *                               shared leaves UserMessage / ActivityBurst /
 *                               ThrottledMarkdown / ToolPartRenderer / TurnViewport;
 *                               legacy SessionTurn; rows TurnFrame / UserMessageRow /
 *                               AssistantPartRow / TurnTailRow
 *   4. pipeline-only ms       — the host pipeline per frame, no React (legacy:
 *                               groupMessagesIntoTurns + stabilizeTurns + planAnchorMessageId;
 *                               rows: + deriveAnsweredQuestionIds + buildChatRows +
 *                               turnsById + turnRenderKeys; the rows half is also
 *                               reported alone as `rowsOnlyMs`)
 *   5. mount cascade          — bodies that render with NO input in the BENCH_MOUNT_QUIESCE_MS
 *                               after mount (every turn body, from the 2.5 s status
 *                               throttle timer armed by each turn's mount effect); the
 *                               streaming steps start only after this window so they
 *                               measure steady state
 *   6. DOM nodes              — `container.querySelectorAll('*').length` after mount
 *
 * Invariants (exit 1 when violated; checked on every step past warm-up, every rep):
 *   - exactly 1 new turn object per streaming step (stabilizeTurns)
 *   - rows tree: exactly 1 new row object per b1 step (the appended part) and 0 per
 *     b2 step (a delta grows the part a row already references; `reuseTimelineRows`)
 *   - 0 probed bodies render under any SETTLED turn (every probe except the
 *     by-design unmemoized wrappers TurnViewport and TurnFrame) — the memo
 *     boundary holds
 *   - the working turn renders: row bodies >= 1, ThrottledMarkdown >= 1; legacy also
 *     UserMessage >= 1 (the legacy card re-renders its bubble with the turn).
 *     (Legacy SessionTurn body runs 1-2×: the second pass is the `setLiveDuration`
 *     effect on `[working, turn]`, whose eager bail-out holds only every other
 *     update; its children do not re-render on that pass. A 1 s timer tick adds
 *     one real pass.)
 *   - the working turn's ActivityBurst and ToolPartRenderer bodies render 0× (the
 *     bash/read burst is untouched by both step shapes)
 *   - settled-turn <img> elements keep identity across a step
 *   - no React error (createRoot onUncaughtError/onCaughtError/onRecoverableError)
 *   NOT asserted (reported as UMR / UM): the rows tree's WORKING-turn bubble row
 *   re-renders per step, because `buildSessionMessages` rewraps `turn.userMessage`
 *   every frame and `stabilizeTurns` keeps whole-turn identity only.
 *
 * RUN (one command, from apps/web):
 *   bun run src/features/session/__bench__/transcript-render.bench.ts
 *   # or: pnpm bench:transcript
 *
 * FIXED INPUTS — see the header of ./fixture.ts. Cells:
 *   quick (default): N=20 M∈{0,2}
 *   full  (KORTIX_BENCH=1 or BENCH_PROFILE=full): N∈{20,200} × M∈{0,8,32} + N=200 M=8 on ONE turn
 *   N = messages (2 per turn), M = image file parts (512 KiB each, seeded).
 *
 * KNOBS (env):
 *   BENCH_PROFILE=quick|full   BENCH_CELLS="20:0,200:8,200:8@one" (overrides the profile)
 *   BENCH_COMPARE=<json>       print BEFORE (that json) / AFTER (this run) tables + a delta row per cell
 *   BENCH_REPS=5               repetitions per cell; Bun.gc(true) between reps
 *   BENCH_STEPS=50             streaming steps per variant; BENCH_WARMUP=5 discarded from timing
 *   BENCH_IMAGE_BYTES=524288   bytes per image payload before base64
 *   BENCH_MOUNT_QUIESCE_MS=3500 real-time wait after mount (must exceed the 2.5 s status throttle)
 *   BENCH_PROFILER=1           wrap each turn in <React.Profiler> and report actualDuration
 *   BENCH_REACT_BUILD=production|development   which React build runs (default production;
 *                              the script re-execs itself with NODE_ENV set accordingly)
 *   BENCH_OUT=<path>           JSON output path (default tests/test-results/local/bench-transcript-<ts>.json)
 *
 * OUTPUT: human table on stderr, JSON on stdout, JSON file under tests/test-results/local/.
 *
 * This file is NOT a `bun test` file on purpose: it registers a global DOM and
 * rewrites component sources through a Bun loader plugin, both process-wide.
 * The shared `bun test` process (optimistic-turn.test.tsx and ~200 other
 * renderToStaticMarkup tests) must never see either. The pure half of the bench
 * (`fixture.test.ts`) does run under `bun test`.
 */

const wantedBuild = process.env.BENCH_REACT_BUILD === 'development' ? 'development' : 'production';

if (process.env.NODE_ENV !== wantedBuild || process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== '0') {
  // Bun resolves `process.env.NODE_ENV` when it transpiles each module, so the
  // value must be in the environment before React is loaded. Re-exec once.
  // BUN_RUNTIME_TRANSPILER_CACHE_PATH=0: Bun caches transpiled output for
  // files > 50 KiB keyed without the JSX dev/prod mode. A cache entry written
  // by `bun test` (development) makes session-chat.tsx / user-message.tsx /
  // tool/shared/infrastructure.tsx import `jsxDEV`, which the production
  // `react/jsx-dev-runtime` exports as `undefined` → "jsxDEV_… is not a
  // function" mid-render. Observed with bun 1.3.14; the cache stays off here.
  const child = Bun.spawnSync({
    cmd: [process.execPath, 'run', import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, NODE_ENV: wantedBuild, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

// Same env defaults `bun test` gets from bunfig.toml preload (test-setup.ts):
// NEXT_PUBLIC_* URLs that app modules read at import time.
await import('../../../../test-setup');

const { main } = await import('./transcript-render.bench-main');
const code = await main();
process.exit(code);

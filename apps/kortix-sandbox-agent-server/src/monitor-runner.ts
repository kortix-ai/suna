/**
 * The monitor runner — the in-box half of Monitors
 * (docs/specs/2026-08-12-monitors.md).
 *
 * It supervises one process per enabled monitor, turns their STDOUT LINES into
 * events, and POSTs them to the project's ingest route. Three invariants shape
 * everything here:
 *
 *  1. **Stdout lines are events. Nothing else is.** Stderr is diagnostics: it
 *     goes to a ring buffer and a per-monitor log file, and can never fire a
 *     session.
 *  2. **A monitor can never fail silently.** A process exit, an exhausted
 *     restart budget, and a breached `expect_event_within` window each become a
 *     platform `lifecycle` event in the SAME stream, so the owner's agent hears
 *     about a dead monitor exactly the way it hears about a live one.
 *  3. **The runner polices itself only as a courtesy.** Every bound that
 *     matters (rate, dedup, retention, auto-disable) is re-enforced server-side
 *     — this is repo-adjacent code and the platform never trusts it.
 *
 * The manifest is NOT parsed here. apps/api parses `kortix.yaml` with the real
 * parser, applies the enabled/cap rules, and hands this process the resulting
 * list as `KORTIX_MONITORS` JSON. One parser, one source of truth: the daemon
 * has no YAML dependency and can never disagree with the platform about which
 * monitors exist or what `run` they name.
 *
 * The line/batch bounds below MIRROR apps/api/src/projects/lib/monitor-events.ts.
 * They are duplicated rather than shared because the daemon compiles to a
 * standalone binary with no workspace imports; the server is authoritative and
 * re-applies each one on ingest.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from './logger'

/** Longest serialized line the log stores; longer lines truncate with a marker. */
export const MONITOR_LINE_MAX_BYTES = 8 * 1024
/** Longest ingest batch one POST may carry. */
export const MONITOR_INGEST_MAX_EVENTS = 50
/** Batch window — how long a line waits for company before it is POSTed. */
export const MONITOR_BATCH_WINDOW_MS = 200
/** Queued lines held in memory before the oldest are dropped. */
export const MONITOR_QUEUE_MAX = 1_000
/** Restarts allowed inside {@link MONITOR_RESTART_WINDOW_MS} before the budget blows. */
export const MONITOR_RESTART_BUDGET = 5
export const MONITOR_RESTART_WINDOW_MS = 10 * 60_000
/** How long a budget-exhausted monitor waits before its next slow retry. */
export const MONITOR_BUDGET_BACKOFF_MS = 15 * 60_000
/** Backoff between ordinary (in-budget) restarts of a stream monitor. */
export const MONITOR_RESTART_DELAY_MS = 1_000
/** stderr lines kept in memory per monitor, for the log route/diagnostics. */
export const MONITOR_STDERR_RING = 200

export type MonitorMode = 'poll' | 'stream'
export type MonitorEventKind = 'event' | 'lifecycle'

/** One enabled monitor, exactly as apps/api resolved it from the manifest. */
export interface MonitorSpec {
  slug: string
  run: string
  mode: MonitorMode
  /** Poll period in whole seconds. Required for `mode: 'poll'`, else null. */
  intervalSeconds: number | null
  /** Silence watchdog in whole seconds, or null when the monitor declares none. */
  expectEventWithinSeconds: number | null
}

/** The wire shape of one event in an ingest batch. */
export interface MonitorWireEvent {
  slug: string
  seq: number
  kind: MonitorEventKind
  line: Record<string, unknown>
  emitted_at: string
}

export interface MonitorRunnerOptions {
  /** Kortix API base including `/v1`. */
  apiUrl: string
  projectId: string
  /** The box's sandbox token — the ONLY credential the ingest route accepts. */
  token: string
  /** This boot's epoch. The server rejects a batch stamped with any other. */
  boxEpoch: string
  monitors: readonly MonitorSpec[]
  /** Working directory for every monitor process (the repo checkout). */
  cwd: string
  /** Environment handed to every monitor process. */
  env?: Record<string, string | undefined>
  /** Directory for per-monitor stderr logs. */
  logDir?: string
  // ── Seams. Production uses the defaults; tests shrink the timers. ─────────
  fetchImpl?: typeof fetch
  now?: () => number
  batchWindowMs?: number
  queueMax?: number
  restartBudget?: number
  restartWindowMs?: number
  budgetBackoffMs?: number
  restartDelayMs?: number
  postAttempts?: number
  postRetryBaseMs?: number
  postTimeoutMs?: number
}

/**
 * Normalize one stdout line into the jsonb object the log stores. A line that
 * parses as a JSON OBJECT is stored as-is (so `filter` and templates can read
 * its fields); anything else — plain text, a bare number, an array — is wrapped
 * as `{ raw }`. Mirrors normalizeMonitorLine in apps/api.
 */
export function normalizeLine(line: string): Record<string, unknown> {
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON. Fall through to the raw wrapper — one odd line must never
      // cost the batch it arrived in.
    }
  }
  return { raw: line }
}

/**
 * Bound one line at {@link MONITOR_LINE_MAX_BYTES}, client-side. The head is
 * kept under `raw` with a `truncated: true` marker; the line is NEVER dropped.
 * Truncating here (rather than only server-side) keeps an 80 MB runaway line
 * out of the queue and off the wire. Mirrors truncateMonitorLine in apps/api.
 */
export function truncateLine(line: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(line)
  if (Buffer.byteLength(encoded, 'utf8') <= MONITOR_LINE_MAX_BYTES) return line
  // Reserve room for the `{"raw":…,"truncated":true}` envelope itself.
  const budget = MONITOR_LINE_MAX_BYTES - 64
  const source = typeof line.raw === 'string' ? line.raw : encoded
  return { raw: truncateToBytes(source, budget), truncated: true }
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let out = value.slice(0, maxBytes)
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(
      0,
      Math.max(0, out.length - Math.ceil((Buffer.byteLength(out, 'utf8') - maxBytes) / 2)),
    )
  }
  return out
}

interface MonitorState {
  spec: MonitorSpec
  seq: number
  child: ChildProcess | null
  /** Poll only: a tick is skipped while the previous run is still going. */
  running: boolean
  stdoutCarry: string
  stderrRing: string[]
  logPath: string
  restartTimes: number[]
  /** Set while the monitor is parked in its post-budget slow-retry window. */
  budgetExhausted: boolean
  timers: Set<ReturnType<typeof setTimeout>>
  interval: ReturnType<typeof setInterval> | null
  silenceTimer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

/** Every option resolved to a concrete value — no optionals past the ctor. */
interface ResolvedRunnerOptions {
  apiUrl: string
  projectId: string
  token: string
  boxEpoch: string
  cwd: string
  env: Record<string, string | undefined>
  logDir: string
  fetchImpl: typeof fetch
  now: () => number
  batchWindowMs: number
  queueMax: number
  restartBudget: number
  restartWindowMs: number
  budgetBackoffMs: number
  restartDelayMs: number
  postAttempts: number
  postRetryBaseMs: number
  postTimeoutMs: number
}

export interface MonitorRunnerStats {
  queued: number
  dropped: number
  posted: number
  failedBatches: number
  bySlug: Record<string, { seq: number; restarts: number; budgetExhausted: boolean }>
}

/**
 * Supervises every monitor in one box and ships their lines to apps/api.
 *
 * One instance per box. `start()` is synchronous (spawning is fire-and-forget);
 * `stop()` tears every process, timer, and the flush loop down.
 */
export class MonitorRunner {
  private readonly opts: ResolvedRunnerOptions
  private readonly states = new Map<string, MonitorState>()
  private queue: MonitorWireEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private stopped = false
  private dropped = 0
  private posted = 0
  private failedBatches = 0
  /** Set once the server says our epoch is superseded — nothing we send can
   *  ever be accepted again, so stop burning retries on it. */
  private staleEpoch = false

  constructor(options: MonitorRunnerOptions) {
    this.opts = {
      apiUrl: options.apiUrl,
      projectId: options.projectId,
      token: options.token,
      boxEpoch: options.boxEpoch,
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string | undefined>),
      logDir: options.logDir ?? '/var/log',
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? (() => Date.now()),
      batchWindowMs: options.batchWindowMs ?? MONITOR_BATCH_WINDOW_MS,
      queueMax: options.queueMax ?? MONITOR_QUEUE_MAX,
      restartBudget: options.restartBudget ?? MONITOR_RESTART_BUDGET,
      restartWindowMs: options.restartWindowMs ?? MONITOR_RESTART_WINDOW_MS,
      budgetBackoffMs: options.budgetBackoffMs ?? MONITOR_BUDGET_BACKOFF_MS,
      restartDelayMs: options.restartDelayMs ?? MONITOR_RESTART_DELAY_MS,
      postAttempts: options.postAttempts ?? 4,
      postRetryBaseMs: options.postRetryBaseMs ?? 1_000,
      postTimeoutMs: options.postTimeoutMs ?? 15_000,
    }
    try {
      mkdirSync(this.opts.logDir, { recursive: true })
    } catch {
      // A read-only /var/log must not stop monitoring; stderr still rings.
    }
    for (const spec of options.monitors) {
      this.states.set(spec.slug, {
        spec,
        seq: 0,
        child: null,
        running: false,
        stdoutCarry: '',
        stderrRing: [],
        logPath: `${this.opts.logDir}/kortix-monitor-${spec.slug}.log`,
        restartTimes: [],
        budgetExhausted: false,
        timers: new Set(),
        interval: null,
        silenceTimer: null,
        stopped: false,
      })
    }
  }

  start(): void {
    this.flushTimer = setInterval(() => void this.flush(), this.opts.batchWindowMs)
    for (const state of this.states.values()) {
      this.armSilenceWatchdog(state)
      if (state.spec.mode === 'stream') {
        this.spawnStream(state)
      } else {
        const periodMs = Math.max(1, state.spec.intervalSeconds ?? 0) * 1000
        // Poll on the declared period, and take the FIRST sample immediately —
        // a 24 h poll that only reported tomorrow would look identical to a
        // broken one for a whole day.
        this.runPoll(state)
        state.interval = setInterval(() => this.runPoll(state), periodMs)
      }
    }
    logger.info('[monitor] runner started', {
      monitors: [...this.states.keys()],
      boxEpoch: this.opts.boxEpoch,
    })
  }

  /** Tear down every process, timer, and the flush loop, then drain the queue. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    for (const state of this.states.values()) {
      state.stopped = true
      if (state.interval) clearInterval(state.interval)
      if (state.silenceTimer) clearTimeout(state.silenceTimer)
      for (const timer of state.timers) clearTimeout(timer)
      state.timers.clear()
      state.child?.kill('SIGTERM')
      state.child = null
    }
    await this.flush()
  }

  stats(): MonitorRunnerStats {
    const bySlug: MonitorRunnerStats['bySlug'] = {}
    for (const [slug, state] of this.states) {
      bySlug[slug] = {
        seq: state.seq,
        restarts: state.restartTimes.length,
        budgetExhausted: state.budgetExhausted,
      }
    }
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      posted: this.posted,
      failedBatches: this.failedBatches,
      bySlug,
    }
  }

  /** Recent stderr for one monitor — diagnostics only, never events. */
  stderrTail(slug: string): string[] {
    return [...(this.states.get(slug)?.stderrRing ?? [])]
  }

  // ── Process supervision ───────────────────────────────────────────────────

  private spawnStream(state: MonitorState): void {
    if (state.stopped) return
    const child = this.spawnMonitorProcess(state)
    if (!child) return
    state.child = child
    child.once('exit', (code, signal) => {
      state.child = null
      if (state.stopped) return
      this.emitLifecycle(state, 'exited', {
        code: code ?? null,
        signal: signal ?? null,
        detail: `the stream process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
      })
      this.scheduleRestart(state)
    })
  }

  /**
   * Restart accounting. Five restarts inside the window blow the budget: the
   * platform is told once (`restart_budget_exhausted`) and the monitor drops to
   * slow retries instead of hot-looping a broken command forever.
   */
  private scheduleRestart(state: MonitorState): void {
    const now = this.opts.now()
    state.restartTimes = state.restartTimes.filter(
      (at) => now - at < this.opts.restartWindowMs,
    )
    state.restartTimes.push(now)
    if (state.restartTimes.length >= this.opts.restartBudget) {
      if (!state.budgetExhausted) {
        state.budgetExhausted = true
        this.emitLifecycle(state, 'restart_budget_exhausted', {
          restarts: state.restartTimes.length,
          window_seconds: Math.round(this.opts.restartWindowMs / 1000),
          detail: `${state.restartTimes.length} restarts inside ${Math.round(this.opts.restartWindowMs / 60_000)} minutes; retrying every ${Math.round(this.opts.budgetBackoffMs / 60_000)} minutes from now`,
        })
      }
      // Clear the window so the next slow retry starts a fresh budget rather
      // than re-tripping instantly on the stale timestamps.
      state.restartTimes = []
      this.later(state, this.opts.budgetBackoffMs, () => {
        state.budgetExhausted = false
        this.spawnStream(state)
      })
      return
    }
    this.later(state, this.opts.restartDelayMs, () => this.spawnStream(state))
  }

  private runPoll(state: MonitorState): void {
    if (state.stopped) return
    // No overlap: a poll that outruns its own interval must not stack. Skipping
    // is the honest behaviour — a slower-than-interval sample is a fact about
    // the source, not something to hide by running two at once.
    if (state.running) {
      logger.warn('[monitor] poll tick skipped; previous run still active', { slug: state.spec.slug })
      return
    }
    const child = this.spawnMonitorProcess(state)
    if (!child) return
    state.running = true
    state.child = child
    child.once('exit', (code, signal) => {
      state.running = false
      state.child = null
      if (state.stopped) return
      // A poll that exits non-zero produced no reading. That is a failure the
      // owner must hear about — the whole point of the lifecycle stream.
      if (code !== 0) {
        this.emitLifecycle(state, 'exited', {
          code: code ?? null,
          signal: signal ?? null,
          detail: `the poll command exited non-zero (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
        })
      }
    })
  }

  private spawnMonitorProcess(state: MonitorState): ChildProcess | null {
    try {
      const child = spawn('/bin/bash', ['-lc', state.spec.run], {
        cwd: this.opts.cwd,
        env: this.opts.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.onStdout(state, chunk))
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => this.onStderr(state, chunk))
      child.on('error', (err) => {
        this.onStderr(state, `[kortix] spawn failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
      return child
    } catch (err) {
      logger.error('[monitor] spawn threw', { slug: state.spec.slug, err: String(err) })
      this.onStderr(state, `[kortix] spawn threw: ${String(err)}\n`)
      return null
    }
  }

  // ── Stream capture ────────────────────────────────────────────────────────

  private onStdout(state: MonitorState, chunk: string): void {
    const combined = state.stdoutCarry + chunk
    const parts = combined.split('\n')
    // The trailing fragment is an incomplete line — hold it for the next chunk.
    state.stdoutCarry = parts.pop() ?? ''
    // A pathological producer that never emits a newline would grow the carry
    // without bound. Cut it at the line bound and flush it as its own event.
    if (Buffer.byteLength(state.stdoutCarry, 'utf8') > MONITOR_LINE_MAX_BYTES) {
      parts.push(state.stdoutCarry)
      state.stdoutCarry = ''
    }
    for (const line of parts) {
      if (line.trim() === '') continue
      this.enqueue(state, 'event', truncateLine(normalizeLine(line)))
    }
  }

  private onStderr(state: MonitorState, chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line === '') continue
      state.stderrRing.push(line)
      if (state.stderrRing.length > MONITOR_STDERR_RING) state.stderrRing.shift()
    }
    try {
      appendFileSync(state.logPath, chunk)
    } catch {
      // Log file unavailable (read-only mount, full disk). The ring buffer is
      // the fallback; never let diagnostics take the monitor down.
    }
  }

  // ── The event queue ───────────────────────────────────────────────────────

  private emitLifecycle(
    state: MonitorState,
    event: 'exited' | 'restart_budget_exhausted' | 'silent' | 'suppressed',
    extra: Record<string, unknown> = {},
  ): void {
    const stderrTail = state.stderrRing.slice(-5)
    this.enqueue(state, 'lifecycle', {
      event,
      monitor: state.spec.slug,
      run: state.spec.run,
      ...extra,
      ...(stderrTail.length > 0 ? { stderr_tail: stderrTail } : {}),
    })
  }

  private enqueue(state: MonitorState, kind: MonitorEventKind, line: Record<string, unknown>): void {
    const wire: MonitorWireEvent = {
      slug: state.spec.slug,
      seq: state.seq++,
      kind,
      line: truncateLine(line),
      emitted_at: new Date(this.opts.now()).toISOString(),
    }
    this.queue.push(wire)
    // Bounded queue, drop-OLDEST. A monitor that outruns delivery is reporting
    // a live situation; the newest lines describe it, the oldest do not. The
    // drop is itself announced, so nothing is lost silently.
    if (this.queue.length > this.opts.queueMax) {
      const overflow = this.queue.length - this.opts.queueMax
      this.queue.splice(0, overflow)
      this.dropped += overflow
      this.announceDrop(state, overflow)
    }
    // An observed EVENT proves the source is alive; a lifecycle event does not.
    if (kind === 'event') this.armSilenceWatchdog(state)
  }

  /**
   * Announce a queue overflow ONCE per burst. The note itself is enqueued (as a
   * `suppressed` lifecycle event) but must never recurse into another overflow,
   * so it is pushed directly and the reserve slot the splice just freed holds it.
   */
  private announceDrop(state: MonitorState, dropped: number): void {
    const last = this.queue[this.queue.length - 1]
    if (last && last.kind === 'lifecycle' && last.line.event === 'suppressed') {
      last.line.dropped = Number(last.line.dropped ?? 0) + dropped
      return
    }
    this.queue.push({
      slug: state.spec.slug,
      seq: state.seq++,
      kind: 'lifecycle',
      line: {
        event: 'suppressed',
        monitor: state.spec.slug,
        dropped,
        detail: `the in-box delivery queue overflowed at ${this.opts.queueMax} lines; the oldest ${dropped} line(s) were dropped before they could be sent`,
      },
      emitted_at: new Date(this.opts.now()).toISOString(),
    })
  }

  // ── The silence watchdog ──────────────────────────────────────────────────

  private armSilenceWatchdog(state: MonitorState): void {
    const seconds = state.spec.expectEventWithinSeconds
    if (!seconds || state.stopped) return
    if (state.silenceTimer) clearTimeout(state.silenceTimer)
    state.silenceTimer = setTimeout(() => {
      if (state.stopped) return
      this.emitLifecycle(state, 'silent', {
        expected_within_seconds: seconds,
        detail: `no event in ${seconds}s, the monitor's declared expect_event_within window`,
      })
      // Re-arm: a monitor that stays silent keeps saying so, once per window,
      // rather than reporting its own death exactly once and then going quiet.
      this.armSilenceWatchdog(state)
    }, seconds * 1000)
    state.silenceTimer.unref?.()
  }

  private later(state: MonitorState, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      state.timers.delete(timer)
      fn()
    }, ms)
    timer.unref?.()
    state.timers.add(timer)
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * Ship one batch. Deliberately serial: a single in-flight POST preserves the
   * order the lines were produced in and bounds outbound concurrency to 1 no
   * matter how many monitors are talking at once.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || this.staleEpoch) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, MONITOR_INGEST_MAX_EVENTS)
        const delivered = await this.post(batch)
        // Delivered or definitively rejected, the batch leaves the queue: it
        // cannot be retried into acceptance, and holding it would block every
        // line behind it forever.
        this.queue.splice(0, batch.length)
        if (delivered) this.posted += batch.length
        else this.failedBatches += 1
        if (this.staleEpoch) return
      }
    } finally {
      this.flushing = false
    }
  }

  private async post(events: MonitorWireEvent[]): Promise<boolean> {
    const url = `${this.opts.apiUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(this.opts.projectId)}/monitors/ingest`
    const body = JSON.stringify({ box_epoch: this.opts.boxEpoch, events })
    const attempts = this.opts.postAttempts
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.opts.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.opts.token}`,
          },
          body,
          signal: AbortSignal.timeout(this.opts.postTimeoutMs),
        })
        if (res.ok) return true
        // 409 = this boot was superseded. Nothing this process sends will ever
        // be accepted again, so stop retrying and stop flushing entirely.
        if (res.status === 409) {
          this.staleEpoch = true
          logger.error('[monitor] ingest rejected a stale box_epoch; delivery halted', {
            boxEpoch: this.opts.boxEpoch,
          })
          return false
        }
        // Any other non-ok is a definitive answer from apps/api (a 400 is our
        // own bug, a 403 means the box lost its authorization). Retrying a
        // definitive rejection just burns the batch window.
        if (res.status < 500) {
          logger.error('[monitor] ingest rejected the batch', { status: res.status, count: events.length })
          return false
        }
        logger.warn('[monitor] ingest non-ok', { status: res.status, attempt })
      } catch (err) {
        logger.warn('[monitor] ingest POST failed', { err: (err as Error).message, attempt })
      }
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, this.opts.postRetryBaseMs * attempt))
      }
    }
    logger.error('[monitor] ingest gave up after retries; dropping batch', { count: events.length })
    return false
  }
}

/**
 * Parse the `KORTIX_MONITORS` env payload apps/api injects at box creation.
 *
 * Returns [] for anything malformed rather than throwing: a bad payload must
 * leave a running box with a healthy daemon (and a loud log) instead of a crash
 * loop the reconciler would keep re-creating.
 */
export function parseMonitorSpecs(raw: string | undefined): MonitorSpec[] {
  if (!raw || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error('[monitor] KORTIX_MONITORS is not valid JSON', { err: String(err) })
    return []
  }
  if (!Array.isArray(parsed)) {
    logger.error('[monitor] KORTIX_MONITORS is not an array')
    return []
  }
  const specs: MonitorSpec[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const slug = typeof row.slug === 'string' ? row.slug.trim() : ''
    const run = typeof row.run === 'string' ? row.run.trim() : ''
    const mode = row.mode === 'poll' ? 'poll' : row.mode === 'stream' ? 'stream' : null
    if (!slug || !run || !mode) {
      logger.error('[monitor] skipping a malformed monitor entry', { slug: slug || '(unset)' })
      continue
    }
    const intervalSeconds =
      typeof row.interval_seconds === 'number' && Number.isFinite(row.interval_seconds)
        ? Math.max(1, Math.floor(row.interval_seconds))
        : null
    if (mode === 'poll' && intervalSeconds === null) {
      logger.error('[monitor] skipping a poll monitor with no interval', { slug })
      continue
    }
    const expectEventWithinSeconds =
      typeof row.expect_event_within_seconds === 'number' &&
      Number.isFinite(row.expect_event_within_seconds)
        ? Math.max(1, Math.floor(row.expect_event_within_seconds))
        : null
    specs.push({ slug, run, mode, intervalSeconds, expectEventWithinSeconds })
  }
  return specs
}

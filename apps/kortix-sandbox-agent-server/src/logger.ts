/**
 * Structured logger: JSON lines to stdout/stderr AND, when enabled, to a file
 * on the box.
 *
 * WHY THE FILE. Under E2B the daemon's stdout goes to envd and is not on disk;
 * under Daytona/Platinum it goes to the container runtime and is gone with
 * the container. On 2026-08-25 an Essentia box sat two hours with the daemon
 * reporting `starting` on port 4096 while its own OpenCode served on 4097.
 * The daemon log lines that name that transition (`[opencode] candidate
 * promoted`, `[opencode] reconfigured`) existed only on a stream nobody kept,
 * so the cause could be fenced but not proven. With the sink on, every line
 * also lands in `KORTIX_DAEMON_LOG_FILE` (default `/opt/kortix/logs/daemon.log`),
 * readable through `GET /kortix/logs` and the file API, and it survives daemon
 * restarts and agent swaps (append).
 *
 * THE SINK MUST NEVER HURT THE BOX. The daemon fronts every byte of the
 * session, so a logger that blocks, grows, or throws is worse than no log:
 *   - opt-in: `enableDaemonLogFile()` is called by `main()` only. Importing the
 *     logger (tests, tooling) never touches the disk;
 *   - never blocks: lines go to an in-memory buffer; one async `appendFile`
 *     is in flight at a time, on a 250 ms timer or when the buffer passes
 *     64 KiB. stdout/stderr writes are unchanged;
 *   - bounded memory: the buffer holds at most 1 MiB. If the disk cannot keep
 *     up, the OLDEST lines are dropped and counted; the next flush records
 *     `[logger] dropped N lines` so the gap is visible in the file;
 *   - bounded lines: a single line is cut at 64 KiB (`…[truncated]`) before
 *     it enters the buffer, so one oversized ctx cannot balloon the file;
 *   - bounded disk: past `KORTIX_DAEMON_LOG_MAX_BYTES` (default 32 MiB) the
 *     file is renamed to `<file>.1`, replacing the previous one — two
 *     generations, ~64 MiB worst case;
 *   - never throws, never recurses: every filesystem call is inside try/catch;
 *     the first I/O error (EACCES, ENOSPC, EROFS, …) disables the sink for
 *     the rest of the process and writes ONE plain line to stderr — not
 *     through the logger;
 *   - best-effort final flush on `process.exit`, synchronous and bounded by
 *     the buffer cap.
 *
 * `KORTIX_DAEMON_LOG_FILE=off` keeps the sink off even when enabled.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

export const DEFAULT_DAEMON_LOG_FILE = '/opt/kortix/logs/daemon.log'
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024
/** Memory the sink may hold while the disk catches up. */
export const DAEMON_LOG_BUFFER_CAP_BYTES = 1024 * 1024
/** Flush as soon as this much is pending, otherwise on the timer. */
const FLUSH_THRESHOLD_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 250
/** One line is never larger than this in the file. */
export const DAEMON_LOG_MAX_LINE_BYTES = 64 * 1024
const TRUNCATION_MARK = '…[truncated]"}\n'

/** The file the daemon appends its log to, or null when the sink is off. */
export function daemonLogFilePath(): string | null {
  const raw = process.env.KORTIX_DAEMON_LOG_FILE
  if (raw === undefined) return DEFAULT_DAEMON_LOG_FILE
  const value = raw.trim()
  if (value === '' || value.toLowerCase() === 'off' || value === '0') return null
  return value
}

function maxFileBytes(): number {
  const n = Number(process.env.KORTIX_DAEMON_LOG_MAX_BYTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES
}

interface SinkState {
  enabled: boolean
  disabled: boolean
  path: string | null
  dirReady: boolean
  pending: string[]
  pendingBytes: number
  dropped: number
  flushing: boolean
  timer: ReturnType<typeof setTimeout> | null
  bytesSinceStat: number
  exitHookInstalled: boolean
  /** Bumped on every enable/reset: a flush from an older generation may not
   *  disable or write into the sink that replaced it. */
  generation: number
}

const sink: SinkState = {
  enabled: false,
  disabled: false,
  path: null,
  dirReady: false,
  pending: [],
  pendingBytes: 0,
  dropped: 0,
  flushing: false,
  timer: null,
  bytesSinceStat: 0,
  exitHookInstalled: false,
  generation: 0,
}

function stderrLine(msg: string, extra: Record<string, unknown>): void {
  try {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...extra }) + '\n')
  } catch {
    // stderr itself failing is not this module's problem to solve
  }
}

function disableSink(reason: string, err: unknown, generation = sink.generation): void {
  if (sink.disabled || generation !== sink.generation) return
  sink.disabled = true
  sink.pending = []
  sink.pendingBytes = 0
  if (sink.timer) {
    clearTimeout(sink.timer)
    sink.timer = null
  }
  stderrLine('[logger] file sink disabled', {
    path: sink.path,
    reason,
    err: err instanceof Error ? err.message : String(err),
  })
}

/**
 * Turn the file sink on for this process. Idempotent. Called by `main()`;
 * tests call it against a tmp path via `KORTIX_DAEMON_LOG_FILE`.
 */
export function enableDaemonLogFile(): { path: string | null } {
  sink.generation++
  sink.path = daemonLogFilePath()
  sink.disabled = false
  sink.dirReady = false
  sink.enabled = sink.path !== null
  if (sink.enabled && !sink.exitHookInstalled) {
    sink.exitHookInstalled = true
    process.on('exit', flushSyncOnExit)
  }
  return { path: sink.path }
}

function truncateLine(text: string): string {
  if (text.length <= DAEMON_LOG_MAX_LINE_BYTES) return text
  return text.slice(0, DAEMON_LOG_MAX_LINE_BYTES - TRUNCATION_MARK.length) + TRUNCATION_MARK
}

function enqueue(text: string): void {
  if (!sink.enabled || sink.disabled) return
  const line = truncateLine(text)
  sink.pending.push(line)
  sink.pendingBytes += line.length
  // Bounded memory: drop the OLDEST lines until under the cap. The count is
  // written into the file at the next flush so the gap is visible.
  while (sink.pendingBytes > DAEMON_LOG_BUFFER_CAP_BYTES && sink.pending.length > 1) {
    const dropped = sink.pending.shift() as string
    sink.pendingBytes -= dropped.length
    sink.dropped++
  }
  if (sink.pendingBytes >= FLUSH_THRESHOLD_BYTES) {
    void flush()
  } else if (!sink.timer) {
    sink.timer = setTimeout(() => {
      sink.timer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
    // Never keep the process alive for a log flush.
    sink.timer.unref?.()
  }
}

function takePending(): string {
  let chunk = ''
  if (sink.dropped > 0) {
    chunk +=
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'warn',
        msg: `[logger] dropped ${sink.dropped} lines: file sink could not keep up`,
      }) + '\n'
    sink.dropped = 0
  }
  chunk += sink.pending.join('')
  sink.pending = []
  sink.pendingBytes = 0
  return chunk
}

// Rotation happens BEFORE a write, so the live file always exists after a
// flush and a reader never sees the gap between rename and next append.
async function rotateIfNeeded(path: string): Promise<void> {
  if (sink.bytesSinceStat < FLUSH_THRESHOLD_BYTES) return
  sink.bytesSinceStat = 0
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return
  }
  if (size >= maxFileBytes()) await rename(path, `${path}.1`)
}

async function flush(): Promise<void> {
  if (sink.flushing || sink.disabled || !sink.enabled || !sink.path) return
  if (sink.pending.length === 0 && sink.dropped === 0) return
  sink.flushing = true
  const path = sink.path
  const generation = sink.generation
  try {
    if (!sink.dirReady) {
      await mkdir(dirname(path), { recursive: true })
      if (generation !== sink.generation) return
      sink.dirReady = true
    }
    // Loop: lines enqueued while a write is in flight go out in the next
    // pass, still with a single write in flight at any time.
    while (!sink.disabled && generation === sink.generation && (sink.pending.length > 0 || sink.dropped > 0)) {
      await rotateIfNeeded(path)
      if (generation !== sink.generation) return
      const chunk = takePending()
      await appendFile(path, chunk, { mode: 0o644 })
      sink.bytesSinceStat += chunk.length
    }
  } catch (err) {
    disableSink('write failed', err, generation)
  } finally {
    if (generation === sink.generation) sink.flushing = false
  }
}

function flushSyncOnExit(): void {
  if (!sink.enabled || sink.disabled || !sink.path || !sink.dirReady) return
  if (sink.pending.length === 0 && sink.dropped === 0) return
  try {
    appendFileSync(sink.path, takePending(), { mode: 0o644 })
  } catch {
    // exiting anyway
  }
}

/** Tests: drain the buffer to disk. */
export async function __flushDaemonLogFileForTests(): Promise<void> {
  if (sink.timer) {
    clearTimeout(sink.timer)
    sink.timer = null
  }
  // A threshold-triggered flush may already be in flight; wait for it, then
  // drain whatever arrived meanwhile.
  for (let i = 0; i < 1_000 && sink.flushing; i++) await new Promise((r) => setTimeout(r, 2))
  await flush()
  for (let i = 0; i < 1_000 && (sink.flushing || sink.pending.length > 0) && !sink.disabled; i++) {
    await new Promise((r) => setTimeout(r, 2))
    await flush()
  }
}

/** Tests: forget everything and re-read KORTIX_DAEMON_LOG_FILE on the next enable. */
export function __resetLoggerFileSinkForTests(): void {
  if (sink.timer) clearTimeout(sink.timer)
  sink.generation++
  sink.enabled = false
  sink.disabled = false
  sink.path = null
  sink.dirReady = false
  sink.pending = []
  sink.pendingBytes = 0
  sink.dropped = 0
  sink.flushing = false
  sink.timer = null
  sink.bytesSinceStat = 0
}

/** Tests: the sink's current bookkeeping. */
export function __daemonLogSinkStateForTests(): { pendingBytes: number; dropped: number; disabled: boolean } {
  return { pendingBytes: sink.pendingBytes, dropped: sink.dropped, disabled: sink.disabled }
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown> | unknown) {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  }
  if (ctx !== undefined) {
    if (ctx instanceof Error) {
      line.error = { name: ctx.name, message: ctx.message, stack: ctx.stack }
    } else if (typeof ctx === 'object' && ctx !== null) {
      Object.assign(line, ctx)
    } else {
      line.ctx = ctx
    }
  }
  let text: string
  try {
    text = JSON.stringify(line) + '\n'
  } catch {
    // A ctx with a cycle or a throwing getter must not take the log line down.
    text = JSON.stringify({ t: line.t, level, msg, ctx: '[unserializable]' }) + '\n'
  }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  out.write(text)
  try {
    enqueue(text)
  } catch (err) {
    disableSink('enqueue failed', err)
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('error', msg, ctx),
}

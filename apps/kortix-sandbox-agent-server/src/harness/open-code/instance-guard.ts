import { logger } from '../../logger'

// ─────────────────────────────────────────────────────────────────────────────
// ONE STOP MUST NOT BREAK EVERY LATER TURN.
//
// OpenCode keeps each per-directory service (tool registry, plugins, agents,
// skills, providers, MCP, …) in an `InstanceState`, a `ScopedCache` built on
// first use (`packages/opencode/src/effect/instance-state.ts`). Effect's
// `ScopedCache.get` runs that build IN THE CALLER'S FIBER and caches its exit
// with an infinite TTL — including an interrupted exit. Verified against
// effect 4.0.0-beta.83 (the pin of opencode 1.18.23 … 1.18.32 and upstream
// `dev` on 2026-09-25) and 4.0.0-rc.117: interrupt the first `get`, and every
// later `get` for the key returns `Interrupt` without running the build again.
//
// The first prompt of a fresh instance is usually that first caller. A Stop
// while it is still building the tool registry interrupts the build, and the
// instance keeps the interrupt: every later turn — every session on the box —
// dies ~30 ms after it starts with `MessageAbortedError`, zero parts and no
// cancel. Prod, 2026-09-25: one Stop on turn 1, then four turns aborted in
// 15–66 ms. Reproduced with the real 1.18.23 binary and one project custom
// tool whose import takes 1.5 s; a project without custom tools does not
// reproduce, because its registry builds in milliseconds. Kortix projects
// ship custom tools in `.kortix/opencode/tools/`, and the registry waits for
// the config dir's dependencies before it imports them, so the window here is
// ~1 s on every fresh instance.
//
// Three defenses, each verified against the real binary:
//
//   1. WARM. The daemon builds the prompt-path caches itself, with plain GETs
//      nobody cancels, as soon as an instance exists (boot, reconnect, every
//      dispose). A prompt that arrives while they build JOINS the daemon's
//      build; a Stop then interrupts only the prompt's wait, never the build.
//      Loop-starting requests wait for the warm-up (bounded) so a prompt can
//      never be the first caller.
//   2. HEAL. After any aborted turn the daemon probes the same endpoints. A
//      poisoned cache answers 503 in ~1 ms; two 503s in a row → `POST
//      /instance/dispose` (drops every cached exit) and warm again.
//   3. RECOVER. A root turn that aborted with no output while nobody asked
//      for a stop is a victim, not a stop: heal (dispose even when the probe
//      is clean — the poisoned cache may be one no endpoint reaches) and
//      re-prompt it once through `turn-auto-resume`.
//
// The root fix belongs upstream (cache no interrupt-only exit in
// `InstanceState.make`); these defenses stay useful after it lands, because a
// warm first turn is also a faster first turn.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GETs whose handlers build the caches a prompt resolves before its first
 * model call. `/experimental/tool/ids` is the one that matters most: it builds
 * the tool registry, which builds plugins and waits for config dependencies.
 */
export const WARM_PATHS = [
  '/experimental/tool/ids',
  '/agent',
  '/skill',
  '/config/providers',
  '/mcp',
] as const

/** How long a loop-starting request waits for an in-flight warm-up. */
export const WARM_GATE_MAX_MS = 20_000
/** A warm GET that has not answered by then is abandoned. A disconnect does
 *  not interrupt OpenCode's handler (verified), so abandoning it is safe. */
const WARM_REQUEST_TIMEOUT_MS = 120_000
const PROBE_REQUEST_TIMEOUT_MS = 10_000
/** A poisoned cache answers every request the same way; a second probe after
 *  this gap separates it from a transient 503. */
const PROBE_CONFIRM_GAP_MS = 300
const DISPOSE_TIMEOUT_MS = 15_000
/** Warm-up preconditions are re-checked on this cadence until they hold. */
const WARM_RETRY_MS = 1_000
const WARM_RETRY_LIMIT = 120
/** How often a held prompt checks whether its session was stopped. */
const STOP_POLL_MS = 25

// ── Stop requests ────────────────────────────────────────────────────────────
//
// A requested stop and an abort nobody asked for reach the transcript as the
// same `MessageAbortedError`. Every daemon path that asks OpenCode to abort a
// session records it here first, on the daemon clock — the same clock OpenCode
// stamps `time.created` with, because both run in this box.

const stopRequestedAt = new Map<string, number>()

/** Record that a caller asked OpenCode to abort this session's turn. */
export function noteOpencodeStopRequested(opencodeSessionId: string, source: string, now = Date.now()): void {
  if (!opencodeSessionId) return
  stopRequestedAt.set(opencodeSessionId, now)
  logger.info('[instance-guard] stop requested', { opencodeSessionId, source })
}

/** Was a stop requested for this session at or after `sinceMs`? */
export function opencodeStopRequestedSince(opencodeSessionId: string, sinceMs: number): boolean {
  const at = stopRequestedAt.get(opencodeSessionId)
  return at !== undefined && at >= sinceMs
}

/** `POST /session/:id/abort` → the session id, else null. */
export function abortTargetOf(method: string, path: string): string | null {
  if (method.toUpperCase() !== 'POST') return null
  const match = /^\/session\/([^/?#]+)\/abort(?:$|[/?#])/.exec(path)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/** The session a loop-starting request (prompt, command, shell) runs in, else null. */
export function loopStartTargetOf(method: string, path: string): string | null {
  if (method.toUpperCase() !== 'POST') return null
  const match = /^\/session\/([^/?#]+)\/(?:prompt_async|message|command|shell)(?:$|[/?#])/.exec(path)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export function resetStopRequestsForTests(): void {
  stopRequestedAt.clear()
}

// ── Guard ────────────────────────────────────────────────────────────────────

export interface InstanceGuardDeps {
  getInternalUrl: () => string
  workspace: () => string
  /**
   * May a directory-scoped request reach OpenCode now? False before the
   * workspace is complete: an instance built against a partial workspace
   * caches failed tool imports (dev, 2026-08-27), so warming early would
   * cause the bug the readiness gate exists to stop.
   */
  canWarm?: () => boolean
  /**
   * Re-prompt a root turn that aborted before it reached the model while
   * nobody asked for a stop. Resolves true when the session continues (the
   * caller must then not relay the abort as the turn's end).
   */
  resumeVictim?: (opencodeSessionId: string, view: EndedTurnView) => Promise<boolean>
  /** Root sessions only are re-prompted: a child belongs to its parent's turn. */
  isRoot?: (opencodeSessionId: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

export interface WarmResult {
  ok: boolean
  /** Per path: HTTP status, or the error name when the request failed. */
  statuses: Record<string, number | string>
  ms: number
}

export interface HealResult {
  poisoned: boolean
  disposed: boolean
  /** Paths that answered 503 twice. */
  poisonedPaths: string[]
}

/** What the transcript says about a turn that just ended. */
export interface EndedTurnView {
  assistantMessageId: string
  /** `time.created` of the user message the assistant answered (or its own). */
  turnStartedAtMs: number
  errorName: string | null
  /** The assistant produced no part at all: it never reached the model. */
  empty: boolean
}

export type AbortedTurnVerdict =
  /** Not an abort, or already handled. Relay as usual. */
  | { kind: 'none' }
  /** Somebody asked for this stop. Relay as usual. */
  | { kind: 'requested'; heal: HealResult }
  /**
   * An abort nobody asked for. `resumed` true: the turn was re-prompted and
   * continues, so the caller must not relay this abort as the turn's end.
   */
  | { kind: 'unrequested'; heal: HealResult; view: EndedTurnView; resumed: boolean }

export interface InstanceGuard {
  /** Build the prompt-path caches from requests the daemon owns. Single-flight. */
  warm(reason: string): Promise<WarmResult | null>
  /**
   * Resolves when no warm-up is in flight, after `maxMs`, or as soon as a stop
   * is requested for `opencodeSessionId`. Never rejects.
   */
  settled(maxMs?: number, opencodeSessionId?: string): Promise<void>
  /** Probe the caches; dispose and re-warm when one holds an interrupt. */
  healIfPoisoned(reason: string, opts?: { force?: boolean; endingSessionId?: string }): Promise<HealResult>
  /**
   * Classify the latest turn of a session that went idle or errored; heal the
   * instance after any abort and re-prompt a victim. Every observer of the
   * same ended turn gets the same verdict.
   */
  inspectEndedTurn(opencodeSessionId: string): Promise<AbortedTurnVerdict>
  /** An OpenCode instance was disposed (event stream). */
  noteInstanceDisposed(): void
  /** Supply the boot-time dependencies (readiness, root check, resume). */
  configure(deps: Pick<InstanceGuardDeps, 'canWarm' | 'resumeVictim' | 'isRoot'>): void
}

const ABORT_NAMES = new Set(['MessageAbortedError', 'AbortError'])

export function createInstanceGuard(initial: InstanceGuardDeps): InstanceGuard {
  const deps: InstanceGuardDeps = { ...initial }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const canWarm = () => (deps.canWarm ? deps.canWarm() : true)

  let warming: Promise<WarmResult | null> | null = null
  let warmRetry: ReturnType<typeof setTimeout> | null = null
  let warmRetries = 0
  let healing: Promise<HealResult> | null = null
  let lastDisposedAt = 0
  // One verdict per ended assistant message: session.error and session.idle
  // both report the same turn.
  const inspected = new Map<string, Promise<AbortedTurnVerdict>>()

  const url = (path: string) => {
    const sep = path.includes('?') ? '&' : '?'
    return `${deps.getInternalUrl()}${path}${sep}directory=${encodeURIComponent(deps.workspace())}`
  }

  async function status(path: string, timeoutMs: number): Promise<number | string> {
    try {
      const res = await fetch(url(path), { signal: AbortSignal.timeout(timeoutMs) })
      // Drain so the connection is reusable; the body is not needed.
      await res.arrayBuffer().catch(() => undefined)
      return res.status
    } catch (err) {
      return err instanceof Error ? err.name : 'Error'
    }
  }

  function scheduleWarmRetry(reason: string): void {
    if (warmRetry || warmRetries >= WARM_RETRY_LIMIT) return
    warmRetries += 1
    warmRetry = setTimeout(() => {
      warmRetry = null
      void warm(reason)
    }, WARM_RETRY_MS)
  }

  function warm(reason: string): Promise<WarmResult | null> {
    if (warming) return warming
    if (!canWarm()) {
      scheduleWarmRetry(reason)
      return Promise.resolve(null)
    }
    warmRetries = 0
    const started = Date.now()
    const run = (async (): Promise<WarmResult> => {
      const results = await Promise.all(
        WARM_PATHS.map(async (path) => [path, await status(path, WARM_REQUEST_TIMEOUT_MS)] as const),
      )
      const statuses = Object.fromEntries(results)
      const ok = results.every(([, s]) => typeof s === 'number' && s < 500)
      const result = { ok, statuses, ms: Date.now() - started }
      logger.info('[instance-guard] warmed OpenCode instance caches', { reason, ...result })
      return result
    })()
    warming = run
    void run.finally(() => {
      if (warming === run) warming = null
    })
    return run
  }

  async function settled(maxMs = WARM_GATE_MAX_MS, opencodeSessionId?: string): Promise<void> {
    const pending = warming
    if (!pending) return
    const since = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxMs)
      }),
      // A Stop for this session releases its held prompt AT ONCE. Held any
      // longer, the prompt would reach OpenCode after the Stop's abort found
      // nothing to cancel, and after the hold settle stopped watching for a
      // late delivery (3 s): the turn would run although the user stopped it.
      // Released, it lands inside that window and the settle aborts it; if
      // that abort interrupts a cache build, the heal repairs the instance.
      new Promise<void>((resolve) => {
        if (!opencodeSessionId) return
        poll = setInterval(() => {
          if (opencodeStopRequestedSince(opencodeSessionId, since)) resolve()
        }, STOP_POLL_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (poll) clearInterval(poll)
  }

  async function poisonedPaths(): Promise<string[]> {
    const first = await Promise.all(
      WARM_PATHS.map(async (path) => [path, await status(path, PROBE_REQUEST_TIMEOUT_MS)] as const),
    )
    const suspects = first.filter(([, s]) => s === 503).map(([path]) => path)
    if (suspects.length === 0) return []
    await sleep(PROBE_CONFIRM_GAP_MS)
    const second = await Promise.all(
      suspects.map(async (path) => [path, await status(path, PROBE_REQUEST_TIMEOUT_MS)] as const),
    )
    return second.filter(([, s]) => s === 503).map(([path]) => path)
  }

  async function dispose(reason: string): Promise<boolean> {
    try {
      const res = await fetch(url('/instance/dispose'), {
        method: 'POST',
        signal: AbortSignal.timeout(DISPOSE_TIMEOUT_MS),
      })
      await res.arrayBuffer().catch(() => undefined)
      if (!res.ok) {
        logger.warn('[instance-guard] instance dispose refused', { reason, status: res.status })
        return false
      }
      lastDisposedAt = Date.now()
      return true
    } catch (err) {
      logger.warn('[instance-guard] instance dispose failed', {
        reason,
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  async function busySessions(): Promise<string[] | null> {
    try {
      const res = await fetch(url('/session/status'), { signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS) })
      if (!res.ok) return null
      const statuses = (await res.json()) as Record<string, { type?: string }>
      return Object.entries(statuses ?? {})
        .filter(([, s]) => s?.type === 'busy' || s?.type === 'retry')
        .map(([id]) => id)
    } catch {
      return null
    }
  }

  /**
   * Is any session other than `ending` busy? `ending` is the session whose
   * turn just ended: `session.error` arrives before its status turns idle, so
   * it is given a moment to settle instead of counting as busy.
   */
  async function othersBusy(ending: string | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const busy = await busySessions()
      if (busy === null) return true
      const others = busy.filter((id) => id !== ending)
      if (others.length > 0) return true
      if (!ending || !busy.includes(ending)) return false
      await sleep(300)
    }
    return true
  }

  async function heal(reason: string, force: boolean, ending?: string): Promise<HealResult> {
    // A warm-up in flight is building the caches right now; probing it would
    // only wait on the same builds.
    await settled()
    const poisoned = await poisonedPaths()
    if (poisoned.length === 0) {
      // A clean probe with nothing forcing it: the instance is healthy. A
      // forced dispose is never taken under a live turn — it would end it.
      if (!force) return { poisoned: false, disposed: false, poisonedPaths: [] }
      if (await othersBusy(ending)) {
        logger.warn('[instance-guard] not disposing: a session is busy', { reason })
        return { poisoned: false, disposed: false, poisonedPaths: [] }
      }
      logger.warn('[instance-guard] disposing OpenCode instance after an abort nobody requested', { reason })
    } else {
      // A poisoned instance fails every new step anyway: dispose regardless.
      logger.error('[instance-guard] OpenCode instance holds an interrupted cache; disposing it', {
        reason,
        poisonedPaths: poisoned,
      })
    }
    const disposed = await dispose(reason)
    if (disposed) {
      const warmed = await warm(`${reason}:after-dispose`)
      const still = await poisonedPaths()
      logger.info('[instance-guard] OpenCode instance healed', {
        reason,
        warmed: warmed?.ok ?? false,
        stillPoisoned: still,
      })
    }
    return { poisoned: poisoned.length > 0, disposed, poisonedPaths: poisoned }
  }

  function healIfPoisoned(
    reason: string,
    opts: { force?: boolean; endingSessionId?: string } = {},
  ): Promise<HealResult> {
    const force = opts.force === true
    const previous = healing
    const run = previous
      ? // Join the heal in flight; a forced request that it did not satisfy
        // runs once more after it.
        previous.then((result) =>
          force && !result.disposed ? heal(reason, true, opts.endingSessionId) : result,
        )
      : heal(reason, force, opts.endingSessionId)
    healing = run
    void run.finally(() => {
      if (healing === run) healing = null
    })
    return run
  }

  async function readEndedTurn(opencodeSessionId: string): Promise<EndedTurnView | null> {
    try {
      const res = await fetch(url(`/session/${encodeURIComponent(opencodeSessionId)}/message?limit=6`), {
        signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const rows = (await res.json()) as Array<{
        info?: {
          id?: string
          role?: string
          parentID?: string
          time?: { created?: number; completed?: number }
          error?: { name?: string }
        }
        parts?: unknown[]
      }>
      if (!Array.isArray(rows)) return null
      const assistant = [...rows].reverse().find((row) => row.info?.role === 'assistant')
      const info = assistant?.info
      if (!info?.id || !info.time?.completed) return null
      const parent = rows.find((row) => row.info?.role === 'user' && row.info.id === info.parentID)
      return {
        assistantMessageId: info.id,
        turnStartedAtMs: parent?.info?.time?.created ?? info.time.created ?? 0,
        errorName: info.error?.name ?? null,
        empty: !Array.isArray(assistant?.parts) || assistant.parts.length === 0,
      }
    } catch {
      return null
    }
  }

  function inspectEndedTurn(opencodeSessionId: string): Promise<AbortedTurnVerdict> {
    return (async (): Promise<AbortedTurnVerdict> => {
      const view = await readEndedTurn(opencodeSessionId)
      if (!view?.errorName || !ABORT_NAMES.has(view.errorName)) return { kind: 'none' }
      const known = inspected.get(view.assistantMessageId)
      if (known) return known
      const verdict = (async (): Promise<AbortedTurnVerdict> => {
        if (opencodeStopRequestedSince(opencodeSessionId, view.turnStartedAtMs)) {
          return { kind: 'requested', heal: await healIfPoisoned('requested-stop') }
        }
        // Nobody asked. A turn that never reached the model, on an instance
        // that was not replaced since the turn began, is a victim: dispose even
        // when the probe is clean — the cache that failed it may be one no
        // probe endpoint builds.
        const victim = view.empty && lastDisposedAt < view.turnStartedAtMs
        const heal = await healIfPoisoned('unrequested-abort', {
          force: victim,
          endingSessionId: opencodeSessionId,
        })
        let resumed = false
        if (victim && deps.resumeVictim && (await (deps.isRoot?.(opencodeSessionId) ?? Promise.resolve(true)))) {
          resumed = await deps.resumeVictim(opencodeSessionId, view).catch((err) => {
            logger.warn('[instance-guard] resume after an unrequested abort failed', {
              opencodeSessionId,
              err: err instanceof Error ? err.message : String(err),
            })
            return false
          })
        }
        logger.warn('[instance-guard] turn aborted without a stop request', {
          opencodeSessionId,
          assistantMessageId: view.assistantMessageId,
          empty: view.empty,
          resumed,
          ...heal,
        })
        return { kind: 'unrequested', heal, view, resumed }
      })()
      inspected.set(view.assistantMessageId, verdict)
      if (inspected.size > 256) {
        const oldest = inspected.keys().next().value
        if (oldest) inspected.delete(oldest)
      }
      return verdict
    })()
  }

  return {
    warm,
    settled,
    healIfPoisoned,
    inspectEndedTurn,
    noteInstanceDisposed() {
      lastDisposedAt = Date.now()
    },
    configure(next) {
      Object.assign(deps, next)
    },
  }
}

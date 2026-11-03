/**
 * Work that must not compete with a new session's first turn.
 *
 * A box answers its first prompt a few hundred milliseconds after it reports
 * ready, on 2 vCPUs. The first runtime-assets pass landed in that window on dev
 * (2026-11-03): it rebuilt the ~106 MB `kortix` CLI from chunks and hashed it,
 * ~1.4 s of disk and CPU while pi was building the first model request.
 *
 * The gate opens when the first turn ends, or `ms` after `start()`, whichever
 * comes first. Requests made while it is shut collapse into ONE run when it
 * opens; requests after that run at once. Nothing is dropped: a box with no
 * first turn runs the deferred work when the clock runs out.
 */
export interface AfterFirstTurnGate {
  /** Start the fallback clock. Call at runtime-ready. Idempotent. */
  start(): void
  /** A turn ended. The first call opens the gate. */
  turnEnded(): void
  /** Run now when the gate is open; otherwise once, when it opens. */
  request(): void
  readonly open: boolean
}

export interface GateTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: GateTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function afterFirstTurn(run: () => void, ms: number, timers: GateTimers = realTimers): AfterFirstTurnGate {
  let open = false
  let pending = false
  let timer: unknown = null
  const release = () => {
    if (open) return
    open = true
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    if (pending) {
      pending = false
      run()
    }
  }
  return {
    start() {
      if (!open && timer === null) timer = timers.setTimeout(release, ms)
    },
    turnEnded: release,
    request() {
      if (open) run()
      else pending = true
    },
    get open() {
      return open
    },
  }
}

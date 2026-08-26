import { logger } from './logger'
import { runtimeStateStore, type RuntimeStateDoc } from './runtime-state-projection'

/**
 * Pushes the daemon's own `/kortix/opencode/state` projection to the control
 * plane: `POST /v1/platform/runtime-projection` (sandbox token, gzip body).
 *
 * WHY. The API can PULL the same document, but a pulled projection exists only
 * for sessions somebody recently opened. The push makes the projection exist
 * from the moment the box boots, so the FIRST open of a cold session answers
 * `agents`/`commands`/`config` from Postgres, and a box that stops right after
 * boot leaves its last true state behind.
 *
 * SHAPE. Mirrors `boot-timeline-relay.ts`: same env vars, same token fallback
 * order, same "missing config → silent no-op" (self-host / local daemons may
 * have no control plane), fire-and-forget, bounded by a timeout, never throws,
 * never blocks the caller.
 *
 * CADENCE. Trailing debounce (2 s) + suppression on an unchanged etag, so the
 * steady state is one ~0.9 KB POST per boot plus one per config change.
 *
 * FAILURE. `503` retries on a bounded backoff ladder. `413` sheds
 * `tool_ids` → `skills` → `commands` and retries exactly once — the server
 * caps the DECOMPRESSED body at 256 KB and those are the only sections that
 * can plausibly carry it there. Anything else is one warn line and give-up
 * until the next trigger; the API's pull-through path remains the backstop.
 */

/** The server's decompressed-body cap (PROJECTION_MAX_BYTES on the API side). */
export const PROJECTION_RELAY_MAX_BYTES = 256 * 1024

const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_RETRY_MS = 2_000
/** 503 ladder: base, 2×, 4× — then give up until the next trigger. */
const MAX_UNAVAILABLE_RETRIES = 3
const PUSH_TIMEOUT_MS = 15_000

function debounceMs(): number {
  const raw = Number.parseInt(process.env.KORTIX_PROJECTION_RELAY_DEBOUNCE_MS || '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS
}

function retryBaseMs(): number {
  const raw = Number.parseInt(process.env.KORTIX_PROJECTION_RELAY_RETRY_MS || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_MS
}

type StateReader = () => Promise<{ doc: RuntimeStateDoc; etag: string } | null>

const defaultStateReader: StateReader = async () => {
  const store = runtimeStateStore()
  if (!store) return null
  const { doc, etag } = await store.read()
  return { doc, etag }
}

let stateReader: StateReader = defaultStateReader
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let rerunReason: string | null = null
let lastPushedEtag: string | null = null
let pendingReason = 'unknown'

/** A timer must never keep the daemon process alive. */
function unrefd(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return t
}

/**
 * Schedule a projection push. Fire-and-forget: returns immediately, never
 * throws, silently no-ops when the daemon has no control-plane config or no
 * runtime state store yet. Trailing debounce — a burst of triggers collapses
 * to one POST carrying the state as of the LAST trigger.
 */
export function scheduleRuntimeProjectionPush(reason: string): void {
  try {
    pendingReason = reason
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = unrefd(() => {
      debounceTimer = null
      void runPush(pendingReason)
    }, debounceMs())
  } catch (err) {
    logger.warn('[runtime-projection] schedule failed', { err: (err as Error).message })
  }
}

async function runPush(reason: string): Promise<void> {
  if (inFlight) {
    // A push is already on the wire; run once more when it finishes so the
    // trigger that arrived mid-flight is not lost.
    rerunReason = reason
    return
  }
  inFlight = true
  try {
    await doPush(reason)
  } catch (err) {
    // doPush handles its own failures; this catch is the never-throws floor.
    logger.warn('[runtime-projection] push failed', { err: (err as Error).message })
  } finally {
    inFlight = false
    if (rerunReason !== null) {
      const next = rerunReason
      rerunReason = null
      void runPush(next)
    }
  }
}

async function doPush(reason: string, unavailableRetries = 0): Promise<void> {
  const sessionId = process.env.KORTIX_SESSION_ID?.trim()
  const token = (process.env.KORTIX_TOKEN || '').trim()
  const apiUrl = process.env.KORTIX_API_URL?.replace(/\/+$/, '')
  if (!sessionId || !token || !apiUrl) return

  let state: Awaited<ReturnType<StateReader>>
  try {
    state = await stateReader()
  } catch (err) {
    logger.warn('[runtime-projection] state read failed', { err: (err as Error).message })
    return
  }
  if (!state) return
  const { doc, etag } = state
  if (etag === lastPushedEtag) return

  const apiRoot = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`
  const url = `${apiRoot}/platform/runtime-projection`

  // Pre-shed proactively when we can already see the document exceeding the
  // server's decompressed cap — a doomed 413 round trip teaches nothing.
  const fitted = shedProjectionToFit(doc, PROJECTION_RELAY_MAX_BYTES)
  if (fitted.shed.length > 0) {
    logger.warn('[runtime-projection] projection over the size cap; shed before send', {
      shed: fitted.shed,
    })
  }

  const post = (projection: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        Authorization: `Bearer ${token}`,
      },
      body: Bun.gzipSync(
        Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            captured_at: doc.built_at,
            projection_etag: etag,
            projection,
          }),
        ),
      ),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })

  let res: Response
  try {
    res = await post(fitted.projection)
  } catch (err) {
    logger.warn('[runtime-projection] push failed', { err: (err as Error).message })
    return
  }

  if (res.status === 413) {
    // The server said too big even after our pre-check: shed the full ladder
    // and retry exactly once. Still 413 → give up until the next trigger.
    const shed = shedAll(doc)
    logger.warn('[runtime-projection] 413; shedding tool_ids → skills → commands and retrying once')
    try {
      res = await post(shed)
    } catch (err) {
      logger.warn('[runtime-projection] shed retry failed', { err: (err as Error).message })
      return
    }
    if (!res.ok) {
      logger.warn('[runtime-projection] shed retry rejected; giving up until the next trigger', {
        status: res.status,
      })
      return
    }
  } else if (res.status === 503) {
    if (unavailableRetries >= MAX_UNAVAILABLE_RETRIES) {
      logger.warn('[runtime-projection] api unavailable; retries exhausted', {
        attempts: unavailableRetries + 1,
      })
      return
    }
    const retryAfterHeader = Number.parseInt(res.headers.get('retry-after') || '', 10)
    const delay =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1_000
        : retryBaseMs() * 2 ** unavailableRetries
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = unrefd(() => {
      retryTimer = null
      void doPush(reason, unavailableRetries + 1).catch(() => {})
    }, delay)
    return
  } else if (!res.ok) {
    logger.warn('[runtime-projection] push non-ok', { status: res.status, reason })
    return
  }

  lastPushedEtag = etag
  logger.info('[runtime-projection] projection relayed to api', {
    reason,
    etag,
    shed: fitted.shed,
    epoch: doc.epoch,
    seq: doc.seq,
  })
}

// ---------------------------------------------------------------------------
// Shedding — pure logic
// ---------------------------------------------------------------------------

/** The 413 shed order. Each step is applied to a copy, never the input. */
const SHED_STEPS: { name: string; apply: (doc: Record<string, unknown>) => void }[] = [
  { name: 'tool_ids', apply: (doc) => deleteKeyDeep(doc, 'tool_ids') },
  { name: 'skills', apply: (doc) => deleteKeyDeep(doc, 'skills') },
  {
    name: 'commands',
    apply: (doc) => {
      // known:false, not an empty list presented as fact — the tri-state rule.
      doc.commands = { known: false, reason: 'shed: over the relay size cap', value: [] }
    },
  },
]

/**
 * Shed sections in the fixed order — `tool_ids`, then `skills`, then
 * `commands` — until the serialized document fits under `maxBytes`. Returns
 * the (possibly shed) projection and the names of the steps applied. The
 * input document is never mutated.
 */
export function shedProjectionToFit(
  doc: RuntimeStateDoc,
  maxBytes: number,
): { projection: RuntimeStateDoc; shed: string[] } {
  if (JSON.stringify(doc).length <= maxBytes) return { projection: doc, shed: [] }
  const copy = structuredClone(doc) as unknown as Record<string, unknown>
  const shed: string[] = []
  for (const step of SHED_STEPS) {
    step.apply(copy)
    shed.push(step.name)
    if (JSON.stringify(copy).length <= maxBytes) break
  }
  return { projection: copy as unknown as RuntimeStateDoc, shed }
}

function shedAll(doc: RuntimeStateDoc): RuntimeStateDoc {
  const copy = structuredClone(doc) as unknown as Record<string, unknown>
  for (const step of SHED_STEPS) step.apply(copy)
  return copy as unknown as RuntimeStateDoc
}

/** Remove every property named `key`, at any depth. */
function deleteKeyDeep(value: unknown, key: string): void {
  if (Array.isArray(value)) {
    for (const item of value) deleteKeyDeep(item, key)
    return
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    delete record[key]
    for (const nested of Object.values(record)) deleteKeyDeep(nested, key)
  }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function __setRuntimeProjectionStateReaderForTests(reader: StateReader): void {
  stateReader = reader
}

export function __resetRuntimeProjectionRelayForTests(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (retryTimer) clearTimeout(retryTimer)
  debounceTimer = null
  retryTimer = null
  inFlight = false
  rerunReason = null
  lastPushedEtag = null
  pendingReason = 'unknown'
  stateReader = defaultStateReader
}

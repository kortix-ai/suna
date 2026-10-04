import { relayOrphanedTurnEndToApi } from './turn-relay'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '@/lib/log/logger'
import type { OpenCodeConfig as Config } from './config'
import type { Opencode } from './lifecycle'
import type { OpenCodeBootState as SandboxBootState } from './boot-state'
import { noteOpencodeStopRequested, type AbortedTurnVerdict } from './instance-guard'
import type { OpencodeTurnError } from './events'
import { isSharedSeedBakedRoot } from './opencode-fork-root'
import { openCodeSeedBakedPinPath, openCodeSessionPinPath, readOpenCodeSessionPin, writeOpenCodeSeedBakedPin, writeOpenCodeSessionPin } from './runtime-state'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { observeOpencodeDelivery } from './opencode-turn-state'
import { claimInitialTurnFromApi, createInitialOpenCodeSession, deliverInitialOpenCodePrompt, buildInitialPromptBody } from './initial-prompt'

export { resetClaimedInitialTurnForTests } from './initial-turn-claim'

// Reuse the pinned root and deliver the initial prompt only when delivery is unconfirmed.
/** Retry delay for the initial-session claim: 5s, 10s, …, capped at 30s. */
export function initialSessionRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * Math.max(attempt, 1), 30_000)
}

/** The subset of `SandboxBootState` the initial-session finalizer touches. */
type InitialSessionBootState = Pick<
  SandboxBootState,
  'initialRuntimeSessionId' | 'initialRuntimeSessionError' | 'initialRuntimeSessionRequired'
>

/**
 * Record that the initial OpenCode session is established under `sessionId`,
 * and release a poisoned failure flag left by an earlier attempt.
 *
 * `initialRuntimeSessionError` describes ONE attempt of the retry ladder,
 * not the box. `proxy.ts` (`initial_opencode_session_failed`, 503) and
 * `routes/health.ts` (`runtimeReady`) both treat it as a permanent failure
 * because until now nothing ever cleared it: it was written on a caught
 * throw in two places and cleared in none, so one throwing attempt wedged
 * the sandbox for its whole life even after `retryUntilInitialSessionEstablished`
 * established the root on a later rung. Only a manual Restart healed it.
 * Exported so proxy-auth.test.ts can prove the HTTP consequence: the proxy
 * stops answering `initial_opencode_session_failed` once this runs.
 */
export function finalizeInitialSession(bootState: InitialSessionBootState, sessionId: string): void {
  bootState.initialRuntimeSessionId = sessionId
  bootState.initialRuntimeSessionError = null
}

/**
 * Re-run the initial-session setup until the root is established, then run
 * `finalize` exactly once. `maybeCreateInitialOpencodeSession` is idempotent
 * (it re-resolves the pinned root and keeps deferring while opencode has not
 * answered), so retrying is safe; without the root the runtime can never turn
 * ready, so the loop has no attempt cap — only a capped interval. Exported for
 * tests; see initial-session-retry.test.ts.
 */
export async function retryUntilInitialSessionEstablished(input: {
  attempt: () => Promise<unknown>
  established: () => boolean
  finalize: () => Promise<void>
  delayMs?: (attempt: number) => number
  sleep?: (ms: number) => Promise<void>
  /** Tests only: stop after this many attempts. */
  maxAttempts?: number
}): Promise<boolean> {
  const delayMs = input.delayMs ?? initialSessionRetryDelayMs
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  for (let attempt = 1; input.maxAttempts === undefined || attempt <= input.maxAttempts; attempt++) {
    await sleep(delayMs(attempt))
    if (input.established()) break
    logger.warn('[boot] initial opencode session still pending; retrying', { attempt })
    // A throwing attempt is one failed rung, never the end of the loop.
    await input.attempt().catch((err) => {
      logger.warn('[boot] initial opencode session attempt failed', {
        attempt,
        err: err instanceof Error ? err.message : String(err),
      })
    })
    if (input.established()) break
  }
  if (!input.established()) return false
  await input.finalize()
  return true
}

export async function maybeCreateInitialOpencodeSession(
  opencode: Opencode,
  bootState: SandboxBootState,
  bootMark: (label: string) => void,
  onListening?: () => void,
): Promise<void> {
  const claimedTurn = await claimInitialTurnFromApi()
  if (!bootState.timeline.some((mark) => mark.label === 'initial-turn-claimed')) {
    bootMark('initial-turn-claimed')
  }
  const prompt = claimedTurn?.prompt ?? ''
  const bootstrapSession = (process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION ?? '').trim() === '1'
  if (!prompt && !bootstrapSession) return

  const workspace = process.env.KORTIX_WORKSPACE || '/workspace'

  // `opencode-session-created` used to be ONE mark covering opencode's entire
  const priorPin = readOpenCodeSessionPin()
  // F1: likewise captured BEFORE this boot could possibly write its own
  // marker (delivery, below, hasn't happened yet) — reflects only a PRIOR
  // boot's successful delivery, never this one's own pending write.
  const priorDeliveredMarker = readInitialPromptDeliveredMarker()
  const rootListDeadlineMs = await waitForOpencodeRootReadiness({
    firstListening: opencode.waitForCurrentListening(),
  })
  // A verified reload can promote OpenCode onto the standby port while the
  // readiness gate waits. Resolve the live URL after that wait so root lookup
  // never resumes against the retired process.
  const baseUrl = opencode.getInternalUrl()
  const resolved = await resolveExistingRoot(
    baseUrl,
    workspace,
    priorPin,
    rootListDeadlineMs,
    onListening,
  )
  bootMark('opencode-answering')
  if (resolved.status === 'defer') {
    // opencode never answered the root list within the deadline, and a prior
    logger.warn(
      '[boot] deferring initial opencode session setup — opencode did not answer in time and a prior root is pinned',
    )
    return
  }
  let existing = resolved.status === 'found' ? resolved.root : null
  // Warm-fork de-collision: a CoW-forked sandbox inherits the snapshot's single
  const seedBakedId = readSeedBakedSessionId()
  const rotateOffSeedRoot = isSharedSeedBakedRoot(existing?.id, seedBakedId)
  if (rotateOffSeedRoot) {
    logger.info('[boot] fork is on the shared seed-baked root; rotating to its own', { seedBakedId })
    existing = null
  }
  let sessionId: string
  let alreadyDelivered = false
  if (existing) {
    sessionId = existing.id
    alreadyDelivered = reusedRootAlreadyDelivered(existing, priorPin, priorDeliveredMarker)
    logger.info('[boot] reusing existing opencode root', {
      sessionId,
      alreadyDelivered,
      priorPin: priorPin !== null,
      known: existing.known,
      lastTurnIncomplete: existing.lastTurnIncomplete,
      lastTurnHasError: existing.lastTurnHasError,
    })
    // A turn interrupted by the restart left a part stuck "running"; finalize it
    // so a client streaming this root sees the turn end instead of spinning.
    // The ONE abort site: it re-reads the root, never re-aborts a turn a prior
    // finalize already errored, and never aborts a turn still being written.
    await finalizeOrphanedTurn(baseUrl, workspace, sessionId)
    bootMark('runtime-session-resume-requested')
  } else {
    logger.info('[boot] creating initial opencode session', {
      bytes: prompt.length,
      hasPrompt: prompt.length > 0,
      workspace,
    })
    bootMark('runtime-session-new-requested')
    const session = await createInitialOpenCodeSession(opencode, workspace)
    if (!session.id) throw new Error('opencode session create returned no id')
    bootMark('opencode-root-created')
    sessionId = session.id
  }

  pinOpencodeSessionFile(sessionId)
  if (rotateOffSeedRoot) {
    // This fork now owns `sessionId` (pinned above): retire the one-shot marker
    // and drop the orphaned shared seed root (best-effort — the pin is
    // authoritative, so cleanup failing never reintroduces the collision).
    clearSeedBakedMarker()
    if (seedBakedId && seedBakedId !== sessionId) {
      void deleteOpencodeSession(baseUrl, workspace, seedBakedId)
    }
  }
  bootMark('opencode-root-ready')
  // Set the durable DB pin server-side now — Slack/trigger/cron sessions that no
  // browser ever opens otherwise kept a null pin, which forced a lazy resolution
  // that could land on the wrong root.
  void relayBootstrapPinToApi(sessionId)

  if (prompt && !alreadyDelivered) {
    await publishInitialOpenCodeSessionAfterPrompt(bootState, sessionId, () =>
      deliverInitialOpenCodePrompt(
        opencode,
        sessionId,
        workspace,
        buildInitialPromptBody(prompt, claimedTurn?.messageId),
      ),
    )
    // F1: written ONLY after delivery actually succeeded (an exception above
    // skips this line) — the durable receipt `reusedRootAlreadyDelivered`
    // trusts unconditionally on every later boot of this sandbox.
    markInitialPromptDelivered()
    bootMark('initial-prompt-delivered')
    logger.info('[boot] initial prompt delivered', { sessionId })
  } else if (prompt) {
    bootState.initialRuntimeSessionId = sessionId
    logger.info('[boot] initial prompt already delivered to reused root; not re-running', {
      sessionId,
    })
  } else {
    bootState.initialRuntimeSessionId = sessionId
    logger.info('[boot] opencode root ready (bootstrap, no prompt)', { sessionId })
  }
  bootMark('opencode-session-created')
}

/**
 * Publish the boot root only after OpenCode accepts the initial prompt.
 *
 * The event-loop reconciliation timer reads `initialRuntimeSessionId` as its
 * acceptance gate. Publishing the id before `prompt_async` returns lets that
 * timer promote a `delivering` database record while the request is still in
 * flight, including before OpenCode has received one byte.
 */
export async function publishInitialOpenCodeSessionAfterPrompt(
  bootState: SandboxBootState,
  sessionId: string,
  deliver: () => Promise<void>,
): Promise<void> {
  await deliver()
  bootState.initialPromptDeliveredAtMs = Date.now()
  bootState.initialRuntimeSessionId = sessionId
}

/**
 * End a turn that lost the process writing it.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error`. A killed
 * or crashed opencode emits neither, so the last assistant message stays
 * incomplete and every client streaming it spins — indefinitely, because the
 * lifecycle's respawn brings the box back without ever closing that turn.
 *
 * Boot already did exactly this when it adopted a root whose last turn never
 * finished; it was simply unreachable from anywhere else. Same two calls, now
 * callable after an unplanned respawn as well.
 *
 * Best-effort by construction: if opencode is not answering yet, or the abort
 * fails, we log and move on. A stuck spinner is bad; a daemon that cannot
 * finish booting because it could not tidy up a turn is worse.
 */
export async function finalizeOrphanedTurn(
  baseUrl: string,
  workspace: string,
  sessionId: string,
): Promise<boolean> {
  const inspection = await inspectRoot(baseUrl, workspace, sessionId)
  if (!inspection.known) {
    // Could not read this root's message state at all — see
    // `RootInspection.known`. Never treat "could not tell" as orphaned.
    logger.warn('[boot] could not read root message state; not treating turn as orphaned', { sessionId })
    return false
  }
  // Covers both "the turn already finished" and "the turn already carries an
  // error from a prior finalize" — see `isTurnStillOrphaned`. The latter is
  // what makes this idempotent across repeated boots/respawns over the same
  // stuck turn: an already-errored turn is never re-aborted.
  if (!isTurnStillOrphaned(inspection)) return false
  // Never abort a turn that is merely still being written — see
  // confirmTurnOrphaned. This is the difference between closing a turn its
  // opencode took to the grave and interrupting one that was about to finish.
  if (!(await confirmTurnOrphaned(baseUrl, workspace, sessionId, inspection))) return false
  await abortOpencodeTurn(baseUrl, workspace, sessionId)
  if (inspection.lastTurnParentId) {
    await relayOrphanedTurnEndToApi(sessionId, inspection.lastTurnParentId).catch((err) =>
      logger.warn('[boot] orphaned-turn relay failed', { sessionId, err: (err as Error).message }),
    )
  }
  return true
}

/** Best-effort write of the canonical opencode root id to the well-known pin
 *  file (the in-sandbox source of truth read by abort/relay/turn-end). */
function pinOpencodeSessionFile(sessionId: string): void {
  try {
    writeOpenCodeSessionPin(sessionId)
  } catch (err) {
    logger.warn('[boot] failed to pin opencode session id', err)
  }
}

/**
 * F1: durable proof that `deliverInitialOpenCodePrompt` actually SUCCEEDED —
 * not just that boot intended to deliver it. The session pin is
 * written BEFORE delivery (see `pinOpencodeSessionFile` above, called ahead
 * of the delivery call at this function's call site). A daemon crash after
 * that write can leave the pin behind but never deliver. A bare-pin check
 * alone would then read every future boot as "already delivered". That would
 * silence the session forever.
 * (see `reusedRootAlreadyDelivered`). This marker is written ONLY after
 * `deliverInitialOpenCodePrompt` returns successfully, right next to the pin,
 * so its mere existence is the delivery receipt the pin alone can't provide.
 */
function initialPromptDeliveredMarkerPath(): string {
  return join(dirname(openCodeSessionPinPath()), 'opencode-initial-prompt-delivered')
}

/** Best-effort read of the F1 delivery marker. False (never true-by-accident)
 *  on any read failure — the same "unknown reads never skip delivery" bias as
 *  the rest of this gate; see `reusedRootAlreadyDelivered`. */
function readInitialPromptDeliveredMarker(): boolean {
  try {
    return existsSync(initialPromptDeliveredMarkerPath())
  } catch {
    return false
  }
}

/** Best-effort write of the F1 delivery marker. Directory already exists by
 *  the time this runs — `pinOpencodeSessionFile` (called earlier in the same
 *  boot) already created it. */
function markInitialPromptDelivered(): void {
  try {
    writeFileSync(initialPromptDeliveredMarkerPath(), '1', { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    logger.warn('[boot] failed to write initial-prompt-delivered marker', err)
  }
}

/** Record (at seed time) that the pinned root is the SEED's pre-baked one, so the
 *  first claiming fork rotates off it instead of sharing it. Captured into the
 *  snapshot next to the pin, so every fork inherits it. See opencode-fork-root.ts. */
export function markSeedBakedSession(sessionId: string): void {
  try {
    writeOpenCodeSeedBakedPin(sessionId)
  } catch (err) {
    logger.warn('[seed] failed to write seed-baked session marker', err)
  }
}

function readSeedBakedSessionId(): string | null {
  try {
    const path = openCodeSeedBakedPinPath()
    if (!existsSync(path)) return null
    const id = readFileSync(path, 'utf8').trim()
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** One-shot: a fork has taken its OWN root, so retire the marker — later daemon
 *  restarts then reuse the fork's root via the normal idempotent reuse path. */
function clearSeedBakedMarker(): void {
  try {
    const path = openCodeSeedBakedPinPath()
    if (existsSync(path)) unlinkSync(path)
  } catch (err) {
    logger.warn('[boot] failed to clear seed-baked marker', err)
  }
}

/** Best-effort delete of the orphaned shared seed root after a fork rotates onto
 *  its own. Correctness does NOT depend on this (the fork pins + relays its own
 *  id); it just stops the empty shared root from lingering in the session list. */
async function deleteOpencodeSession(baseUrl: string, workspace: string, sessionId: string): Promise<void> {
  try {
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(workspace)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3_000) },
    )
  } catch {
    /* orphan is harmless — the fork's own pinned root is authoritative */
  }
}

interface ExistingRoot {
  id: string
  hasMessages: boolean
  lastTurnIncomplete: boolean
  /** See `RootInspection.lastTurnHasError` — an errored turn is already
   *  finalized and must not be re-aborted. */
  lastTurnHasError: boolean
  /** Carried through so the orphan re-check can tell the same unfinished turn
   *  from a different one that started since. */
  lastMessageId: string | null
  /** See `RootInspection.known` — false when the read that produced the rest
   *  of this shape failed. `hasMessages`/`lastTurnIncomplete`/`lastTurnHasError`
   *  are meaningless in that case (all defaulted `false`); callers must branch
   *  on `known` before trusting them. */
  known: boolean
}

/** What `resolveExistingRoot` learned, and what the caller may safely do about
 *  it — see the function doc for the three outcomes. Exported for tests. */
export type ExistingRootResult =
  | { status: 'found'; root: ExistingRoot }
  | { status: 'create' }
  | { status: 'defer' }

const OPENCODE_ROOT_RESOLUTION_DEADLINE_MS = 20_000
const OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS = 5_000
const OPENCODE_LISTENING_GATE_MAX_MS = OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS

type OpencodeRootReadinessInput = {
  /** The current OpenCode announced its request handler (or the fallback proved it). */
  firstListening: Promise<void>
  deadlineMs?: number
}

type OpencodeRootReadinessDeps = {
  now?: () => number
  waitForSignal?: (signal: Promise<void>, timeoutMs: number) => Promise<void>
}

async function waitForSignalOrTimeout(signal: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Hold the root lookup until OpenCode can actually answer it.
 *
 * Every boot waits for the current OpenCode's readiness announcement
 * (`waitForCurrentListening`, see OPENCODE_LISTENING_LINE in lifecycle.ts). A
 * freshly spawned OpenCode binds its port ~100 ms before its request handler
 * exists, and a root-list request that lands in that window is never
 * answered: it burns the whole 5 s attempt timeout, then the retry is answered
 * in milliseconds. That was the S3-boot penalty measured on 2026-09-15
 * (`opencode-listening` at 6.2 s instead of 2.3 s): the S3 checkout lands
 * early enough for the poll to be running when the port binds, the Git
 * checkout mostly does not. The wait is capped at one root-list attempt
 * (5 s) and its elapsed time is deducted from the existing 20-second
 * root-resolution budget, so it cannot extend boot. The unchanged resolver
 * still owns retries, root selection, and found/create/defer decisions.
 */
export async function waitForOpencodeRootReadiness(
  input: OpencodeRootReadinessInput,
  deps: OpencodeRootReadinessDeps = {},
): Promise<number> {
  const deadlineMs = Math.max(0, input.deadlineMs ?? OPENCODE_ROOT_RESOLUTION_DEADLINE_MS)
  const now = deps.now ?? Date.now
  const waitForSignal = deps.waitForSignal ?? waitForSignalOrTimeout
  const startedAt = now()
  await waitForSignal(input.firstListening, Math.min(deadlineMs, OPENCODE_LISTENING_GATE_MAX_MS))
  const elapsedMs = Math.max(0, now() - startedAt)
  return Math.max(0, deadlineMs - elapsedMs)
}

/**
 * Resolve a usable existing canonical root for this workspace so a restart
 * reuses it instead of creating a duplicate. Prefers the pinned id (if it still
 * exists as a root), else the most-recently-active root.
 *
 * Three outcomes:
 *   - `found`  — a root exists. `root.known` says whether its message state
 *     could actually be read (see `ExistingRoot.known`).
 *   - `create` — opencode answered and genuinely holds no root, OR opencode
 *     never answered within the deadline AND nothing is pinned (a pinless
 *     cold boot — there is no conversation to orphan). Safe to create the
 *     first root, same as before.
 *   - `defer`  — opencode never answered the root list within the deadline
 *     AND a prior root IS pinned. Creating (and pinning) a fresh root here
 *     would risk orphaning that conversation under a competing one — opencode
 *     may just be slow (a cold post-resume opencode routinely takes longer
 *     than this deadline). The caller must not create or pin anything; see
 *     the 2026-06-15 spinner-incident comment above
 *     `maybeCreateInitialOpencodeSession`. T12.
 *
 * `priorPin`/`rootListDeadlineMs` default to the real pin file / 20s deadline
 * in production and are overridable so tests can exercise the `defer` branch
 * without a 20s wait or a real pin file — same pattern as
 * `opencodeTurnInFlight` in opencode-turn-state.ts.
 */
export async function resolveExistingRoot(
  baseUrl: string,
  workspace: string,
  priorPin: string | null = readOpenCodeSessionPin(),
  rootListDeadlineMs = OPENCODE_ROOT_RESOLUTION_DEADLINE_MS,
  onListening?: () => void,
): Promise<ExistingRootResult> {
  // Wait for a DEFINITIVE answer from opencode before deciding. Treating a slow
  const roots = await waitForRootList(baseUrl, workspace, rootListDeadlineMs, onListening)
  if (!roots) {
    if (priorPin) {
      logger.warn(
        '[boot] opencode did not answer the root list within the deadline; a prior root is pinned — deferring instead of creating a competing root',
        { priorPin },
      )
      return { status: 'defer' }
    }
    return { status: 'create' }
  }
  if (roots.length === 0) return { status: 'create' }
  const pinned = priorPin ? roots.find((r) => r.id === priorPin) : undefined
  const chosen = pinned || pickMostRecentRoot(roots)
  if (!chosen) return { status: 'create' }
  const inspection = await inspectRoot(baseUrl, workspace, chosen.id)
  return {
    status: 'found',
    root: {
      id: chosen.id,
      hasMessages: inspection.hasMessages,
      lastTurnIncomplete: inspection.lastTurnIncomplete,
      lastTurnHasError: inspection.lastTurnHasError,
      lastMessageId: inspection.lastMessageId,
      known: inspection.known,
    },
  }
}
interface RootLite { id: string; created: number; updated: number }

/** Poll opencode's session list until it answers definitively (reachable),
 *  returning the roots it holds (possibly `[]`). Null only if opencode never
 *  became reachable within the deadline — so the caller never mistakes a slow
 *  boot for an empty workspace and creates a duplicate root. */
async function waitForRootList(
  baseUrl: string,
  workspace: string,
  deadlineMs = OPENCODE_ROOT_RESOLUTION_DEADLINE_MS,
  onListening?: () => void,
): Promise<RootLite[] | null> {
  const deadline = Date.now() + deadlineMs
  let listeningSeen = false
  const markListening = () => {
    if (listeningSeen) return
    listeningSeen = true
    onListening?.()
  }
  while (Date.now() < deadline) {
    const roots = await listOpencodeRoots(
      baseUrl,
      workspace,
      markListening,
      OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS,
    )
    if (roots !== null) return roots
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

/** List opencode ROOT sessions (no parentID), newest-updated first. Returns null
 *  when opencode is not reachable yet — distinct from `[]` (reachable, no
 *  sessions).
 *
 *  `roots=true` makes the SERVER drop child sessions instead of us paging every
 *  session in the workspace and filtering. Probed on the real binaries
 *  2026-08-20: `roots`, `limit`, `start`, `search` and `scope` are all declared
 *  on `GET /session` in 1.17.11 AND 1.18.19, and both answered
 *  `?roots=true&limit=1` with exactly the most-recently-updated ROOT out of
 *  three roots plus one newer child. Boxes provisioned before today still run
 *  1.17.11, so that parity is the reason this is safe to ship as one call.
 *
 *  `limit=1` is deliberately NOT used, and the client-side `!parentID` filter
 *  deliberately stays:
 *   - `resolveExistingRoot` prefers the PINNED root over the newest one, which
 *     needs the pin to be findable in this list — `limit=1` would hide it and
 *     silently re-canonicalize a live conversation onto a different root.
 *   - An OpenCode that does not know a query parameter ignores it silently. If
 *     `roots` were ever dropped, the filter is what still stops a Task-tool
 *     CHILD from being adopted as the canonical root. One line, absolute. */
async function listOpencodeRoots(
  baseUrl: string,
  workspace: string,
  onHttpResponse?: () => void,
  attemptTimeoutMs = OPENCODE_ROOT_LIST_ATTEMPT_TIMEOUT_MS,
): Promise<RootLite[] | null> {
  try {
    const res = await fetch(
      `${baseUrl}/session?directory=${encodeURIComponent(workspace)}&roots=true`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      },
    )
    onHttpResponse?.()
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ id?: string; parentID?: string | null; time?: { created?: number; updated?: number } }>
    if (!Array.isArray(data)) return []
    return data
      .filter((s) => s.id && !s.parentID)
      .map((s) => ({ id: s.id as string, created: s.time?.created ?? 0, updated: s.time?.updated ?? s.time?.created ?? 0 }))
  } catch {
    return null
  }
}

/** Most-recently-active root, tie-broken by newest-created then id. Kept in sync
 *  with the server's pickCanonicalRoot (opencode-session-resolver.ts) so the
 *  sandbox and the API converge on the SAME canonical root. */
function pickMostRecentRoot(roots: RootLite[]): RootLite | null {
  let best: RootLite | null = null
  for (const r of roots) {
    if (!best) { best = r; continue }
    if (
      r.updated > best.updated ||
      (r.updated === best.updated && r.created > best.created) ||
      (r.updated === best.updated && r.created === best.created && r.id < best.id)
    ) {
      best = r
    }
  }
  return best
}

interface RootInspection {
  hasMessages: boolean
  lastTurnIncomplete: boolean
  /** `info.error` is present on the last message. A prior `/abort` (or opencode
   *  itself) already stamped this turn with an AbortError/MessageAbortedError
   *  without ever stamping `time.completed` — so it is already finalized, not
   *  orphaned. Re-aborting it would only re-emit the same `message.updated`/
   *  `session.error` to every client watching, re-rendering "Interrupted" for a
   *  turn that already ended. See `isTurnStillOrphaned`. */
  lastTurnHasError: boolean
  /** Identity of the last message, so a re-check can tell "same turn, still
   *  unfinished" from "a different turn has since started". */
  lastMessageId: string | null
  lastTurnParentId: string | null
  /**
   * False when the read failed — opencode unreachable, non-2xx, the 5s
   * timeout a cold post-resume opencode routinely hits, or an unparseable
   * response. Mirrors `RootInspection.known` in opencode-turn-state.ts (same
   * shape, same reason): without it, "genuinely no messages" and "could not
   * tell" are indistinguishable. Collapsing the second into the first either
   * re-delivers the initial prompt into a live conversation (boot's
   * reused-root path) or re-aborts a turn nobody actually confirmed was dead
   * (`finalizeOrphanedTurn`). Every other field on this shape is meaningless
   * when `known` is false — callers must check `known` first. See T12.
   */
  known: boolean
}

/**
 * Single source of truth for "is this turn still eligible to be aborted as
 * orphaned?" — incomplete AND not already carrying an error. Every finalize
 * path (boot's reused-root check, `finalizeOrphanedTurn`'s unplanned-respawn
 * check, and the settle re-check inside `confirmTurnOrphaned`) must route
 * through this instead of reading `lastTurnIncomplete` directly, so the error
 * guard cannot drift out of sync between them.
 *
 * `known: false` (the read failed) is never orphaned. We could not confirm
 * anything, so we must not abort a turn that might still be running — the
 * gate every caller here relies on. See `RootInspection.known`.
 */
function isTurnStillOrphaned(inspection: {
  lastTurnIncomplete: boolean
  lastTurnHasError: boolean
  known: boolean
}): boolean {
  if (!inspection.known) return false
  return inspection.lastTurnIncomplete && !inspection.lastTurnHasError
}

/**
 * Has the initial prompt already reached this root — or must we assume so?
 *
 * `known: false` means the read that would answer this failed (see
 * `RootInspection.known`). Treating that as "no messages" — the bug this
 * closes — reads as "never delivered" and re-delivers `prompt` into a
 * conversation that may already have it. Assuming delivered instead costs at
 * most one skipped bootstrap prompt on a root that turns out to be genuinely
 * empty, which is always safe to retry from outside: nothing observable ran
 * yet to redo. See T12.
 */
function initialPromptAlreadyDelivered(existing: { known: boolean; hasMessages: boolean }): boolean {
  if (!existing.known) return true
  return existing.hasMessages
}

/**
 * T22/F1 — the initial-prompt gate for a REUSED root, one layer above
 * `initialPromptAlreadyDelivered`. OpenCode's `session.revert` is a STAGED
 * pointer; nothing is deleted until the next prompt — from ANY producer —
 * commits the truncation. A commit can truncate the reused root all the way
 * back to zero messages, and `initialPromptAlreadyDelivered` reads that
 * exactly like "never delivered" — re-running `prompt` (the original task
 * kickoff) into a session the user was mid-rewind on.
 *
 * F1: a bare prior pin is NOT proof of delivery — the pin is written BEFORE
 * `deliverInitialOpenCodePrompt` runs (see the call site), so a crash in that
 * window leaves a pin behind with nothing ever delivered. Treating any prior
 * pin as proof (the old T22 rule) then silences the session forever: every
 * later boot sees the pin and skips delivery. The durable delivery marker
 * (`readInitialPromptDeliveredMarker`, written only AFTER a successful
 * delivery) is the only unconditional proof. Short of that, a prior pin is
 * trusted ONLY when it also matches the root we actually reused AND that
 * root's transcript is confirmed non-empty — i.e. genuine reuse of a root
 * that plainly already has the conversation, not merely "some pin exists".
 *
 * `priorPin` must be read BEFORE this boot writes its own pin (see the call
 * site) so it reflects only what a PRIOR boot left behind — never this one's
 * own pending write. `deliveredMarkerExists` must likewise be read before
 * this boot's own (possible) marker write.
 *
 * Falls through to `initialPromptAlreadyDelivered`'s message-count read
 * (unchanged from T12) whenever neither the marker nor the matching-pin case
 * applies — covering both the pinless cold-reuse case and the crash-window
 * case (pin present, no marker, transcript confirmed empty: deliver).
 */
export function reusedRootAlreadyDelivered(
  existing: { id: string; known: boolean; hasMessages: boolean },
  priorPin: string | null,
  deliveredMarkerExists: boolean,
): boolean {
  if (deliveredMarkerExists) return true
  if (priorPin !== null && existing.id === priorPin && existing.known && existing.hasMessages) return true
  return initialPromptAlreadyDelivered(existing)
}

/**
 * How long to let an "incomplete" turn prove itself alive before aborting it.
 *
 * `lastTurnIncomplete` is `role === 'assistant' && !time.completed`, which is
 * equally true of a turn nobody is writing (orphaned by a dead opencode) and
 * one that is streaming right now. Aborting the second kind ends a healthy turn
 * and stamps it with an AbortError, which the UI renders as "Interrupted" under
 * an answer that finished perfectly well.
 *
 * The two are separable by waiting: nothing is writing an orphaned turn, so it
 * stays incomplete forever, while a live one completes in moments. Two seconds
 * is far longer than the gap between opencode finishing a turn and stamping
 * `time.completed`, and it costs nothing on the path that matters — a genuinely
 * orphaned turn is already broken and two seconds later still is.
 */
const ORPHAN_SETTLE_MS = 2_000

/** Does the root already have messages (prompt delivered), and is its last turn
 *  an assistant message left incomplete by a crash (no completion time)? */
async function inspectRoot(baseUrl: string, workspace: string, sessionId: string): Promise<RootInspection> {
  try {
    const res = await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    // Non-2xx (opencode answering but unhappy — e.g. mid-restart) is a read
    // failure, not "no messages": `known: false`.
    if (!res.ok) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, lastTurnParentId: null, known: false }
    }
    const msgs = (await res.json()) as Array<{
      info?: { id?: string; role?: string; error?: unknown; parentID?: string; time?: { completed?: number } }
    }>
    // An unparseable shape is also a read failure, not a genuinely empty root
    // — only an actual `[]` counts as a confirmed-empty root.
    if (!Array.isArray(msgs)) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, lastTurnParentId: null, known: false }
    }
    if (msgs.length === 0) {
      return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, lastTurnParentId: null, known: true }
    }
    const last = msgs[msgs.length - 1]
    const incomplete = last?.info?.role === 'assistant' && !last?.info?.time?.completed
    return {
      hasMessages: true,
      lastTurnIncomplete: Boolean(incomplete),
      lastTurnHasError: Boolean(last?.info?.error),
      lastMessageId: last?.info?.id ?? null,
      lastTurnParentId: incomplete ? last?.info?.parentID ?? null : null,
      known: true,
    }
  } catch {
    // Unreachable, or the 5s AbortSignal.timeout above fired — the exact "cold
    // post-resume opencode" hazard this whole tri-state exists for.
    return { hasMessages: false, lastTurnIncomplete: false, lastTurnHasError: false, lastMessageId: null, lastTurnParentId: null, known: false }
  }
}

/**
 * Is the turn actually ORPHANED, or just still being written?
 *
 * Look again after a settle window. Nothing is writing an orphaned turn, so it
 * is still incomplete; a live one has finished, and aborting it would have
 * ended a healthy answer and labelled it "Interrupted".
 *
 * Also refuses when the last message CHANGED — a different turn started in the
 * meantime, and that one is certainly alive.
 */
async function confirmTurnOrphaned(
  baseUrl: string,
  workspace: string,
  sessionId: string,
  first: RootInspection,
): Promise<boolean> {
  await new Promise((r) => setTimeout(r, ORPHAN_SETTLE_MS))
  const second = await inspectRoot(baseUrl, workspace, sessionId)
  if (!second.known) {
    // The settle re-check itself could not read the root. Do NOT abort on the
    // strength of the FIRST read alone — that would abort turns we can no
    // longer confirm are still incomplete now.
    logger.warn('[boot] could not confirm turn state during settle re-check; not aborting', { sessionId })
    return false
  }
  if (!second.lastTurnIncomplete) {
    logger.info('[boot] turn completed on its own; not aborting', { sessionId })
    return false
  }
  if (second.lastTurnHasError) {
    // A prior abort (or opencode itself) already stamped this turn with an
    // error without ever stamping `time.completed`. It is already finalized —
    // re-aborting it would only re-emit the same message.updated/session.error
    // to every client watching, re-rendering "Interrupted" on every boot.
    logger.info('[boot] turn already carries an error; already finalized, not aborting', { sessionId })
    return false
  }
  if (first.lastMessageId && second.lastMessageId !== first.lastMessageId) {
    logger.info('[boot] a newer turn started; not aborting', { sessionId })
    return false
  }
  return true
}

/**
 * The cause relayed for a turn the runtime aborted before it reached the model
 * while nobody asked for a stop, when it could not be resumed. Without it the
 * turn reads "No reason was reported" (instance-guard.ts).
 */
export function unrequestedAbortCause(verdict: AbortedTurnVerdict): OpencodeTurnError | undefined {
  if (verdict.kind !== 'unrequested' || verdict.resumed || !verdict.view.empty) return undefined
  return {
    name: 'RuntimeAbortedTurn',
    message: verdict.heal.disposed
      ? 'The agent runtime stopped this turn before it started. Kortix reset the runtime. Send your message again.'
      : 'The agent runtime stopped this turn before it started, and nobody asked it to stop. Send your message again.',
  }
}

/** Finalize an interrupted turn so a streaming client stops spinning. */
async function abortOpencodeTurn(baseUrl: string, workspace: string, sessionId: string): Promise<void> {
  noteOpencodeStopRequested(sessionId, 'orphaned-turn')
  try {
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(workspace)}`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) },
    )
    logger.info('[boot] aborted interrupted turn on reused root', { sessionId })
  } catch (err) {
    logger.warn('[boot] failed to abort interrupted turn', { sessionId, err: (err as Error).message })
  }
}

/**
 * Report the canonical opencode root to apps/api so it writes the durable DB
 * pin (project_sessions.opencode_session_id) at bootstrap — no browser needed.
 * Best-effort and fire-once: even if it never lands (transient blip), the API
 * still heals the pin on the first /ensure-opencode. Never blocks boot.
 */
async function relayBootstrapPinToApi(opencodeSessionId: string): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'opencode_session',
        opencode_session_id: opencodeSessionId,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logger.warn('[boot] bootstrap pin relay non-ok', { status: res.status })
      return
    }
    logger.info('[boot] bootstrap opencode session pinned via api', { opencodeSessionId })
  } catch (err) {
    logger.warn('[boot] bootstrap pin relay failed', { err: (err as Error).message })
  }
}

/**
 * Keep OpenCode's `kortix` provider map in sync with the models this project's
 * PICKER can actually offer — for the whole life of the sandbox.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * OpenCode materializes provider models ONCE, at process start, from the config
 * file the daemon writes. That file's catalog comes from the image-baked
 * `/opt/kortix/llm-catalog.json`, frozen at template-build time. Two independent
 * things move faster than the image:
 *
 *   1. the MANAGED lineup is deployment config (LLM_GATEWAY_MANAGED_MODELS),
 *      so a managed model added after the bake is absent forever — prod
 *      incident 2026-08-19, `ModelNotFound: kortix/grok-4.6`;
 *   2. models.dev adds ~60 BYOK models a day, so a connected provider's newest
 *      model is absent for exactly the same reason. This is the SELF-HOST
 *      shape of the bug: there is no managed lineup at all there, every model
 *      is BYOK, and the same stale file produces the same error.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * Every model the picker can offer for this project is in OpenCode's provider
 * map before the session is ready.
 *
 * The picker set is `managed ∪ models of the project's CONNECTED providers`
 * (apps/api's `projectPickerCatalog`), NOT the ~6k-model catalog. Diffing the
 * whole catalog would restart every boot forever, because a day-old baked file
 * is always missing something nobody can pick. See `missingPickerModelIds`.
 *
 * ── The cost model ──────────────────────────────────────────────────────────
 * Nothing here runs on the path that gates OpenCode's port bind. Both fetches
 * start at proxy-up and are only settled at the reconcile point, which already
 * sits behind OpenCode's own 4.7-12s cold start. When nothing is missing this
 * whole module is a diff of two sets and one log line.
 */
import type { Config } from './config'
import { logger } from './logger'
import {
  cachedFullCatalog,
  configuredProviderModelIds,
  connectedProviderIds,
  fetchLiveCatalogs,
  missingPickerModelIds,
  modelNotFoundId,
  pickerRelevantModelIds,
  OPENCODE_HOME,
  settleFullCatalogPrefetch,
  settleManagedModelsPrefetch,
  startFullCatalogPrefetch,
  startManagedModelsPrefetch,
  waitForOpencodeReady,
  writeOverlayCatalogFile,
  type KortixGatewayModel,
  type Opencode,
} from './opencode'
import { opencodeTurnInFlight } from './opencode-turn-state'

/** How much longer the reconcile waits on an unsettled full-catalog fetch
 *  before proceeding on the managed set alone. Readiness is the thing being
 *  protected: the BYOK half is picked up by the deferred re-run. */
const FULL_CATALOG_RECONCILE_GRACE_MS = 3_000

/** One self-heal per model id per this window. A gateway that genuinely does
 *  not serve the id must not turn every send into a restart. */
const SELF_HEAL_COOLDOWN_MS = 10 * 60_000

const SESSION_CATALOG_FILE = `${OPENCODE_HOME}/.config/kortix-llm-catalog.session.json`
const BAKED_CATALOG_FILE = '/opt/kortix/llm-catalog.json'

export type ReconcileTrigger = 'boot' | 'env-push' | 'refresh' | 'catalog-late' | 'turn-end'

export interface ReconcileHandles {
  opencode: Opencode
  cfg: Config
}

/** Set once the session runtime exists, so later triggers (an env push, a
 *  /kortix/refresh, a ModelNotFound) can reach OpenCode without threading the
 *  handles through every route. */
let handles: ReconcileHandles | null = null

/** Test/production seams. Production always uses the real implementations. */
export interface ReconcileSeams {
  catalogTargetFile?: string
  turnProbe?: (baseUrl: string, workspace: string) => Promise<boolean | null>
}

let seams: ReconcileSeams = {}

let inFlight: Promise<boolean> | null = null
let deferredTrigger: ReconcileTrigger | null = null
let lastSelfHealAt = new Map<string, number>()

export function registerModelReconcile(next: ReconcileHandles, opts: ReconcileSeams = {}): void {
  handles = next
  seams = opts
}

/** Test seam: drop every piece of module state between cases. */
export function resetModelReconcileForTests(): void {
  handles = null
  seams = {}
  inFlight = null
  deferredTrigger = null
  lastSelfHealAt = new Map()
}

/** Start BOTH catalog fetches. Called at proxy-up; never awaited by boot. */
export function startCatalogPrefetches(env: NodeJS.ProcessEnv = process.env): void {
  startManagedModelsPrefetch(env.KORTIX_LLM_BASE_URL, env.KORTIX_LLM_API_KEY)
  startFullCatalogPrefetch(env.KORTIX_LLM_BASE_URL, env.KORTIX_LLM_API_KEY)
}

function currentCatalogFile(): string {
  return process.env.KORTIX_LLM_CATALOG_FILE ?? BAKED_CATALOG_FILE
}

function targetCatalogFile(): string {
  return seams.catalogTargetFile ?? SESSION_CATALOG_FILE
}

/**
 * The one reconcile pass. Returns true when it restarted OpenCode.
 *
 * `waitForFullCatalogMs` is how long it may wait on the in-flight full-catalog
 * fetch. Boot passes the grace window; later triggers pass 0, because by then
 * the answer is either cached or not worth waiting for.
 */
async function reconcileOnce(
  trigger: ReconcileTrigger,
  waitForFullCatalogMs: number,
): Promise<boolean> {
  const current = handles
  if (!current) return false
  const { opencode, cfg } = current
  const startedAt = Date.now()

  // Re-arm before settling. Idempotent by construction: a prefetch already in
  // flight, or a cache still inside its TTL, makes this a no-op. It matters for
  // a LATER trigger — a provider connected 15 minutes into a session is past
  // the boot prefetch's cache TTL, and without this the reconcile would answer
  // from an expired cache that predates the very change that woke it.
  startCatalogPrefetches()

  // Free in wall-clock terms at boot: OpenCode is cold-starting in its OWN
  // process while this waits, and the next boot step blocks on that anyway.
  // Later triggers are detached from every caller, so the same wait is free
  // there for a different reason.
  const managed = await settleManagedModelsPrefetch()
  const full =
    waitForFullCatalogMs > 0
      ? await settleFullCatalogPrefetch(waitForFullCatalogMs, () => {
          // The catalog landed after the reconcile gave up on it. Re-run —
          // idle-only, so a turn that started meanwhile is never severed.
          void scheduleModelReconcile('catalog-late')
        })
      : cachedFullCatalog()

  const connected = connectedProviderIds()
  const missing = missingPickerModelIds(managed, full, connected)
  const bootedCount = bootedProviderModelCount()

  if (missing.length === 0) {
    logger.info('[models] reconcile: opencode already registers every selectable model', {
      trigger,
      booted: bootedCount,
      managed: managed ? Object.keys(managed).length : null,
      connected: [...connected],
      fullCatalog: full ? Object.keys(full).length : null,
      pickerRelevant: pickerRelevantModelIds(managed, full, connected).length,
      missing: 0,
      restarted: false,
      ms: Date.now() - startedAt,
    })
    return false
  }

  const probe = seams.turnProbe ?? opencodeTurnInFlight
  const turnInFlight = await probe(opencode.getInternalUrl(), cfg.workspace)
  if (turnInFlight !== false) {
    // `null` ("cannot tell") counts as busy by design — a restart must never be
    // taken on an unreadable answer. Retried when the next turn ends.
    deferredTrigger = trigger
    logger.warn('[models] reconcile: deferring restart — a turn is live or unreadable', {
      trigger,
      missing: missing.slice(0, 20),
      missingCount: missing.length,
      turnInFlight,
      ms: Date.now() - startedAt,
    })
    return false
  }

  // The overlay is the LIVE MANAGED SET plus the missing picker ids — never the
  // whole live catalog. Two reasons for each half:
  //   - the managed set in full, because it is small (~7 records) and the
  //     gateway that serves it is authoritative for it, so the written file
  //     stops depending on this process's in-memory cache surviving;
  //   - the missing ids only, because the composed file becomes OpenCode's
  //     config, which is already >1MB and is handed over as a FILE precisely
  //     because it does not fit in an env var.
  const overlay: Record<string, KortixGatewayModel> = { ...(managed ?? {}) }
  for (const id of missing) {
    const model = managed?.[id] ?? full?.[id]
    if (model) overlay[id] = model
  }
  if (Object.keys(overlay).length === 0) {
    logger.warn('[models] reconcile: missing ids had no live records to write', {
      trigger,
      missing: missing.slice(0, 20),
      ms: Date.now() - startedAt,
    })
    return false
  }

  const written = writeOverlayCatalogFile({
    currentCatalogFile: currentCatalogFile(),
    targetCatalogFile: targetCatalogFile(),
    overlay,
  })
  if (!written) {
    logger.warn('[models] reconcile: could not compose an overlay catalog; nothing changed', {
      trigger,
      missingCount: missing.length,
      ms: Date.now() - startedAt,
    })
    return false
  }
  process.env.KORTIX_LLM_CATALOG_FILE = written
  // OpenCode materializes provider models at process start, so the file alone
  // changes nothing for the process that is already running.
  await opencode.restart()
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget)
  logger.info('[models] reconcile: restarted opencode with the missing selectable models', {
    trigger,
    booted: bootedCount,
    managed: managed ? Object.keys(managed).length : null,
    connected: [...connected],
    fullCatalog: full ? Object.keys(full).length : null,
    pickerRelevant: pickerRelevantModelIds(managed, full, connected).length,
    missing: missing.slice(0, 20),
    missingCount: missing.length,
    catalogFile: written,
    restarted: true,
    ready,
    ms: Date.now() - startedAt,
  })
  return true
}

function bootedProviderModelCount(): number | null {
  // Rewritten on every config build, so it is read at call time: this is the
  // provider map the RUNNING OpenCode holds.
  const ids = configuredProviderModelIds()
  return ids ? ids.size : null
}

/**
 * BOOT reconcile — runs once, before the first prompt is delivered, and is the
 * only call allowed to spend the full-catalog grace window.
 */
let bootReconcileRan = false

export function resetBootReconcileForTests(): void {
  bootReconcileRan = false
}

export async function reconcileSelectableModelsAtBoot(bootMark: (label: string) => void): Promise<void> {
  if (bootReconcileRan) return
  bootReconcileRan = true
  try {
    await runSingleFlight('boot', FULL_CATALOG_RECONCILE_GRACE_MS)
  } catch (err) {
    logger.warn('[models] boot reconcile failed; boot continues on the configured catalog', {
      err: err instanceof Error ? err.message : String(err),
    })
  } finally {
    bootMark('managed-reconcile')
  }
}

async function runSingleFlight(
  trigger: ReconcileTrigger,
  waitForFullCatalogMs: number,
): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = reconcileOnce(trigger, waitForFullCatalogMs)
    .catch((err) => {
      logger.warn('[models] reconcile failed', {
        trigger,
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Re-run the reconcile after boot: an env push whose connected-provider list
 * moved, a `/kortix/refresh`, or a full catalog that landed late.
 *
 * Single-flight and idle-only. A live turn defers it to `noteTurnEnded()`
 * rather than severing work someone is waiting on.
 */
export async function scheduleModelReconcile(trigger: ReconcileTrigger): Promise<boolean> {
  if (!handles) return false
  // Same grace window as boot. Every caller `void`s this — the env route and
  // /kortix/refresh both answer without waiting on it — so the wait is not on
  // anyone's latency budget, and a stale-cache answer here is the difference
  // between registering a newly connected provider's models and not.
  return runSingleFlight(trigger, FULL_CATALOG_RECONCILE_GRACE_MS)
}

/** Called when a turn ends. Runs a reconcile that a live turn had deferred. */
export function noteTurnEnded(): void {
  const trigger = deferredTrigger
  if (!trigger) return
  deferredTrigger = null
  void scheduleModelReconcile(trigger)
}

/**
 * LAST LINE OF DEFENCE — self-heal a `ModelNotFound: kortix/<id>`.
 *
 * Everything above is preventive: it keeps the provider map complete before the
 * turn runs. This one runs AFTER a turn has already died on the exact error, so
 * it must work with no assumptions at all about why the id is missing (a stale
 * env push, a provider connected between the reconcile and the send, a warm box
 * whose fork adoption raced, a self-host gateway that was down at boot).
 *
 * The turn is already over, so the restart severs nothing. The failed prompt is
 * deliberately NOT resent — the user's NEXT send is what this makes work, and
 * an auto-resend would double-bill a turn the user may not want repeated.
 */
export async function selfHealMissingModel(
  err: { name?: string; message?: string } | undefined,
): Promise<boolean> {
  const id = modelNotFoundId(err)
  if (!id) return false
  const current = handles
  if (!current) return false

  const previous = lastSelfHealAt.get(id)
  if (previous !== undefined && Date.now() - previous < SELF_HEAL_COOLDOWN_MS) {
    logger.warn('[models] self-heal: already attempted for this model recently; not retrying', {
      model: id,
      sinceMs: Date.now() - previous,
    })
    return false
  }
  lastSelfHealAt.set(id, Date.now())

  const { opencode, cfg } = current
  const startedAt = Date.now()
  const baseUrl = process.env.KORTIX_LLM_BASE_URL
  const apiKey = process.env.KORTIX_LLM_API_KEY
  if (!baseUrl || !apiKey) {
    logger.warn('[models] self-heal: no gateway credentials in this sandbox; cannot check', {
      model: id,
    })
    return false
  }
  // FRESH fetches, not the prefetch cache. OpenCode just refused this model,
  // so the cache that fed its provider map is precisely the thing that does not
  // know about it — answering from it would heal nothing. The turn is already
  // over, so a generous budget costs nobody anything.
  const { managed, full } = await fetchLiveCatalogs(baseUrl, apiKey)
  const model = managed?.[id] ?? full?.[id]
  if (!model) {
    logger.warn('[models] self-heal: the gateway does not serve this model either; not restarting', {
      model: id,
      managed: managed ? Object.keys(managed).length : null,
      fullCatalog: full ? Object.keys(full).length : null,
      ms: Date.now() - startedAt,
    })
    return false
  }

  const probe = seams.turnProbe ?? opencodeTurnInFlight
  const turnInFlight = await probe(opencode.getInternalUrl(), cfg.workspace)
  if (turnInFlight !== false) {
    // The failed turn is over, but a DIFFERENT root may have started one.
    logger.warn('[models] self-heal: a turn is live or unreadable; not restarting', {
      model: id,
      turnInFlight,
      ms: Date.now() - startedAt,
    })
    return false
  }

  const written = writeOverlayCatalogFile({
    currentCatalogFile: currentCatalogFile(),
    targetCatalogFile: targetCatalogFile(),
    // Same composition as the boot reconcile: the authoritative managed set,
    // plus the one id OpenCode just refused.
    overlay: { ...(managed ?? {}), [id]: model },
  })
  if (!written) {
    logger.warn('[models] self-heal: could not compose an overlay catalog', { model: id })
    return false
  }
  process.env.KORTIX_LLM_CATALOG_FILE = written
  await opencode.restart()
  const ready = await waitForOpencodeReady(opencode, cfg.projectTarget)
  logger.info(
    '[models] self-heal: registered the model OpenCode refused and restarted; the NEXT send will work',
    { model: id, catalogFile: written, ready, ms: Date.now() - startedAt },
  )
  return true
}

import { logger as appLogger, isLoggingTransportError } from './lib/logger';
import { config } from './config';
import { captureException, flushSentry } from './lib/sentry';
import { initModelPricing, stopModelPricing } from './router/config/model-pricing';
import { runtimeModelCatalog } from './llm-gateway/models/runtime-catalog';
import { warmPipedreamCatalog } from './connectors/pipedream';
import { runtimeAssetsManifest, warmRuntimeChunkIndex } from './runtime-assets/manifest';
import { shutdownAuditEvents } from './shared/audit';
import { primeComposioTransientClassifier } from './shared/composio-transient';
import { primeDaytonaRateLimitClassifier } from './shared/daytona-rate-limit';
import { primeDaytonaTransientClassifier } from './shared/daytona-transient';
import { drainRequests } from './shared/drain';
import {
  runsSingletonWorkers,
  startLeaderElection,
  stopLeaderElection,
} from './shared/leader-election';
import { warnIfPreviewOriginsMissing } from './sandbox-proxy/preview-hosts';
import { maintenanceSetting } from './platform/services/maintenance-setting';
import { handBackClaims } from './projects/surface';
// Loops every API process runs: their timer, start/stop and runWorkerTick call
// live in replica/. The scheduled jobs live in worker/jobs/ and run only on the
// lease holder (bootServices below).
import { startAccessControlCache, stopAccessControlCache } from './replica/access-control-cache';
import { startEventLoopLagSampler, stopEventLoopLagSampler } from './replica/event-loop-lag';
import { startJobWorker, stopJobWorker } from './replica/job-queue';
import { loadManagedLineupAtBoot, startManagedLineupRefresh, stopManagedLineupRefresh } from './replica/managed-lineup';
import { startSessionLifecycleWorker, stopSessionLifecycleWorker } from './replica/session-lifecycle';
import { startTeamsBotTokenRefresh, stopTeamsBotTokenRefresh } from './replica/teams-bot-token-refresh';
import { startTmpReaper, stopTmpReaper } from './replica/tmp-reaper';
import { startTriggerEventPollWorker, stopTriggerEventPollWorker } from './replica/trigger-event-poll';
import { startTunnelService, stopTunnelService } from './replica/tunnel';

// ─── Process-level crash guards ───────────────────────────────────────────────
// A stray rejected promise or throw escaping any fire-and-forget path — the
// dozens of `void (async …)()` provisioning/sweep ticks and the module-load
// `setInterval`s — must never take the whole multi-tenant server down. These run
// asynchronously, so they fire after these handlers are registered. We log +
// report and keep serving; orchestrator-level restart policy is deliberately
// left to the platform. Registering these handlers also overrides the runtime's
// default "crash on unhandled rejection" behavior, so this can only prevent
// crashes, never introduce one.
process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // A logging-transport failure must NEVER be reported through the logging
    // transport (Better Stack) — that re-enqueues, re-overflows, and spirals,
    // which is exactly what took prod down on 2026-06-18. Record it locally and
    // drop it. See logger.ts isLoggingTransportError.
    if (isLoggingTransportError(`${err.message}\n${err.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport rejection', {
        error: err.message,
      });
      return;
    }
    appLogger.error('Unhandled promise rejection', {
      error: err.message,
      stack: err.stack,
    });
    captureException(err, { handler: 'unhandledRejection' });
  } catch {
    // never let the crash guard itself crash the process
  }
});

const UNCAUGHT_LIMIT = 20;
const UNCAUGHT_WINDOW_MS = 5 * 60_000;
const uncaughtAt: number[] = [];

process.on('uncaughtException', (err: Error) => {
  try {
    if (isLoggingTransportError(`${err?.message ?? ''}\n${err?.stack ?? ''}`)) {
      appLogger.localError('Dropped logging-transport exception', {
        error: err?.message ?? String(err),
      });
      return;
    }
    appLogger.error('Uncaught exception', {
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
    captureException(err, { handler: 'uncaughtException' });
    // A task that keeps throwing outside any handler may hold a half-started
    // singleton. Past the limit, drain and exit so ECS starts a clean task.
    const now = Date.now();
    uncaughtAt.push(now);
    while (uncaughtAt.length > 0 && now - uncaughtAt[0]! > UNCAUGHT_WINDOW_MS) uncaughtAt.shift();
    if (uncaughtAt.length >= UNCAUGHT_LIMIT) {
      appLogger.error('Too many uncaught exceptions — shutting down for replacement', {
        count: uncaughtAt.length,
      });
      void shutdown('uncaught-exception-storm');
    }
  } catch {
    // never let the crash guard itself crash the process
  }
});

// Schema readiness gate — blocks DB-dependent requests until push completes.
let schemaReady = false;
// Drain flag — set on SIGTERM/SIGINT so the health check answers 503 and the
// load balancer stops routing new traffic. `shared/drain.ts` then waits for
// in-flight requests (see `runShutdown`).
let draining = false;

// The split's one state change: schemaReady/draining now live here, next to
// the boot and shutdown paths that write them. index.ts's import.meta.main
// block reports schema readiness through markSchemaReady(); the readiness
// handler and the WS gates read the live bindings below.
export { schemaReady, draining };
export function markSchemaReady(): void {
  schemaReady = true;
}

/**
 * Which entry point this process runs.
 *
 * - `api` (`src/index.ts`): behind the load balancer. With the default
 *   `KORTIX_PROCESS_ROLE=all` it also joins the leader election and runs the
 *   scheduled jobs; with `web` it never does.
 * - `worker` (`src/worker.ts`): no load balancer, no WebSockets. It joins the
 *   leader election and runs the scheduled jobs, plus the caches they read.
 */
export type ProcessKind = 'api' | 'worker';
let processKind: ProcessKind = 'api';

/**
 * Boot steps every API process needs before it serves a request or runs a
 * job: the provider error classifiers, model pricing, the managed model lineup
 * and the gateway model catalog. `entry` is false when a test or a tool
 * imports the app without starting it.
 */
export async function prepareProcess(options: { entry: boolean }): Promise<void> {
  // Pre-load the provider SDK error classes, so the synchronous classifiers
  // (`app.onError`, provider retries) have their strongest instanceof signal
  // from the first failure on. Fire-and-forget: each classifier's name /
  // status / message fallbacks cover a failure that throws before these
  // resolve (shared/daytona-rate-limit.ts, daytona-transient.ts,
  // composio-transient.ts).
  void primeDaytonaRateLimitClassifier();
  void primeDaytonaTransientClassifier();
  void primeComposioTransientClassifier();
  // Local REST tests use the bundled model catalog and never contact models.dev.
  if (config.KORTIX_MODEL_PRICING_LIVE_ENABLED !== '0') {
    await initModelPricing().catch((err) =>
      appLogger.error('[startup] Model pricing init failed (will retry in 24h)', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  // Kortix managed models come from Platinum Inference: read the lineup before serving.
  if (options.entry) await loadManagedLineupAtBoot();
  if (config.KORTIX_MODEL_CATALOG_LIVE_ENABLED !== '0') {
    runtimeModelCatalog.start().catch((err) =>
      appLogger.error('[startup] Gateway model catalog init failed (keeping bundled snapshot)', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// Services that run on EVERY process. The access-control cache and the caches
// below serve both requests and jobs. The tunnel, the job queue, the message
// delivery drain and the event polls serve web traffic, so the worker skips
// them: no load balancer routes a WebSocket or a request to it.
async function startReplicaServices(kind: ProcessKind) {
  const serving = kind === 'api';
  warnIfPreviewOriginsMissing(appLogger);
  startEventLoopLagSampler();
  startAccessControlCache();
  if (config.KORTIX_WORKERS_ENABLED) startManagedLineupRefresh();
  if (serving) startTunnelService();
  // Warm the runtime-settings cache BEFORE serving traffic so the admin-panel
  // toggles (warm_snapshot / provider_fallback) are honored from
  // request #1. Without this a fresh pod serves the cold-cache defaults for the
  // first ~30s — which on a deploy let warm_snapshot resolve to the (old hardcoded)
  // ON despite the admin "off", warm-forking a stale seed: the 2026-06-26 opencode
  // wedge. Best-effort: a DB hiccup leaves the fail-safe OFF defaults.
  await import('./platform/services/runtime-settings')
    .then((m) => m.refreshRuntimeSettings())
    .catch(() => {});
  // Warm the instance GitHub identity + git backend caches too — so a
  // self-host instance whose operator just ran the in-app setup flow (rather
  // than `.env`) serves its stored configuration from request #1, not after a
  // 30s TTL.
  await import('./platform/services/github-app-identity')
    .then((m) => m.refreshAppIdentity())
    .catch(() => {});
  await import('./platform/services/managed-git-backend')
    .then((m) => m.refreshGitBackend())
    .catch(() => {});
  // Warm the maintenance config, so a fresh pod serves the stored config from
  // request #1, not the cold-cache default.
  await maintenanceSetting.refresh().catch(() => {});
  // The durable job queue (Capture ingest, held connector calls): every web process runs jobs.
  if (serving && (config.KORTIX_WORKERS_ENABLED || config.KORTIX_JOB_WORKER_ENABLED)) startJobWorker();
  if (config.KORTIX_WORKERS_ENABLED) {
    // Every process stages snapshot/session-boot build contexts and git
    // mirrors in tmpdir, the worker most of all, and can leak them on error
    // paths; sweep stale ones so they don't fill the disk.
    startTmpReaper();
    // Keep the shared Teams bot token warm before the first message.
    startTeamsBotTokenRefresh();
    if (serving) {
      startSessionLifecycleWorker();
      // Kortix-polled app events: every web process checks due streams.
      startTriggerEventPollWorker();
      // Fill the Composio catalogue snapshot, the hidden-toolkit list, the toolkit
      // metadata and the first discovery page in the background, so the first
      // Customize → Connectors view on a fresh replica reads memory instead of
      // waiting ~2 s on Composio round trips. Not awaited: boot never waits on a
      // third party.
      void import('./connectors/composio')
        .then((composio) => composio.warmComposioDiscovery())
        .catch(() => {});
    }
  }
  // A tip-proof read adopts the base tip another process asked the upstream
  // for (config-releases/base-tip.ts) when this mirror holds it: the per-prompt
  // grant read then needs no fetch on a process that has not proven it itself.
  await Promise.all([import('./config-releases/base-tip'), import('./projects/surface')]).then(
    ([tips, projects]) => projects.useSharedTipProof(tips.storedBaseTipProof),
  );
  // Every api process must learn that a base branch moved, not just the one
  // that handled the push — otherwise the turn-start gate answers `current`
  // from a memo resolved before it (shared/pg-broadcast.ts). Awaited because it
  // is one connection and it must be in place before the first turn; it never
  // rejects, and a failure degrades to the memo's TTL.
  await import('./shared/pg-broadcast').then(async (m) => {
    // A box row change NOTIFYs every replica, so a first prompt waiting on this
    // replica re-opens when the box went active on another one. Registered
    // before the LISTEN check: the handler set survives a later retry.
    const { signalSessionRuntimeActive } = await import('./projects/surface');
    m.onSessionChanged(signalSessionRuntimeActive);
    const listening = await m.startConfigBaseMoveBroadcast();
    if (!listening) return;
    const { useDesiredInvalidationTransport } = await import('./projects/lib/turn-start-convergence');
    useDesiredInvalidationTransport(m.configBaseMoveTransport());
    // A base move announced by another process also ends this process's
    // stale-while-revalidate window for page views (projects/git/mirror.ts).
    const { invalidateProjectMirror } = await import('./projects/git/mirror');
    m.configBaseMoveTransport().subscribe(invalidateProjectMirror);
  });
}

// Boot the per-process services, then begin leader election. The lease holder
// runs the scheduled jobs (worker/jobs/index.ts); every other process just
// serves requests. Works with one process (sole leader) or many (exactly one
// leader), and with no DATABASE_URL (self-host single node → sole leader, no
// coordination).
export async function bootServices(kind: ProcessKind = 'api') {
  processKind = kind;
  await startReplicaServices(kind);
  // Only a process that runs the scheduled jobs joins the election. One that
  // runs none but won the lease would become a dead-weight leader, holding it
  // while running nothing and starving the scheduler fleet-wide.
  const runsJobs = kind === 'worker' || config.KORTIX_PROCESS_ROLE === 'all';
  const eligible = runsJobs && config.KORTIX_WORKERS_ENABLED && runsSingletonWorkers();
  if (!runsJobs) {
    appLogger.info('[workers] Web process — the worker service runs the scheduled jobs; not joining leader election');
  } else if (!eligible) {
    appLogger.info(
      config.KORTIX_WORKERS_ENABLED
        ? '[workers] Singleton workers disabled; not joining leader election'
        : '[workers] API-only pod — background workers disabled; not joining leader election',
    );
  }
  // A web process never loads the job modules.
  const jobs = eligible ? await import('./worker/runtime/jobs') : null;
  startLeaderElection(
    {
      onAcquire: () => jobs?.startJobs(),
      onRelease: () => jobs?.stopJobs(),
    },
    { eligible },
  );
  if (kind === 'worker') return;
  // Build the Pipedream catalogue index in the background. Deliberately NOT
  // awaited: the crawl is ~33 requests / ~48s, and readiness must not wait on
  // a third party. Until it lands, the catalogue routes answer from the live
  // paged API (`indexReady: false`), so a cold pod serves correct results the
  // whole time — just without category facets.
  if (config.KORTIX_WORKERS_ENABLED) warmPipedreamCatalog();
  // Hash the sandbox runtime binaries off the request path.
  //
  // `/v1/runtime-assets/manifest` sha256s the CLI (~104 MB) and the agent
  // (~95.6 MB) on its first call and memoizes. Every sandbox polls this route
  // at boot, and a deploy sends the whole fleet at cold replicas at once — so
  // the first caller per replica was paying ~200 MB of hashing inside the 25s
  // request deadline. Measured on dev: the very first post-deploy call returned
  // `503 request_deadline`, and a daemon that gets a 503 skips convergence for
  // that boot entirely (it never throws, by design).
  //
  // Deliberately NOT awaited: readiness must not wait on it, and a request that
  // arrives first simply shares the same in-flight promise.
  void runtimeAssetsManifest().catch(() => {
    // Absent binaries are a legitimate state (a checkout that never built one);
    // the route reports that per component. Nothing to do here.
  });
  // Same reasoning, same shape, for the chunk index: it reads the same ~200 MB
  // and would otherwise be built inside the first converging box's request.
  void warmRuntimeChunkIndex();
}

// Graceful shutdown. ECS sends SIGTERM, then SIGKILL after `stop_timeout` (120 s,
// infra/terraform/modules/ecs-api/variables.tf). The budgets below add up to
// less: 5 s propagation + 85 s request drain + 15 s worker stop and flush.
const DRAIN_PROPAGATION_MS = 5_000;
const DRAIN_BUDGET_MS = 85_000;
const WORKER_STOP_BUDGET_MS = 15_000;
const HARD_EXIT_MS = 112_000;

/** Resolve with `work`'s result, or undefined after `ms`. Never rejects. */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      appLogger.warn('Shutdown step timed out', { step: label, ms });
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let shutdownPromise: Promise<void> | null = null;

/** Idempotent: a second signal waits for the first shutdown. */
export function shutdown(signal: string): Promise<void> {
  shutdownPromise ??= runShutdown(signal);
  return shutdownPromise;
}

async function runShutdown(signal: string): Promise<void> {
  // The health check answers 503 from here on. Nothing below may keep the
  // process past ECS's SIGKILL, so a hard timer ends it first.
  draining = true;
  appLogger.info(`Shutting down gracefully`, { signal });
  setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
  // Stop claiming lifecycle rows now. The leader's slow job stops used to
  // run first, so this replica kept claiming prompts while it waited to die.
  stopSessionLifecycleWorker();
  // Stop claiming queued jobs too; the request drain waits for the ones running.
  stopJobWorker();
  const handBack = handBackClaims()
    .then((count) => count > 0 && appLogger.info('Handed back lifecycle claims', { count }))
    .catch((error) => appLogger.warn('Lifecycle claim hand-back failed', { error }));
  // Releases the lease (a peer takes over at once) and stops the scheduled
  // jobs via onRelease, if this process was the leader. Runs beside the request
  // drain, bounded: a stuck worker stop must not eat the drain or the flush.
  const leaderStop = within(stopLeaderElection(), WORKER_STOP_BUDGET_MS, 'stopLeaderElection');
  // A Claude sign-in this task runs (`claude setup-token`) dies with it: give the
  // member the request drain's budget to paste the code, then fail it as restarted.
  const claudeLogins = within(
    import('./projects/surface').then((m) => m.drainClaudeLogins(DRAIN_BUDGET_MS)),
    DRAIN_BUDGET_MS + 5_000,
    'claude logins',
  );
  // No load balancer routes to the worker, so it has no deregistration to wait for.
  const propagationMs = processKind === 'api' ? DRAIN_PROPAGATION_MS : 0;
  const drained = await drainRequests({ propagationMs, budgetMs: DRAIN_BUDGET_MS });
  if (drained.remaining > 0) {
    appLogger.warn('Request drain budget ended with work in flight', { remaining: drained.remaining });
  }
  await leaderStop;
  await claudeLogins;
  stopModelPricing();
  runtimeModelCatalog.stop();
  stopTunnelService();
  stopAccessControlCache();
  stopManagedLineupRefresh();
  stopTmpReaper();
  stopTriggerEventPollWorker();
  await handBack;
  // A build claim this task holds would block peers until its lease lapses.
  await within(import('./snapshots/build-claim').then((m) => m.releaseAllSnapshotBuilds()), 5_000, 'snapshot claims');
  stopTeamsBotTokenRefresh();
  stopEventLoopLagSampler();
  await import('./shared/pg-broadcast')
    .then((m) => m.stopConfigBaseMoveBroadcast())
    .catch(() => {});
  // Flush observability data last, after the drain: audit rows are buffered off
  // the request path, and requests that finished during the drain wrote some.
  await within(
    Promise.allSettled([shutdownAuditEvents(), appLogger.flush(), flushSentry()]),
    WORKER_STOP_BUDGET_MS,
    'flush',
  );
  process.exit(0);
}

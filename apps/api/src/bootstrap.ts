import { logger as appLogger } from './lib/logger';
import { flushSentry } from './lib/sentry';
import { config } from './config';
import { describeEmailChain } from './lib/email/transport';
import { ensureSchema } from './ensure-schema';
import { runtimeModelCatalog } from './llm-gateway/models/runtime-catalog';
import { initModelPricing, stopModelPricing } from './router/config/model-pricing';
import { runtimeAssetsManifest } from './runtime-assets';
import { warnIfPreviewOriginsMissing } from './sandbox-proxy/preview-hosts';
import { startAccessControlCache, stopAccessControlCache } from './shared/access-control-cache';
import { shutdownAuditEvents } from './shared/audit';
import { primeDaytonaRateLimitClassifier } from './shared/daytona-rate-limit';
import { primeDaytonaTransientClassifier } from './shared/daytona-transient';
import { runsSingletonWorkers, startLeaderElection, stopLeaderElection } from './shared/leader-election';
import { startTunnelService, stopTunnelService } from './tunnel';
import { startTmpReaper, stopTmpReaper } from './snapshots/tmp-reaper';
import { startSessionLifecycleWorker, stopSessionLifecycleWorker } from './projects/session-lifecycle/worker';
import { startActiveTurnRenewal, stopActiveTurnRenewal } from './projects/active-turn-renewal';
import { startProjectMaintenance, stopProjectMaintenance } from './projects/maintenance';
import { startProjectTriggerScheduler, stopProjectTriggerScheduler } from './projects';
import { kickStartupPreBuild } from './snapshots/builder';
import { startSunaMigrationWorker, stopSunaMigrationWorker } from './projects/suna-migration/suna-migration-worker';
import { startProviderTransitionWorker, stopProviderTransitionWorker } from './projects/provider-transition/provider-transition-worker';
import { startAppDeploymentWorker, stopAppDeploymentWorker } from './apps/deployment-worker';
import { startAppIdleReaper, stopAppIdleReaper } from './apps/idle-reaper';
import { startPiWorkerPoolMaintenance, stopPiWorkerPoolMaintenance } from './platform/services/pi-worker-pool';
import { startAuditWebhookWorker, stopAuditWebhookWorker } from './shared/audit-webhooks';
import { startAuditReconciliationWorker, stopAuditReconciliationWorker } from './shared/audit-reconciliation-worker';
import { startProjectSnapshotWorker, stopProjectSnapshotWorker } from './git-proxy/project-snapshot-worker';
import { warmPipedreamCatalog } from './connectors/pipedream';

// === Start Server ===

export function createBootstrap() {
// Schema readiness gate — blocks DB-dependent requests until push completes.
let schemaReady = false;
// Drain flag — set on SIGTERM/SIGINT so the load balancer health check
// stops routing traffic before the process exits. The ECS deregistration
// delay (30s) gives the ALB time to notice the 503s and drain in-flight
// requests.
let draining = false;

// Ensure DB schema exists before starting services that depend on it.
// This is idempotent — safe to run on every startup.
// Services that run on EVERY replica. The access-control cache and tunnel
// service serve request-path needs (per-node caches + the WS acceptor), so they
// must be live on each node behind the load balancer.
async function startReplicaServices() {
  warnIfPreviewOriginsMissing(appLogger);
  startAccessControlCache();
  startTunnelService();
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
  // Every replica stages snapshot/session-boot build contexts in tmpdir and can
  // leak them on error paths; sweep stale ones so they don't fill node disk and
  // trip DiskPressure evictions. Runs on all replicas (not leader-gated).
  startTmpReaper();
  startSessionLifecycleWorker();
  // Fill the Composio catalogue snapshot, the hidden-toolkit list, the toolkit
  // metadata and the first discovery page in the background, so the first
  // Customize → Connectors view on a fresh replica reads memory instead of
  // waiting ~2 s on Composio round trips. Not awaited: boot never waits on a
  // third party.
  void import('./connectors/composio')
    .then((composio) => composio.warmComposioDiscovery())
    .catch(() => {});
  // Every api process must learn that a base branch moved, not just the one
  // that handled the push — otherwise the turn-start gate answers `current`
  // from a memo resolved before it (shared/pg-broadcast.ts). Awaited because it
  // is one connection and it must be in place before the first turn; it never
  // rejects, and a failure degrades to the memo's TTL.
  await import('./shared/pg-broadcast').then(async (m) => {
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

// Singleton background WORKERS — must run on EXACTLY ONE replica at a time
// (the elected leader). On ECS Fargate the API runs as N replicas (prod: min 2,
// up to 10); running these on every replica would double-fire cron triggers
// (N duplicate paid agent sessions + duplicate external side effects) and
// double-run legacy migrations. Leader
// election (shared/leader-election.ts) starts/stops these via onAcquire/onRelease.
// The guard makes start/stop idempotent across leadership flaps.
let singletonWorkersRunning = false;
async function startSingletonWorkers() {
  if (singletonWorkersRunning) return;
  singletonWorkersRunning = true;
  startActiveTurnRenewal();
  startProjectMaintenance();
  startProjectTriggerScheduler();
  // Mint the global platform-default sandbox image once per leadership term so
  // the first session anywhere lands on a cache hit. Idempotent + best-effort;
  // the session-boot graceful path is the lazy fallback if this is skipped.
  kickStartupPreBuild();
  startSunaMigrationWorker();
  // Resume durable sandbox-provider migrations (prepare→verify→activate) that
  // were mid-flight when the API last stopped — a crash at building/ready/
  // activating converges instead of stranding. Safe across replicas (lease CAS).
  startProviderTransitionWorker();
  startAppDeploymentWorker();
  startAppIdleReaper();
  // Pi worker pool (P1.8): keep parked worker boxes at target so pi session
  // creates claim instead of cold-creating. No-op unless
  // KORTIX_PI_WORKER_POOL_TARGET > 0.
  startPiWorkerPoolMaintenance();
  startAuditWebhookWorker();
  startAuditReconciliationWorker();
  // Prebuilt project snapshot archives (S3 config provider). Idle unless
  // KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is set; see git-proxy/project-snapshot.ts.
  startProjectSnapshotWorker();
  // IAM V2 time-bounded grants: tick every 60s, emit one audit event per row
  // that just transitioned to expired. Engine already filters expired rows out
  // of authorize() so correctness doesn't depend on this — it's the audit trail.
  const { startGrantExpirySweeper } = await import('./iam/expiry-sweeper');
  startGrantExpirySweeper();
}
async function stopSingletonWorkers() {
  if (!singletonWorkersRunning) return;
  singletonWorkersRunning = false;
  stopActiveTurnRenewal();
  stopProjectTriggerScheduler();
  stopProjectMaintenance();
  stopSunaMigrationWorker();
  stopProviderTransitionWorker();
  stopAppDeploymentWorker();
  stopAppIdleReaper();
  stopPiWorkerPoolMaintenance();
  await stopAuditWebhookWorker();
  await stopAuditReconciliationWorker();
  await stopProjectSnapshotWorker();
  const { stopGrantExpirySweeper } = await import('./iam/expiry-sweeper');
  stopGrantExpirySweeper();
}

// Boot the per-node services, then begin leader election. The leader runs the
// singleton workers; every other replica just serves requests. Works with one
// replica (sole leader) or many (exactly one leader), and with no DATABASE_URL
// (self-host single node → sole leader, no coordination).
async function bootServices() {
  await startReplicaServices();
  // Only pods that actually run singleton workers join the election. An API-only
  // pod (workers disabled) that won the lease would become a dead-weight leader,
  // holding it while running nothing and starving the scheduler fleet-wide.
  const eligible = runsSingletonWorkers();
  if (!eligible) {
    appLogger.info(
      '[workers] API-only pod — singleton workers disabled; not joining leader election',
    );
  }
  startLeaderElection(
    {
      onAcquire: () => startSingletonWorkers(),
      onRelease: () => stopSingletonWorkers(),
    },
    { eligible },
  );
  // Build the Pipedream catalogue index in the background. Deliberately NOT
  // awaited: the crawl is ~33 requests / ~48s, and readiness must not wait on
  // a third party. Until it lands, the catalogue routes answer from the live
  // paged API (`indexReady: false`), so a cold pod serves correct results the
  // whole time — just without category facets.
  warmPipedreamCatalog();
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
}

// Graceful shutdown
async function shutdown(signal: string) {
  // Set draining flag FIRST so the ALB health check starts returning 503
  // and the load balancer stops routing new requests to this instance.
  // The deregistration_delay (30s) gives in-flight requests time to complete.
  draining = true;
  appLogger.info(`Shutting down gracefully`, { signal });
  // Releases the lease (so a peer takes over immediately instead of waiting out
  // the TTL) and stops the singleton workers via onRelease — but only if this
  // node was the leader. Then stop the per-node services.
  await stopLeaderElection();
  stopModelPricing();
  runtimeModelCatalog.stop();
  stopTunnelService();
  stopAccessControlCache();
  stopTmpReaper();
  stopSessionLifecycleWorker();
  await import('./shared/pg-broadcast')
    .then((m) => m.stopConfigBaseMoveBroadcast())
    .catch(() => {});
  // Flush observability data before exit. The audit queue is drained here
  // because audit rows are buffered off the request path — without this, the
  // last ~250 ms of events would be lost on every SIGTERM (i.e. every rollout).
  await Promise.allSettled([shutdownAuditEvents(), appLogger.flush(), flushSentry()]);
  process.exit(0);
}

// Called by the entry point (`bun run src/index.ts`, which
// is how both `pnpm dev` and the Docker CMD launch it). Guarding behind
// import.meta.main lets tooling and tests `import { app }` to introspect the
// route table without starting the DB schema check, background workers, or
// signal handlers. Does NOT change production boot — there, import.meta.main is true.
async function start() {
  // Pre-load the Daytona SDK's `DaytonaRateLimitError` class so the synchronous
  // `isDaytonaRateLimitError` classifier (on the global `app.onError` hot path)
  // has its strongest instanceof signal available the first time a 429 throws —
  // see shared/daytona-rate-limit.ts. Fire-and-forget: the classifier's
  // name/statusCode/message fallbacks already cover the rare race where a 429
  // throws before this resolves, so we never block startup on it.
  void primeDaytonaRateLimitClassifier();

  // Pre-load the Daytona SDK's `DaytonaTimeoutError` / `DaytonaConnectionError`
  // classes so the synchronous `isDaytonaTransientProviderError` classifier (on
  // the global `app.onError` hot path) has its strongest instanceof signal
  // available the first time a transient gateway / connection / timeout failure
  // throws — see shared/daytona-transient.ts. Fire-and-forget: the classifier's
  // name / statusCode / message fallbacks already cover the rare race where a
  // transient failure throws before this resolves, so we never block startup on
  // it.
  void primeDaytonaTransientClassifier();

  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                  Kortix API Starting                      ║
  ╠═══════════════════════════════════════════════════════════╣
  ║  Port: ${config.PORT.toString().padEnd(49)}║
  ║  Env:  ${config.INTERNAL_KORTIX_ENV.padEnd(49)}║
  ╠═══════════════════════════════════════════════════════════╣
  ║  Services:                                                ║
  ║    /v1/router     (search, LLM, proxy)                    ║
  ║    /v1/billing    (subscriptions, credits, webhooks)       ║
  ║    /v1/platform   (api keys, sandbox version)               ║
  ║    /v1/projects   (Git-backed projects)                    ║
  ║    /v1/setup      (setup & env management)                 ║
  ║    /v1/tunnel     (reverse-tunnel to local machines)         ║
  ║    /v1/p         (sandbox proxy — local + cloud)            ║
  ╠═══════════════════════════════════════════════════════════╣
  ║  Database:   ${config.DATABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
  ║  Supabase:   ${config.SUPABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
  ║  Stripe:     ${config.STRIPE_SECRET_KEY ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
  ║  Billing:    ${(config.KORTIX_BILLING_INTERNAL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
  ║  Tunnel:     ${(config.TUNNEL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
  ║  Providers:  ${config.ALLOWED_SANDBOX_PROVIDERS.join(', ').padEnd(42)}║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  // Local REST tests use the bundled model catalog and never contact models.dev.
  if (process.env.KORTIX_MODEL_PRICING_LIVE_ENABLED !== '0') {
    await initModelPricing().catch((err) =>
      console.error('[startup] Model pricing init failed (will retry in 24h):', err),
    );
  }
  if (process.env.KORTIX_MODEL_CATALOG_LIVE_ENABLED !== '0') {
    runtimeModelCatalog
      .start()
      .catch((err) =>
        console.error('[startup] Gateway model catalog init failed (keeping bundled snapshot):', err),
      );
  }


  // One line an operator can grep for when email "does not work": which
  // providers EMAIL_URL resolved to, and the address mail is sent from. Never
  // prints credentials.
  console.log(`[email] ${describeEmailChain()}`);

  ensureSchema()
    .then(async () => {
      schemaReady = true;
      // Role permissions are rows (kortix.role_permissions), so the
      // boot-time system-role seed + membership-policy backfill from V1
      // are no longer needed. Permissions resolve directly from
      // account_members.account_role and project_members.project_role.
      await bootServices();
    })
    .catch(async (err) => {
      console.error('[startup] ensureSchema failed, starting services anyway:', err);
      schemaReady = true;
      await bootServices();
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

  return { get schemaReady() { return schemaReady; }, get draining() { return draining; }, start, shutdown };
}

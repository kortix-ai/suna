import { logger as appLogger, isLoggingTransportError } from './lib/logger';
import { captureException, flushSentry } from './lib/sentry';
import { stopModelPricing } from './router/config/model-pricing';
import { runtimeModelCatalog } from './llm-gateway/models/runtime-catalog';
import { warmPipedreamCatalog } from './connectors/pipedream';
import { runtimeAssetsManifest, warmRuntimeChunkIndex } from './runtime-assets';
import { shutdownAuditEvents } from './shared/audit';
import {
  runsSingletonWorkers,
  startLeaderElection,
  stopLeaderElection,
} from './shared/leader-election';
import { kickStartupPreBuild } from './snapshots/builder';
import { warnIfPreviewOriginsMissing } from './sandbox-proxy/preview-hosts';
import { maintenanceSetting } from './platform/services/maintenance-setting';
// Every background loop: its timer, start/stop and runWorkerTick call live in workers/.
import { startAccessControlCache, stopAccessControlCache } from './workers/access-control-cache-worker';
import { startActiveTurnRenewal, stopActiveTurnRenewal } from './workers/active-turn-renewal-worker';
import { startAppDeploymentWorker, stopAppDeploymentWorker } from './workers/app-deployment-worker';
import { startAppIdleReaper, stopAppIdleReaper } from './workers/app-idle-reaper-worker';
import { startAuditArchiveWorker, stopAuditArchiveWorker } from './workers/audit-archive-worker';
import { startAuditPartitionWorker, stopAuditPartitionWorker } from './workers/audit-partition-worker';
import {
  startAuditReconciliationWorker,
  stopAuditReconciliationWorker,
} from './workers/audit-reconciliation-worker';
import { startAuditWebhookWorker, stopAuditWebhookWorker } from './workers/audit-webhook-worker';
import { startBillingRotation, stopBillingRotation } from './workers/billing-rotation-worker';
import { startEventLoopLagSampler, stopEventLoopLagSampler } from './workers/event-loop-lag-worker';
import { startProjectMaintenance, stopProjectMaintenance } from './workers/project-maintenance-worker';
import { startProjectSnapshotWorker, stopProjectSnapshotWorker } from './workers/project-snapshot-worker';
import { startProviderTransitionWorker, stopProviderTransitionWorker } from './workers/provider-transition-worker';
import { startSessionLifecycleWorker, stopSessionLifecycleWorker } from './workers/session-lifecycle-worker';
import { handBackClaims } from './projects/surface';
import { startSlackTurnGc, stopSlackTurnGc } from './workers/slack-turn-gc-worker';
import { startSunaMigrationWorker, stopSunaMigrationWorker } from './workers/suna-migration-worker';
import { startTeamsBotTokenRefresh, stopTeamsBotTokenRefresh } from './workers/teams-bot-token-refresh-worker';
import { startTeamsTurnGc, stopTeamsTurnGc } from './workers/teams-turn-gc-worker';
import { startTmpReaper, stopTmpReaper } from './workers/tmp-reaper-worker';
import { startProjectTriggerScheduler, stopProjectTriggerScheduler } from './workers/trigger-scheduler-worker';
import { startTunnelService, stopTunnelService } from './workers/tunnel-worker';

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
  } catch {
    // never let the crash guard itself crash the process
  }
});

// Schema readiness gate — blocks DB-dependent requests until push completes.
let schemaReady = false;
// Drain flag — set on SIGTERM/SIGINT so the load balancer health check
// stops routing traffic before the process exits. The ECS deregistration
// delay (30s) gives the ALB time to notice the 503s and drain in-flight
// requests.
let draining = false;

// The split's one state change: schemaReady/draining now live here, next to
// the boot and shutdown paths that write them. index.ts's import.meta.main
// block reports schema readiness through markSchemaReady(); the readiness
// handler and the WS gates read the live bindings below.
export { schemaReady, draining };
export function markSchemaReady(): void {
  schemaReady = true;
}

// Ensure DB schema exists before starting services that depend on it.
// This is idempotent — safe to run on every startup.
// Services that run on EVERY replica. The access-control cache and tunnel
// service serve request-path needs (per-node caches + the WS acceptor), so they
// must be live on each node behind the load balancer.
async function startReplicaServices() {
  warnIfPreviewOriginsMissing(appLogger);
  startEventLoopLagSampler();
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
  // Warm the maintenance config, so a fresh pod serves the stored config from
  // request #1, not the cold-cache default.
  await maintenanceSetting.refresh().catch(() => {});
  // Every replica stages snapshot/session-boot build contexts in tmpdir and can
  // leak them on error paths; sweep stale ones so they don't fill node disk and
  // trip DiskPressure evictions. Runs on all replicas (not leader-gated).
  startTmpReaper();
  startSessionLifecycleWorker();
  // Keep the shared Teams bot token warm so the first message after a deploy
  // does not wait on login.microsoftonline.com before its live card is posted.
  startTeamsBotTokenRefresh();
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
  startAuditWebhookWorker();
  startAuditReconciliationWorker();
  // Weekly partitions of kortix.audit_events, 8 weeks ahead.
  startAuditPartitionWorker();
  // Archive weeks older than 90 days to S3 (Object Lock) and drop their partitions. Off by default.
  startAuditArchiveWorker();
  // Prebuilt project snapshot archives (S3 config provider). Idle unless
  // KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is set; see git-proxy/project-snapshot.ts.
  startProjectSnapshotWorker();
  // IAM V2 time-bounded grants: tick every 60s, emit one audit event per row
  // that just transitioned to expired. Engine already filters expired rows out
  // of authorize() so correctness doesn't depend on this — it's the audit trail.
  const { startGrantExpirySweeper } = await import('./workers/grant-expiry-worker');
  startGrantExpirySweeper();
  // OAuth housekeeping: expired authorization requests, abandoned self-registered clients.
  const { startOAuthSweeper } = await import('./workers/oauth-sweep-worker');
  startOAuthSweeper();
  // Hourly trial expiry + credit rotations. Idempotent per account and month,
  // so a leadership flap that runs one twice costs a scan, not money.
  startBillingRotation();
  // Close Slack/Teams live cards whose run ended without a reply.
  startSlackTurnGc();
  startTeamsTurnGc();
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
  await stopAuditWebhookWorker();
  await stopAuditReconciliationWorker();
  stopAuditPartitionWorker();
  stopAuditArchiveWorker();
  await stopProjectSnapshotWorker();
  const { stopGrantExpirySweeper } = await import('./workers/grant-expiry-worker');
  stopGrantExpirySweeper();
  const { stopOAuthSweeper } = await import('./workers/oauth-sweep-worker');
  stopOAuthSweeper();
  stopBillingRotation();
  stopSlackTurnGc();
  stopTeamsTurnGc();
}

// Boot the per-node services, then begin leader election. The leader runs the
// singleton workers; every other replica just serves requests. Works with one
// replica (sole leader) or many (exactly one leader), and with no DATABASE_URL
// (self-host single node → sole leader, no coordination).
export async function bootServices() {
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
  // Same reasoning, same shape, for the chunk index: it reads the same ~200 MB
  // and would otherwise be built inside the first converging box's request.
  void warmRuntimeChunkIndex();
}

// Graceful shutdown
export async function shutdown(signal: string) {
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
  // Rows this process still holds go back to the queue now, not after the
  // 10-min lock and grace; the session's next prompt waits behind them.
  await handBackClaims()
    .then((count) => count > 0 && appLogger.info('Handed back lifecycle claims', { count }))
    .catch((error) => appLogger.warn('Lifecycle claim hand-back failed', { error }));
  stopTeamsBotTokenRefresh();
  stopEventLoopLagSampler();
  await import('./shared/pg-broadcast')
    .then((m) => m.stopConfigBaseMoveBroadcast())
    .catch(() => {});
  // Flush observability data before exit. The audit queue is drained here
  // because audit rows are buffered off the request path — without this, the
  // last ~250 ms of events would be lost on every SIGTERM (i.e. every rollout).
  await Promise.allSettled([shutdownAuditEvents(), appLogger.flush(), flushSentry()]);
  process.exit(0);
}

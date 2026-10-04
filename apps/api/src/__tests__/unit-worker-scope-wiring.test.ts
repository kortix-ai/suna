/**
 * Every background job in the API runs its tick as a named worker.
 *
 * A job's tick has no request behind it, so without `runWorkerTick` every row
 * it writes defaults to `actor_type: system, source: api` and never names the
 * job. This guard fails in three ways:
 *
 *  1. a registered worker module stops calling `runWorkerTick('<name>'`;
 *  2. a file in `apps/api/src` starts a `setInterval` and is neither a
 *     registered worker nor a classified non-job timer below;
 *  3. `startSingletonWorkers` / `startReplicaServices` in `bootstrap.ts` starts
 *     something that is neither;
 *  4. a module starts a timer at import time: it then runs on every replica
 *     (not leader-gated) and nothing can stop it.
 *
 * Adding a background job: wrap its tick in `runWorkerTick('<name>', …)` and
 * register it in WORKERS. A timer that only keeps a connection alive or
 * refreshes a cache goes in NOT_WORKERS with the reason.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

/**
 * Worker name → the file whose tick is wrapped in `runWorkerTick('<name>'`.
 * A loop's timer lives in workers/<name>.ts. Four ticks are wrapped in
 * services/ instead, because something other than their timer also runs
 * them: a request kick (app-deployments, pi-worker-pool), a NOTIFY wake
 * (tunnel-rpc-forwarder), or a direct drain call (session-lifecycle).
 * startup-prebuild is a one-shot kick, not a loop.
 */
const WORKERS: Record<string, string> = {
  'active-turn-renewal': 'workers/active-turn-renewal.ts',
  'project-maintenance': 'workers/project-maintenance.ts',
  'trigger-scheduler': 'workers/trigger-scheduler.ts',
  'startup-prebuild': 'services/snapshots/builder.ts',
  'suna-migration': 'workers/suna-migration.ts',
  'provider-transition': 'workers/provider-transition.ts',
  'app-deployments': 'services/apps/deployment-worker.ts',
  'app-idle-reaper': 'workers/app-idle-reaper.ts',
  'pi-worker-pool': 'services/sandboxes/daytona/pi-worker-pool.ts',
  'audit-webhooks': 'workers/audit-webhooks.ts',
  'audit-reconciliation': 'workers/audit-reconciliation.ts',
  'audit-partitions': 'workers/audit-partitions.ts',
  'audit-archive': 'workers/audit-archive.ts',
  'project-snapshots': 'workers/project-snapshots.ts',
  'iam-grant-expiry': 'workers/iam-grant-expiry.ts',
  'oauth-sweep': 'workers/oauth-sweep.ts',
  'session-lifecycle': 'services/sessions/lifecycle/drain.ts',
  'tunnel-cleanup': 'workers/tunnel.ts',
  'tunnel-rpc-forwarder': 'services/tunnel/core/cluster-forwarder.ts',
  'billing-trial-expiry': 'workers/billing-rotation.ts',
  'billing-yearly-rotation': 'workers/billing-rotation.ts',
  'billing-free-tier-rotation': 'workers/billing-rotation.ts',
  'slack-turn-gc': 'workers/slack-turn-gc.ts',
  'teams-turn-gc': 'workers/teams-turn-gc.ts',
};

/** Files with a `setInterval` that is not a background job over tenant state. */
const NOT_WORKERS: Record<string, string> = {
  'services/apps/public-proxy-handler.ts': 'stamps app activity while one proxied request streams; runs inside that request',
  'services/apps/ws-proxy.ts': 'stamps app activity for one open WebSocket; runs inside that connection',
  'workers/teams-bot-token-refresh.ts': 'refreshes the in-memory Teams bot token',
  'workers/event-loop-lag.ts': 'measures event-loop lag',
  'services/llm-gateway/models/runtime-catalog.ts': 'refreshes the in-memory models.dev catalog',
  'services/sessions/session-control-reconciler.ts': 'read-only reconcile of one open session stream',
  'services/sandboxes/provider-transition/provider-transition-service.ts': 'renews a lease inside the provider-transition tick',
  'http/projects/session-stream.ts': 'heartbeat on one open session stream',
  'services/sessions/lifecycle/command-lease.ts':
    'renews the lock of one claimed command while its drain lane or inline create runs',
  'workers/session-lifecycle.ts': 'timer that calls drainSessionLifecycleQueue, which wraps itself',
  'workers/app-deployments.ts': 'timer that calls triggerAppDeploymentWorker, which wraps its tick',
  'workers/pi-worker-pool.ts': 'timer that calls maintainPiWorkerPool, which wraps itself',
  'services/llm-gateway/models/model-pricing.ts': 'refreshes the in-memory model pricing',
  'services/sandbox-proxy/preview-state-page.ts': 'browser JavaScript inside an HTML string',
  'services/sandbox-proxy/ws-proxy.ts': 'keepalive ping on one open preview WebSocket',
  'workers/access-control-cache.ts': 'refreshes the in-memory access-control cache',
  'workers/tmp-reaper.ts': 'deletes stale local tmp directories; no database writes',
};

/** Start calls in bootstrap.ts → the worker they run, or why they are not one. */
const STARTS: Record<string, string> = {
  startActiveTurnRenewal: 'active-turn-renewal',
  startProjectMaintenance: 'project-maintenance',
  startProjectTriggerScheduler: 'trigger-scheduler',
  kickStartupPreBuild: 'startup-prebuild',
  startSunaMigrationWorker: 'suna-migration',
  startProviderTransitionWorker: 'provider-transition',
  startAppDeploymentWorker: 'app-deployments',
  startAppIdleReaper: 'app-idle-reaper',
  startPiWorkerPoolMaintenance: 'pi-worker-pool',
  startAuditWebhookWorker: 'audit-webhooks',
  startAuditReconciliationWorker: 'audit-reconciliation',
  startAuditPartitionWorker: 'audit-partitions',
  startAuditArchiveWorker: 'audit-archive',
  startProjectSnapshotWorker: 'project-snapshots',
  startGrantExpirySweeper: 'iam-grant-expiry',
  startOAuthSweeper: 'oauth-sweep',
  startBillingRotation: 'billing-trial-expiry',
  startSlackTurnGc: 'slack-turn-gc',
  startTeamsTurnGc: 'teams-turn-gc',
  startTeamsBotTokenRefresh: 'not a worker: in-memory Teams bot token',
  startEventLoopLagSampler: 'not a worker: measures this process event-loop lag',
  startSessionLifecycleWorker: 'session-lifecycle',
  startTunnelService: 'tunnel-cleanup',
  startAccessControlCache: 'not a worker: in-memory cache',
  startTmpReaper: 'not a worker: local tmp directories only',
  startConfigBaseMoveBroadcast:
    'not a worker: one LISTEN connection, event-driven, no timer and no tick',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [relative(SRC, path)] : [];
  });
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe('background jobs run as named workers', () => {
  test.each(Object.entries(WORKERS))('%s wraps its tick in runWorkerTick', (name, file) => {
    expect(read(file)).toContain(`runWorkerTick('${name}'`);
  });

  test('every setInterval in apps/api/src is a registered worker or a classified timer', () => {
    const workerFiles = new Set(Object.values(WORKERS));
    const unclassified = sourceFiles(SRC).filter(
      (file) => read(file).includes('setInterval(') && !workerFiles.has(file) && !(file in NOT_WORKERS),
    );
    expect(unclassified).toEqual([]);
  });

  test('every classified timer file still starts a setInterval', () => {
    const stale = Object.keys(NOT_WORKERS).filter((file) => !read(file).includes('setInterval('));
    expect(stale).toEqual([]);
  });

  test('no module starts a timer at import time', () => {
    const atImport = sourceFiles(SRC).filter((file) => /^(?:setInterval|setTimeout)\(/m.test(read(file)));
    expect(atImport).toEqual([]);
  });

  test('everything bootstrap.ts starts on the leader or every replica is classified', () => {
    const bootstrap = read('app/bootstrap.ts');
    const started = ['startSingletonWorkers', 'startReplicaServices'].flatMap((fn) =>
      [...functionBody(bootstrap, fn).matchAll(/\b((?:start|kick)[A-Z]\w*)\(/g)].map((m) => m[1]!),
    );
    expect(started.filter((call) => !(call in STARTS))).toEqual([]);
    for (const worker of Object.values(STARTS)) {
      if (!worker.startsWith('not a worker')) expect(WORKERS[worker]).toBeDefined();
    }
  });
});

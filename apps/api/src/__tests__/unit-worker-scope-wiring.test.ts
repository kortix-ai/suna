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
 *  3. `startSingletonWorkers` / `startReplicaServices` in `index.ts` starts
 *     something that is neither.
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

/** Worker name → the file whose tick is wrapped in `runWorkerTick('<name>'`. */
const WORKERS: Record<string, string> = {
  'active-turn-renewal': 'projects/active-turn-renewal.ts',
  'project-maintenance': 'projects/maintenance.ts',
  'trigger-scheduler': 'projects/lib/triggers.ts',
  'startup-prebuild': 'snapshots/builder.ts',
  'suna-migration': 'projects/suna-migration/suna-migration-worker.ts',
  'provider-transition': 'projects/provider-transition/provider-transition-worker.ts',
  'app-deployments': 'apps/deployment-worker.ts',
  'app-idle-reaper': 'apps/idle-reaper.ts',
  'pi-worker-pool': 'platform/services/pi-worker-pool.ts',
  'audit-webhooks': 'shared/audit-webhooks.ts',
  'audit-reconciliation': 'shared/audit-reconciliation-worker.ts',
  'project-snapshots': 'git-proxy/project-snapshot-worker.ts',
  'iam-grant-expiry': 'iam/expiry-sweeper.ts',
  'session-lifecycle': 'projects/session-lifecycle/drain.ts',
  'tunnel-cleanup': 'tunnel/index.ts',
  'tunnel-rpc-forwarder': 'tunnel/core/cluster-forwarder.ts',
  'billing-trial-expiry': 'billing/index.ts',
  'billing-yearly-rotation': 'billing/index.ts',
  'billing-free-tier-rotation': 'billing/index.ts',
  'slack-turn-gc': 'channels/slack/turn.ts',
  'teams-turn-gc': 'channels/teams/turn.ts',
};

/** Files with a `setInterval` that is not a background job over tenant state. */
const NOT_WORKERS: Record<string, string> = {
  'apps/public-proxy.ts': 'stamps app activity while one proxied request streams; runs inside that request',
  'apps/ws-proxy.ts': 'stamps app activity for one open WebSocket; runs inside that connection',
  'channels/teams-auth.ts': 'refreshes the in-memory Teams bot token',
  'index.ts': 'measures event-loop lag',
  'llm-gateway/models/runtime-catalog.ts': 'refreshes the in-memory models.dev catalog',
  'oauth/index.ts': 'expires in-memory OAuth state',
  'projects/lib/session-control-reconciler.ts': 'read-only reconcile of one open session stream',
  'projects/provider-transition/provider-transition-service.ts': 'renews a lease inside the provider-transition tick',
  'projects/routes/session-stream.ts': 'heartbeat on one open session stream',
  'projects/session-lifecycle/command-lease.ts':
    'renews the lock of one claimed command while its drain lane or inline create runs',
  'projects/session-lifecycle/worker.ts': 'timer that calls drainSessionLifecycleQueue, which wraps itself',
  'router/config/model-pricing.ts': 'refreshes the in-memory model pricing',
  'sandbox-proxy/preview-state-page.ts': 'browser JavaScript inside an HTML string',
  'sandbox-proxy/ws-proxy.ts': 'keepalive ping on one open preview WebSocket',
  'shared/access-control-cache.ts': 'refreshes the in-memory access-control cache',
  'snapshots/tmp-reaper.ts': 'deletes stale local tmp directories; no database writes',
  'tunnel/routes/permission-requests.ts': 'keepalive on one open SSE stream',
};

/** Start calls in index.ts → the worker they run, or why they are not one. */
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
  startProjectSnapshotWorker: 'project-snapshots',
  startGrantExpirySweeper: 'iam-grant-expiry',
  startSessionLifecycleWorker: 'session-lifecycle',
  startTunnelService: 'tunnel-cleanup',
  startAccessControlCache: 'not a worker: in-memory cache',
  startTmpReaper: 'not a worker: local tmp directories only',
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
  if (start < 0) throw new Error(`index.ts has no function ${name}`);
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

  test('everything index.ts starts on the leader or every replica is classified', () => {
    const index = read('index.ts');
    const started = ['startSingletonWorkers', 'startReplicaServices'].flatMap((fn) =>
      [...functionBody(index, fn).matchAll(/\b((?:start|kick)[A-Z]\w*)\(/g)].map((m) => m[1]!),
    );
    expect(started.filter((call) => !(call in STARTS))).toEqual([]);
    for (const worker of Object.values(STARTS)) {
      if (!worker.startsWith('not a worker')) expect(WORKERS[worker]).toBeDefined();
    }
  });
});

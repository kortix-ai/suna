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
 *     (not leader-gated) and nothing can stop it;
 *  5. `bootstrap.ts` starts a loop from a module outside `workers/`: each loop
 *     has one owner of its timer, start/stop and `runWorkerTick` call.
 *
 * Adding a background job: put its timer and start/stop in
 * `workers/<name>-worker.ts`, keep the tick in its domain module, wrap the tick
 * in `runWorkerTick('<name>', …)` and register it in WORKERS. A timer that only keeps a connection alive or
 * refreshes a cache goes in NOT_WORKERS with the reason.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** Worker name → the file whose tick is wrapped in `runWorkerTick('<name>'`. */
const WORKERS: Record<string, string> = {
  'active-turn-renewal': 'workers/active-turn-renewal-worker.ts',
  'project-maintenance': 'workers/project-maintenance-worker.ts',
  'trigger-scheduler': 'workers/trigger-scheduler-worker.ts',
  'startup-prebuild': 'snapshots/builder.ts',
  'provider-transition': 'workers/provider-transition-worker.ts',
  'app-deployments': 'apps/deployment-worker.ts',
  'app-idle-reaper': 'workers/app-idle-reaper-worker.ts',
  'app-keep-alive': 'workers/app-idle-reaper-worker.ts',
  'audit-webhooks': 'workers/audit-webhook-worker.ts',
  'audit-reconciliation': 'workers/audit-reconciliation-worker.ts',
  'audit-partitions': 'workers/audit-partition-worker.ts',
  'audit-archive': 'workers/audit-archive-worker.ts',
  'project-snapshots': 'workers/project-snapshot-worker.ts',
  'iam-grant-expiry': 'workers/grant-expiry-worker.ts',
  'oauth-sweep': 'workers/oauth-sweep-worker.ts',
  'session-lifecycle': 'projects/session-lifecycle/drain.ts',
  'tunnel-cleanup': 'workers/tunnel-worker.ts',
  'tunnel-rpc-forwarder': 'tunnel/core/cluster-forwarder.ts',
  'billing-trial-expiry': 'workers/billing-rotation-worker.ts',
  'billing-yearly-rotation': 'workers/billing-rotation-worker.ts',
  'billing-free-tier-rotation': 'workers/billing-rotation-worker.ts',
  'account-deletion': 'workers/account-deletion-worker.ts',
  'slack-turn-gc': 'workers/slack-turn-gc-worker.ts',
  'teams-turn-gc': 'workers/teams-turn-gc-worker.ts',
};

/** Files with a `setInterval` that is not a background job over tenant state. */
const NOT_WORKERS: Record<string, string> = {
  'apps/public-proxy-handler.ts': 'stamps app activity while one proxied request streams; runs inside that request',
  'apps/ws-proxy.ts': 'stamps app activity for one open WebSocket; runs inside that connection',
  'backends/provision.ts': 'heartbeat of one backend provision or operation; runs inside it (keepAlive)',
  'llm-gateway/models/runtime-catalog.ts': 'refreshes the in-memory models.dev catalog',
  'projects/lib/session-control-reconciler.ts': 'read-only reconcile of one open session stream',
  'projects/provider-transition/provider-transition-service.ts': 'renews a lease inside the provider-transition tick',
  'projects/routes/session-stream.ts': 'heartbeat on one open session stream',
  'projects/session-lifecycle/command-lease.ts':
    'renews the lock of one claimed command while its drain lane or inline create runs',
  'router/config/model-pricing.ts': 'refreshes the in-memory model pricing',
  'sandbox-proxy/ws-proxy.ts': 'keepalive ping on one open preview WebSocket',
  'workers/access-control-cache-worker.ts': 'refreshes the in-memory access-control cache',
  'workers/app-deployment-worker.ts': 'timer that calls triggerAppDeploymentWorker, which wraps itself',
  'workers/event-loop-lag-worker.ts': 'measures event-loop lag',
  'workers/session-lifecycle-worker.ts': 'timer that calls drainSessionLifecycleQueue, which wraps itself',
  'workers/teams-bot-token-refresh-worker.ts': 'refreshes the in-memory Teams bot token',
  'workers/tmp-reaper-worker.ts': 'deletes stale local tmp directories; no database writes',
};

/** Start calls in bootstrap.ts → the worker they run, or why they are not one. */
const STARTS: Record<string, string> = {
  startActiveTurnRenewal: 'active-turn-renewal',
  startProjectMaintenance: 'project-maintenance',
  startProjectTriggerScheduler: 'trigger-scheduler',
  kickStartupPreBuild: 'startup-prebuild',
  startProviderTransitionWorker: 'provider-transition',
  startAppDeploymentWorker: 'app-deployments',
  startAppIdleReaper: 'app-idle-reaper',
  startAuditWebhookWorker: 'audit-webhooks',
  startAuditReconciliationWorker: 'audit-reconciliation',
  startAuditPartitionWorker: 'audit-partitions',
  startAuditArchiveWorker: 'audit-archive',
  startProjectSnapshotWorker: 'project-snapshots',
  startGrantExpirySweeper: 'iam-grant-expiry',
  startOAuthSweeper: 'oauth-sweep',
  startBillingRotation: 'billing-trial-expiry',
  startAccountDeletionSchedule: 'account-deletion',
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

/** Start calls that are not a loop, so they stay outside workers/. */
const NOT_LOOPS: Record<string, string> = {
  kickStartupPreBuild: 'one-shot per leadership term; no timer',
  startConfigBaseMoveBroadcast: 'one LISTEN connection; no timer',
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

/** Every start/kick call in startSingletonWorkers and startReplicaServices. */
function bootstrapStarts(): string[] {
  const bootstrap = read('bootstrap.ts');
  return ['startSingletonWorkers', 'startReplicaServices'].flatMap((fn) =>
    [...functionBody(bootstrap, fn).matchAll(/\b((?:start|kick)[A-Z]\w*)\(/g)].map((m) => m[1]!),
  );
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
    const started = bootstrapStarts();
    expect(started.filter((call) => !(call in STARTS))).toEqual([]);
    for (const worker of Object.values(STARTS)) {
      if (!worker.startsWith('not a worker')) expect(WORKERS[worker]).toBeDefined();
    }
  });

  test('bootstrap.ts imports every loop it starts from workers/', () => {
    const bootstrap = read('bootstrap.ts');
    const started = bootstrapStarts();
    const outside = started
      .filter((call) => !(call in NOT_LOOPS))
      .filter((call) => {
        const from = new RegExp(
          `import \\{[^}]*\\b${call}\\b[^}]*\\} from '([^']+)'|\\{ ${call} \\} = await import\\('([^']+)'\\)`,
        ).exec(bootstrap);
        return !(from?.[1] ?? from?.[2])?.startsWith('./workers/');
      });
    expect(outside).toEqual([]);
  });
});

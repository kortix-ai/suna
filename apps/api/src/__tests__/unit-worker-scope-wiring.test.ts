/**
 * Every background job in the API runs its tick as a named worker, and every
 * scheduled job runs only on the lease holder (the worker service in production).
 *
 * A job's tick has no request behind it, so without `runWorkerTick` every row
 * it writes defaults to `actor_type: system, source: api` and never names the
 * job. A scheduled job that runs on every web process runs once per process
 * (N cron fires) and puts its CPU on the autoscaled web servers. This guard
 * fails when:
 *
 *  1. a registered worker module stops calling `runWorkerTick('<name>'`;
 *  2. a file in `apps/api/src` starts a `setInterval` and is neither a
 *     registered worker nor a classified non-job timer below;
 *  3. a module starts a timer at import time: it then runs on every process
 *     and nothing can stop it;
 *  4. a worker is neither a scheduled job in the registry
 *     (`worker/jobs/index.ts`) nor an approved per-process loop (PER_PROCESS);
 *  5. `bootstrap.ts` starts something on every process that is not an
 *     approved per-process loop, or starts a loop from outside `replica/`;
 *  6. a module outside `worker/` and the composition roots imports a job.
 *
 * Adding a scheduled job: put its timer and start/stop in
 * `worker/jobs/<name>.ts`, keep the tick in its domain module, wrap the tick in
 * `runWorkerTick('<name>', …)`, add it to the registry and to WORKERS. A loop
 * every web process must run goes in `replica/` and in PER_PROCESS with the
 * reason it cannot run on one process. A timer that only keeps a connection
 * alive or refreshes a cache goes in NOT_WORKERS with the reason.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** Worker name → the file whose tick is wrapped in `runWorkerTick('<name>'`. */
const WORKERS: Record<string, string> = {
  'active-turn-renewal': 'worker/jobs/active-turn-renewal.ts',
  'project-maintenance': 'worker/jobs/project-maintenance.ts',
  'trigger-scheduler': 'worker/jobs/trigger-scheduler.ts',
  'startup-prebuild': 'snapshots/builder.ts',
  'provider-transition': 'worker/jobs/provider-transition.ts',
  'app-deployments': 'apps/deployment-worker.ts',
  'app-idle-reaper': 'worker/jobs/app-idle-reaper.ts',
  'app-keep-alive': 'worker/jobs/app-idle-reaper.ts',
  'audit-webhooks': 'worker/jobs/audit-webhook.ts',
  'audit-reconciliation': 'worker/jobs/audit-reconciliation.ts',
  'audit-partitions': 'worker/jobs/audit-partition.ts',
  'audit-activity': 'worker/jobs/audit-activity.ts',
  'audit-archive': 'worker/jobs/audit-archive.ts',
  'project-snapshots': 'worker/jobs/project-snapshot.ts',
  'iam-grant-expiry': 'worker/jobs/grant-expiry.ts',
  'approval-expiry': 'worker/jobs/approval-expiry.ts',
  'oauth-sweep': 'worker/jobs/oauth-sweep.ts',
  'session-model-fallback': 'worker/jobs/session-model-fallback.ts',
  'session-lifecycle': 'projects/session-lifecycle/drain.ts',
  'tunnel-cleanup': 'worker/jobs/tunnel-cleanup.ts',
  'tunnel-forward-expiry': 'worker/jobs/tunnel-forward-expiry.ts',
  'tunnel-rpc-forwarder': 'tunnel/core/cluster-forwarder.ts',
  'billing-trial-expiry': 'worker/jobs/billing-rotation.ts',
  'billing-yearly-rotation': 'worker/jobs/billing-rotation.ts',
  'billing-free-tier-rotation': 'worker/jobs/billing-rotation.ts',
  'legal-subprocessor-notices': 'worker/jobs/billing-rotation.ts',
  'account-deletion': 'worker/jobs/account-deletion.ts',
  'slack-turn-gc': 'worker/jobs/slack-turn-gc.ts',
  'teams-turn-gc': 'worker/jobs/teams-turn-gc.ts',
  'job-queue': 'replica/job-queue.ts',
  'trigger-event-poll': 'replica/trigger-event-poll.ts',
  'capture-store-bucket': 'worker/jobs/capture.ts',
  'capture-index-reader': 'worker/jobs/capture.ts',
  'capture-maintenance': 'worker/jobs/capture.ts',
  'capture-events-reader': 'worker/jobs/capture.ts',
  'capture-health': 'worker/jobs/capture-health.ts',
  'drive-conflict-scan': 'worker/jobs/drive.ts',
  'volume-deletions': 'worker/jobs/drive.ts',
  'drive-mount-revocations': 'worker/jobs/drive.ts',
  'notification-digest': 'worker/jobs/notification.ts',
  'session-log-purge': 'worker/jobs/session-log-purge.ts',
  'gateway-spend-backfill': 'worker/jobs/gateway-spend-backfill.ts',
  'residential-proxy-billing': 'worker/jobs/residential-proxy-billing.ts',
};

/**
 * The only workers that run on every web process, and why one process cannot
 * run them. Everything else is a scheduled job: registry only.
 */
const PER_PROCESS: Record<string, string> = {
  'session-lifecycle':
    'message delivery: a request queues a prompt and kicks the drain on its own process; every web process drains the shared queue',
  'job-queue': 'the durable job queue (held connector calls, Capture ingest): any web process claims a job with SKIP LOCKED',
  'trigger-event-poll': 'Kortix-polled app events: every web process claims due streams under a lease',
  'tunnel-rpc-forwarder': 'forwards RPCs to the agents connected to this process: it claims only rows addressed to its own instance id',
};

/** Files with a `setInterval` that is not a background job over tenant state. */
const NOT_WORKERS: Record<string, string> = {
  'apps/public-proxy-handler.ts': 'stamps app activity while one proxied request streams; runs inside that request',
  'apps/ws-proxy.ts': 'stamps app activity for one open WebSocket; runs inside that connection',
  'llm-gateway/models/runtime-catalog.ts': 'refreshes the in-memory models.dev catalog',
  'projects/lib/session-control-reconciler.ts': 'read-only reconcile of one open session stream',
  'projects/provider-transition/provider-transition-service.ts': 'renews a lease inside the provider-transition tick',
  'projects/routes/session-stream.ts': 'heartbeat on one open session stream',
  'projects/session-lifecycle/command-lease.ts':
    'renews the lock of one claimed command while its drain lane or inline create runs',
  'router/config/model-pricing.ts': 'refreshes the in-memory model pricing',
  'sandbox-proxy/ws-proxy.ts': 'keepalive ping on one open preview WebSocket',
  'shared/stream-access-recheck.ts': 're-checks access for one open session stream; runs inside that stream',
  'replica/access-control-cache.ts': 'refreshes the in-memory access-control cache',
  'replica/event-loop-lag.ts': 'measures event-loop lag',
  'replica/managed-lineup.ts': 'refreshes the in-memory managed lineup from Platinum Inference',
  'replica/session-lifecycle.ts': 'timer that calls drainSessionLifecycleQueue, which wraps itself',
  'replica/teams-bot-token-refresh.ts': 'refreshes the in-memory Teams bot token',
  'replica/tmp-reaper.ts': 'deletes stale local tmp directories; no database writes',
  'replica/tunnel.ts': "clears this process's in-memory tunnel rate-limit buckets",
  'worker/jobs/app-deployment.ts': 'timer that calls triggerAppDeploymentWorker, which wraps itself',
  'worker/runtime/heartbeat.ts': 'reports the in-memory tick times as one stdout line; no database writes',
};

/** Start calls in bootstrap.ts's per-process services → the worker they run, or why they are not one. */
const PROCESS_STARTS: Record<string, string> = {
  startEventLoopLagSampler: 'not a worker: measures this process event-loop lag',
  startAccessControlCache: 'not a worker: in-memory cache',
  startManagedLineupRefresh: 'not a worker: in-memory managed lineup',
  startTunnelService: 'tunnel-rpc-forwarder',
  startJobWorker: 'job-queue',
  startTmpReaper: 'not a worker: local tmp directories only',
  startTeamsBotTokenRefresh: 'not a worker: in-memory Teams bot token',
  startSessionLifecycleWorker: 'session-lifecycle',
  startTriggerEventPollWorker: 'trigger-event-poll',
  startConfigBaseMoveBroadcast: 'not a worker: one LISTEN connection, event-driven, no timer and no tick',
};

/** Start calls that are not a loop, so they stay outside replica/. */
const NOT_LOOPS: Record<string, string> = {
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

/** Every start/kick call in startReplicaServices. */
function processStarts(): string[] {
  return [...functionBody(read('bootstrap.ts'), 'startReplicaServices').matchAll(/\b((?:start|kick)[A-Z]\w*)\(/g)].map(
    (m) => m[1]!,
  );
}

// Read from the source: importing the registry would load every job module and the config.
const registryTicks = [...read('worker/jobs/index.ts').matchAll(/ticks: \{([^}]*)\}/g)].flatMap((m) =>
  [...m[1]!.matchAll(/'([^']+)':/g)].map((name) => name[1]!),
);

describe('background jobs run as named workers', () => {
  test.each(Object.entries(WORKERS))('%s wraps its tick in runWorkerTick', (name, file) => {
    expect(read(file)).toContain(`runWorkerTick('${name}'`);
  });

  test('every runWorkerTick name in apps/api/src is a registered worker', () => {
    const names = sourceFiles(SRC).flatMap((file) =>
      [...read(file).matchAll(/runWorkerTick\('([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!),
    );
    expect(names.length).toBeGreaterThan(0);
    expect([...new Set(names)].filter((name) => !(name in WORKERS))).toEqual([]);
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
});

describe('scheduled jobs run only on the lease holder', () => {
  test('every worker is a scheduled job in the registry or an approved per-process loop, never both', () => {
    const unplaced = Object.keys(WORKERS).filter((name) => !registryTicks.includes(name) && !(name in PER_PROCESS));
    const both = Object.keys(PER_PROCESS).filter((name) => registryTicks.includes(name));
    expect(unplaced).toEqual([]);
    expect(both).toEqual([]);
  });

  test('every registry tick name is a registered worker, listed once', () => {
    expect(registryTicks.filter((name) => !(name in WORKERS))).toEqual([]);
    expect(registryTicks.length).toBe(new Set(registryTicks).size);
  });

  test('every job module in worker/jobs/ is in the registry', () => {
    const registry = read('worker/jobs/index.ts');
    const modules = readdirSync(join(SRC, 'worker/jobs'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts')
      .map((file) => file.replace(/\.ts$/, ''));
    expect(modules.filter((name) => !registry.includes(`from './${name}'`))).toEqual([]);
  });

  test('bootstrap.ts starts only approved per-process loops on every process', () => {
    const started = processStarts();
    expect(started.filter((call) => !(call in PROCESS_STARTS))).toEqual([]);
    for (const worker of Object.values(PROCESS_STARTS)) {
      if (!worker.startsWith('not a worker')) expect(PER_PROCESS[worker]).toBeDefined();
    }
  });

  test('bootstrap.ts imports every per-process loop it starts from replica/ and no job module', () => {
    const bootstrap = read('bootstrap.ts');
    const outside = processStarts()
      .filter((call) => !(call in NOT_LOOPS))
      .filter((call) => {
        const from = new RegExp(`import \\{[^}]*\\b${call}\\b[^}]*\\} from '([^']+)'`).exec(bootstrap);
        return !from?.[1]?.startsWith('./replica/');
      });
    expect(outside).toEqual([]);
    expect(bootstrap).not.toMatch(/from '\.\/worker\/jobs/);
  });

  test('no module outside worker/ and the composition roots imports a job', () => {
    const importers = sourceFiles(SRC).filter(
      (file) =>
        !file.startsWith('worker/') &&
        !['bootstrap.ts', 'worker.ts', 'index.ts'].includes(file) &&
        /from '(?:\.\.?\/)+worker\/jobs\b|import\('(?:\.\.?\/)+worker\/jobs\b/.test(read(file)),
    );
    expect(importers).toEqual([]);
  });
});

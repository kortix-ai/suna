import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const config = {
  KORTIX_WORKERS_ENABLED: false,
  KORTIX_PROCESS_ROLE: 'all' as 'all' | 'web',
  KORTIX_JOB_WORKER_ENABLED: false,
};
const started: string[] = [];
const record = (name: string) => () => { started.push(name); };
let handlers: { onAcquire(): Promise<void>; onRelease(): Promise<void> };
let eligible = false;
const originalRejections = process.listeners('unhandledRejection');
const originalExceptions = process.listeners('uncaughtException');
mock.module('../config', () => ({ config }));
mock.module('../lib/logger', () => ({ logger: { info() {}, warn() {}, error() {}, localError() {} }, isLoggingTransportError: () => false }));
mock.module('../lib/sentry', () => ({ captureException() {}, flushSentry: async () => {} }));
mock.module('../router/config/model-pricing', () => ({ initModelPricing: async () => {}, stopModelPricing() {} }));
mock.module('../llm-gateway/models/runtime-catalog', () => ({ runtimeModelCatalog: { start: async () => {}, stop() {} } }));
mock.module('../connectors/pipedream', () => ({ warmPipedreamCatalog: record('warmPipedreamCatalog') }));
mock.module('../connectors/composio', () => ({ warmComposioDiscovery: record('warmComposioDiscovery') }));
mock.module('../runtime-assets', () => ({ runtimeAssetsManifest: async () => {}, warmRuntimeChunkIndex: async () => {} }));
mock.module('../shared/audit', () => ({ shutdownAuditEvents: async () => {} }));
mock.module('../shared/drain', () => ({ drainRequests: async () => ({ remaining: 0 }) }));
mock.module('../shared/leader-election', () => ({
  runsSingletonWorkers: () => config.KORTIX_WORKERS_ENABLED,
  startLeaderElection: (callbacks: typeof handlers, options: { eligible: boolean }) => { handlers = callbacks; eligible = options.eligible; },
  stopLeaderElection: async () => {},
}));
mock.module('../snapshots/builder', () => ({ kickStartupPreBuild: record('kickStartupPreBuild') }));
mock.module('../sandbox-proxy/preview-hosts', () => ({ warnIfPreviewOriginsMissing() {} }));
mock.module('../platform/services/maintenance-setting', () => ({ maintenanceSetting: { refresh: async () => {} } }));
mock.module('../platform/services/runtime-settings', () => ({ refreshRuntimeSettings: async () => {} }));
mock.module('../platform/services/github-app-identity', () => ({ refreshAppIdentity: async () => {} }));
mock.module('../platform/services/managed-git-backend', () => ({ refreshGitBackend: async () => {} }));
mock.module('../worker/runtime/heartbeat', () => ({ startJobHeartbeat: () => ({ stop() {}, report: () => [] }) }));
const broadcast = await import('../shared/pg-broadcast');
mock.module('../shared/pg-broadcast', () => ({
  ...broadcast,
  startConfigBaseMoveBroadcast: async () => false,
  onSessionChanged: record('onSessionChanged'),
}));
mock.module('../config-releases/base-tip', () => ({ storedBaseTipProof: async () => null }));
mock.module('../projects/surface', () => ({
  handBackClaims: async () => 0,
  signalSessionRuntimeActive() {},
  useSharedTipProof() {},
}));

// Every per-process loop bootstrap.ts imports from replica/, and every job the
// registry imports from worker/jobs/, records its start call instead of running.
const importedNames = /import\s*\{([\w,\s]+)\}\s*from\s*'(\.\/[^']+)'/g;
function mockImports(file: string, prefix: string, under: RegExp): void {
  for (const match of readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(importedNames)) {
    if (!under.test(match[2]!)) continue;
    const names = match[1]!.split(',').map((name) => name.trim()).filter(Boolean);
    mock.module(`${prefix}${match[2]!.slice(2)}`, () => Object.fromEntries(names.map((name) => [name, record(name)])));
  }
}
mockImports('../bootstrap.ts', '../', /^\.\/replica\//);
mockImports('../worker/jobs/index.ts', '../worker/jobs/', /^\.\/[\w-]+$/);
const { bootServices } = await import('../bootstrap');

const REPLICA_CONSUMERS = ['startSessionLifecycleWorker', 'startJobWorker', 'startTriggerEventPollWorker', 'warmComposioDiscovery'];
const JOB_STARTS = ['kickStartupPreBuild', 'startActiveTurnRenewal', 'startProjectMaintenance', 'startProjectTriggerScheduler',
  'startDriveWorkers', 'startAccountDeletionSchedule', 'startTunnelCleanup', 'startTunnelForwardExpiry'];

afterEach(async () => {
  await handlers?.onRelease();
  config.KORTIX_WORKERS_ENABLED = false;
  config.KORTIX_PROCESS_ROLE = 'all';
  started.length = 0;
});
afterAll(() => {
  for (const listener of process.listeners('unhandledRejection')) if (!originalRejections.includes(listener)) process.removeListener('unhandledRejection', listener);
  for (const listener of process.listeners('uncaughtException')) if (!originalExceptions.includes(listener)) process.removeListener('uncaughtException', listener);
});

test('API-only boot keeps request services but starts no queued jobs, lifecycle work, pollers, connector warmers, or snapshots', async () => {
  await bootServices('api');
  await Promise.resolve();
  expect(eligible).toBe(false);
  expect(started.sort()).toEqual(['onSessionChanged', 'startAccessControlCache', 'startEventLoopLagSampler', 'startTunnelService']);
  await handlers.onAcquire();
  expect(started).not.toContain('kickStartupPreBuild');
  expect(started).not.toContain('startActiveTurnRenewal');
});

test('role all: the API process runs its replica consumers and, as the lease holder, every scheduled job', async () => {
  config.KORTIX_WORKERS_ENABLED = true;
  await bootServices('api');
  await handlers.onAcquire();
  await Promise.resolve();
  expect(eligible).toBe(true);
  for (const name of [...REPLICA_CONSUMERS, 'startTunnelService', 'startTeamsBotTokenRefresh', 'startTmpReaper',
    'startManagedLineupRefresh', 'warmPipedreamCatalog', ...JOB_STARTS]) expect(started).toContain(name);
});

test('role web: the API process never joins the election and never starts a scheduled job', async () => {
  config.KORTIX_WORKERS_ENABLED = true;
  config.KORTIX_PROCESS_ROLE = 'web';
  await bootServices('api');
  await handlers.onAcquire();
  await Promise.resolve();
  expect(eligible).toBe(false);
  for (const name of [...REPLICA_CONSUMERS, 'startTunnelService']) expect(started).toContain(name);
  for (const name of JOB_STARTS) expect(started).not.toContain(name);
});

test('worker: joins the election, runs every scheduled job, and starts no web-traffic consumer', async () => {
  config.KORTIX_WORKERS_ENABLED = true;
  config.KORTIX_PROCESS_ROLE = 'web'; // copied from the API by mistake: the worker entry ignores it
  await bootServices('worker');
  await handlers.onAcquire();
  await Promise.resolve();
  expect(eligible).toBe(true);
  for (const name of ['startAccessControlCache', 'startEventLoopLagSampler', 'startTmpReaper', 'startTeamsBotTokenRefresh',
    'startManagedLineupRefresh', ...JOB_STARTS]) expect(started).toContain(name);
  for (const name of [...REPLICA_CONSUMERS, 'startTunnelService', 'warmPipedreamCatalog']) expect(started).not.toContain(name);
});

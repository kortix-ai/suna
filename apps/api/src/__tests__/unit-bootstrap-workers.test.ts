import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const config = { KORTIX_WORKERS_ENABLED: false };
const started: string[] = [];
const record = (name: string) => () => { started.push(name); };
let handlers: { onAcquire(): Promise<void>; onRelease(): Promise<void> };
let eligible = false;
const originalRejections = process.listeners('unhandledRejection');
const originalExceptions = process.listeners('uncaughtException');
mock.module('../config', () => ({ config }));
mock.module('../lib/logger', () => ({ logger: { info() {}, warn() {}, error() {}, localError() {} }, isLoggingTransportError: () => false }));
mock.module('../lib/sentry', () => ({ captureException() {}, flushSentry: async () => {} }));
mock.module('../router/config/model-pricing', () => ({ stopModelPricing() {} }));
mock.module('../llm-gateway/models/runtime-catalog', () => ({ runtimeModelCatalog: { stop() {} } }));
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
const broadcast = await import('../shared/pg-broadcast');
mock.module('../shared/pg-broadcast', () => ({
  ...broadcast,
  startConfigBaseMoveBroadcast: async () => false,
  onSessionChanged: record('onSessionChanged'),
}));
mock.module('../projects/surface', () => ({
  handBackClaims: async () => 0,
  signalSessionRuntimeActive() {},
}));

const bootstrap = readFileSync(new URL('../bootstrap.ts', import.meta.url), 'utf8');
const imports = /import\s*\{([\w,\s]+)\}\s*from\s*'(\.\/workers\/[^']+)'|\{([\w,\s]+)\}\s*=\s*await import\('(\.\/workers\/[^']+)'\)/g;
for (const match of bootstrap.matchAll(imports)) {
  const names = (match[1] ?? match[3])!.split(',').map((name) => name.trim()).filter(Boolean);
  const path = `..${(match[2] ?? match[4])!.slice(1)}`;
  mock.module(path, () => Object.fromEntries(names.map((name) => [name, record(name)])));
}
const { bootServices } = await import('../bootstrap');

afterEach(async () => {
  await handlers?.onRelease();
  config.KORTIX_WORKERS_ENABLED = false;
  started.length = 0;
});
afterAll(() => {
  for (const listener of process.listeners('unhandledRejection')) if (!originalRejections.includes(listener)) process.removeListener('unhandledRejection', listener);
  for (const listener of process.listeners('uncaughtException')) if (!originalExceptions.includes(listener)) process.removeListener('uncaughtException', listener);
});

test('API-only boot keeps request services but starts no queued jobs, lifecycle work, pollers, connector warmers, or snapshots', async () => {
  await bootServices();
  await Promise.resolve();
  expect(eligible).toBe(false);
  expect(started.sort()).toEqual(['onSessionChanged', 'startAccessControlCache', 'startEventLoopLagSampler', 'startTunnelService']);
  await handlers.onAcquire();
  expect(started).not.toContain('kickStartupPreBuild');
  expect(started).not.toContain('startActiveTurnRenewal');
});

test('worker-enabled boot starts replica consumers and elected singleton workers', async () => {
  config.KORTIX_WORKERS_ENABLED = true;
  await bootServices();
  await handlers.onAcquire();
  await Promise.resolve();
  expect(eligible).toBe(true);
  for (const worker of ['startSessionLifecycleWorker', 'startJobWorker', 'startTriggerEventPollWorker', 'startTeamsBotTokenRefresh',
    'startTmpReaper', 'startManagedLineupRefresh', 'warmComposioDiscovery', 'warmPipedreamCatalog', 'kickStartupPreBuild',
    'startActiveTurnRenewal', 'startProjectMaintenance', 'startDriveWorkers']) expect(started).toContain(worker);
});

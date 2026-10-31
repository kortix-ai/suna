import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const config = { KORTIX_WORKERS_ENABLED: false };
const started: string[] = [];
const record = (name: string) => () => { started.push(name); };
let handlers: { onAcquire(): Promise<void>; onRelease(): Promise<void> };
let eligible = false;
const originalRejections = process.listeners('unhandledRejection');
const originalExceptions = process.listeners('uncaughtException');
const realConfig = await import('../config');
Object.assign(config, { ...realConfig.config, ...config });
mock.module('../config', () => ({ ...realConfig, config }));
mock.module('../lib/logger', () => ({ logger: { info() {}, warn() {}, error() {}, localError() {} }, isLoggingTransportError: () => false }));
mock.module('../lib/sentry', () => ({ captureException() {}, flushSentry: async () => {} }));
const modelPricing = await import('../router/config/model-pricing');
mock.module('../router/config/model-pricing', () => ({ ...modelPricing, stopModelPricing() {} }));
mock.module('../llm-gateway/models/runtime-catalog', () => ({ runtimeModelCatalog: { stop() {} } }));
const pipedream = await import('../connectors/pipedream');
mock.module('../connectors/pipedream', () => ({ ...pipedream, warmPipedreamCatalog: record('warmPipedreamCatalog') }));
const composio = await import('../connectors/composio');
mock.module('../connectors/composio', () => ({ ...composio, warmComposioDiscovery: record('warmComposioDiscovery') }));
mock.module('../runtime-assets', () => ({ runtimeAssetsManifest: async () => {}, warmRuntimeChunkIndex: async () => {} }));
const audit = await import('../shared/audit');
mock.module('../shared/audit', () => ({ ...audit, shutdownAuditEvents: async () => {} }));
const drain = await import('../shared/drain');
mock.module('../shared/drain', () => ({ ...drain, drainRequests: async () => ({ remaining: 0 }) }));
const leaderElection = await import('../shared/leader-election');
mock.module('../shared/leader-election', () => ({
  ...leaderElection,
  runsSingletonWorkers: () => config.KORTIX_WORKERS_ENABLED,
  startLeaderElection: (callbacks: typeof handlers, options: { eligible: boolean }) => { handlers = callbacks; eligible = options.eligible; },
  stopLeaderElection: async () => {},
}));
const snapshots = await import('../snapshots/builder');
mock.module('../snapshots/builder', () => ({ ...snapshots, kickStartupPreBuild: record('kickStartupPreBuild') }));
const previewHosts = await import('../sandbox-proxy/preview-hosts');
mock.module('../sandbox-proxy/preview-hosts', () => ({ ...previewHosts, warnIfPreviewOriginsMissing() {} }));
mock.module('../platform/services/maintenance-setting', () => ({ maintenanceSetting: { refresh: async () => {} } }));
const runtimeSettings = await import('../platform/services/runtime-settings');
mock.module('../platform/services/runtime-settings', () => ({ ...runtimeSettings, refreshRuntimeSettings: async () => {} }));
const appIdentity = await import('../platform/services/github-app-identity');
mock.module('../platform/services/github-app-identity', () => ({ ...appIdentity, refreshAppIdentity: async () => {} }));
const gitBackend = await import('../platform/services/managed-git-backend');
mock.module('../platform/services/managed-git-backend', () => ({ ...gitBackend, refreshGitBackend: async () => {} }));
const broadcast = await import('../shared/pg-broadcast');
mock.module('../shared/pg-broadcast', () => ({
  ...broadcast,
  startConfigBaseMoveBroadcast: async () => false,
  onSessionChanged: record('onSessionChanged'),
}));
const projects = await import('../projects/surface');
mock.module('../projects/surface', () => ({
  ...projects,
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

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import type { ProviderState } from '../providers';
import type { GitBackedProject } from '../../projects/git';
import type { ReadyImage } from '../last-ready-image';

const scenario = process.argv[2]!;
const desiredName = 'kortix-default-new-content';
const predecessor = 'kortix-default-last-ready';
const desiredHash = 'new-content-hash';
const previousHash = 'last-ready-content-hash';
const shouldBuild = scenario.startsWith('build-') || scenario === 'background-failure';
const shouldFail = scenario.endsWith('-failure');
const physical = new Map<string, ProviderState>([[predecessor, 'active']]);
if (!shouldBuild) physical.set(desiredName, 'active');
const resident = new Set([predecessor]);
const deleted: string[] = [];
const buildHistory: { snapshotName: string; contentHash: string; status: string }[] = [];
const prepareStarted = Promise.withResolvers<void>();
const prepareFinish = Promise.withResolvers<void>();
const published = Promise.withResolvers<void>();
const row = {
  templateId: 'shared-default', projectId: null, slug: 'default', name: 'Default',
  isShared: true, source: 'platform', provider: 'platinum', image: null,
  dockerfilePath: null, entrypoint: null, cpu: 2, memoryGb: 4, diskGb: 20,
  containerRuntime: false, providerState: 'active', providerSnapshotName: predecessor,
  contentHash: previousHash, builtFromCommit: null, swapKey: null,
};

mock.module('../../shared/db', () => ({
  db: {
    select: (projection?: unknown) => ({
      from: () => ({ where: () => ({ limit: async () => projection ? [] : [{ ...row }] }) }),
    }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
      Object.assign(row, values);
    } }) }),
  },
}));

// Static imports would execute before the isolated DB/module mocks are installed.
const templates = await import('../templates');
let currentName = desiredName;
mock.module('../templates', () => ({
  ...templates,
  computeTemplateIdentity: async () => ({
    snapshotName: currentName,
    contentHash: currentName === desiredName ? desiredHash : previousHash,
    shortHash: 'test-hash', runtimeFingerprint: 'test-runtime',
    userDockerfile: 'FROM ubuntu:24.04\n', builtFromCommit: null, swapKey: 'new-swap-key',
  }),
}));
const logs = await import('../builder-log');
mock.module('../builder-log', () => ({
  ...logs,
  openBuildLog: async (input: { snapshotName: string; contentHash: string }) => {
    buildHistory.push({ ...input, status: 'building' });
    return 'build-1';
  },
  closeBuildLogReady: async () => { buildHistory[0]!.status = 'ready'; },
  closeBuildLogFailed: async () => { buildHistory[0]!.status = 'failed'; },
  recentlyBuiltSnapshotNames: async () => new Set<string>(),
}));
const ready = await import('../last-ready-image');
mock.module('../last-ready-image', () => ({
  ...ready,
  readyImageHistory: async (): Promise<ReadyImage[]> => buildHistory
    .filter((image) => image.status === 'ready')
    .map(({ snapshotName, contentHash }) => ({ snapshotName, contentHash })),
}));
const runtime = await import('../runtime-images');
mock.module('../runtime-images', () => ({
  ...runtime,
  ensureMetaSandboxImage: async () => ({ snapshotName: 'meta-test', built: false }),
}));
const { platinumProvider } = await import('../providers/platinum');
platinumProvider.isConfigured = () => true;
platinumProvider.getSnapshotState = async (name) => physical.get(name) ?? 'missing';
platinumProvider.findFirstActiveSnapshot = async (names) => names.find((name) => physical.get(name) === 'active') ?? null;
platinumProvider.buildSnapshot = async (input) => {
  physical.set(input.snapshotName, 'active');
  return { externalTemplateId: 'tpl_new' };
};
platinumProvider.deleteSnapshot = async (name) => {
  deleted.push(name);
  physical.delete(name);
  resident.delete(name);
  if (name === predecessor) published.resolve();
};

let prepareCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/prepare')) {
    prepareCalls += 1;
    assert.match(url, /\/templates\/tpl_new\/prepare$/);
    prepareStarted.resolve();
    if (prepareCalls === 1) {
      return Response.json({ template_id: 'tpl_new', region: 'us-east', state: 'absent', status: 'queued', retry_after_ms: 0 }, { status: 202 });
    }
    await prepareFinish.promise;
    if (shouldFail) return Response.json({ error: 'unavailable' }, { status: 503 });
    const id = scenario === 'identity-mismatch' ? 'tpl_old' : 'tpl_new';
    if (id === 'tpl_new') resident.add(desiredName);
    return Response.json({ template_id: id, region: 'us-east', state: 'ready', status: 'ready' });
  }
  if (url.includes('/v1/templates')) {
    return Response.json([...physical].filter(([, state]) => state === 'active').map(([name]) => ({
      name, state: 'ready', id: name === desiredName ? 'tpl_new' : 'tpl_old',
    })));
  }
  throw new Error(`Unexpected HTTP call: ${url}`);
}) as typeof fetch;

const { preparePlatformDefaultImageInUs, ensureSandboxImage, kickStartupPreBuild } = await import('../builder');
const project: GitBackedProject = { projectId: 'project', repoUrl: '', defaultBranch: '', manifestPath: '' };
const gate = scenario === 'startup-ready'
  ? (kickStartupPreBuild(), published.promise)
  : scenario === 'session-ready'
    ? ensureSandboxImage(project, { provider: 'platinum', source: 'session-start' }).then((image) => {
      assert.equal(image.snapshotName, predecessor, 'new serving APIs must keep using the old default during preparation');
      assert.equal(image.contentHash, previousHash);
      return published.promise;
    })
    : scenario === 'background-failure'
      ? ensureSandboxImage(project, { provider: 'platinum', source: 'manual', accountId: 'account' })
      : preparePlatformDefaultImageInUs();
// Attach a rejection observer before releasing the HTTP response.
const settled = gate.then((value) => ({ value, error: null }), (error: unknown) => ({ value: undefined, error }));
await prepareStarted.promise;

assert.equal(row.providerSnapshotName, predecessor, 'queued preparation must not change the session fallback');
assert.equal(row.contentHash, previousHash);
assert.equal(row.providerState, 'active');
assert.equal(physical.get(predecessor), 'active');
assert.equal(physical.get(desiredName), 'active');
assert.equal(resident.has(desiredName), false, 'home-region active is not US residency');
assert.deepEqual(deleted, []);
assert.equal(buildHistory.some((image) => image.status === 'ready'), false, 'history must not expose the gated image');

// An old serving API can observe/re-record its own exact identity during the gate.
currentName = predecessor;
const oldSession = await ensureSandboxImage(project, { provider: 'platinum', source: 'session-start' });
assert.equal(oldSession.snapshotName, predecessor);
assert.equal(oldSession.contentHash, previousHash);
assert.equal(resident.has(oldSession.snapshotName), true, 'the old image remains physically usable in US');
await templates.recordTemplateBuilt(row.templateId, {
  snapshotName: predecessor, contentHash: previousHash, provider: 'platinum',
});
assert.equal(physical.get(desiredName), 'active', 'legacy re-recording must not reap the in-flight exact image');
currentName = desiredName;

prepareFinish.resolve();
const result = await settled;
if (shouldFail || scenario === 'identity-mismatch') {
  assert(result.error instanceof Error);
  assert.equal(row.providerSnapshotName, predecessor);
  assert.equal(row.contentHash, previousHash, 'an older fallback must never be labeled as the new desired content');
  assert.equal(row.providerState, 'active');
  assert.equal(physical.get(predecessor), 'active');
  assert.equal(resident.has(predecessor), true);
  assert.equal(physical.get(desiredName), 'active', 'failed residency must not destroy the gated image');
  assert.deepEqual(deleted, []);
  assert.equal(buildHistory.some((image) => image.status === 'ready'), false);
} else {
  assert.equal(result.error, null);
  assert.equal(row.providerSnapshotName, desiredName);
  assert.equal(row.contentHash, desiredHash);
  assert.equal(resident.has(desiredName), true, 'publication requires exact US residency');
  assert.equal(physical.has(predecessor), false, 'ready publication permits predecessor reaping');
  if (scenario !== 'startup-ready' && scenario !== 'session-ready') {
    assert(result.value && 'snapshotName' in result.value);
    assert.equal(result.value.snapshotName, desiredName);
    assert.equal(result.value.contentHash, desiredHash);
    assert.equal(result.value.built, shouldBuild);
  }
}

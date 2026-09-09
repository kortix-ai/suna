import { afterEach, expect, mock, spyOn, test } from 'bun:test';

const failure = new Error('SQL parameters include PRIVATE_AGENT_SOURCE');
Object.assign(failure, { cause: { code: '23503' } });
mock.module('../shared/db', () => ({ db: {
  select: () => { throw failure; },
  insert: () => { throw failure; },
} }));
const { readStoredPiRuntimeArtifact, putStoredPiRuntimeArtifact } = await import('./pi-runtime-store');
afterEach(() => mock.restore());

test('failed artifact reads log a database code without source or query parameters', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  expect(await readStoredPiRuntimeArtifact('artifact')).toBeNull();
  expect(warn.mock.calls).toEqual([['[pi-runtime-store] read failed, falling back to a local compile', { code: '23503' }]]);
});

test('failed artifact writes remain optional and never log agent source', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  await putStoredPiRuntimeArtifact({
    artifactKey: 'artifact', projectId: 'project', ref: 'main', sourceSha: 'a'.repeat(40),
    agentName: 'reader', workerBundleSha256: 'b'.repeat(64), sha256: 'c'.repeat(64),
    size: 20, manifest: {}, content: Buffer.from('PRIVATE_AGENT_SOURCE'),
  });
  expect(warn.mock.calls).toEqual([['[pi-runtime-store] publish failed', { code: '23503' }]]);
});

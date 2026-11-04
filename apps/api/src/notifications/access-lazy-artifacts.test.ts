import { expect, mock, test } from 'bun:test';
import { config } from '../config';

let loads = 0;
const unavailable = () => { loads++; throw new Error('Artifact Files dependency unavailable'); };
mock.module('../artifacts/service', unavailable);
mock.module('../drives/service', unavailable);
const { maySeeArtifacts } = await import('./access');

test('empty and flag-off notification access checks do not load Artifact Files dependencies', async () => {
  expect(await maySeeArtifacts('synthetic-user', [])).toEqual(new Set());
  expect(await maySeeArtifacts('synthetic-user', [{ projectMetadata: { experimental: { artifacts: false, artifact_comments: false } } } as Parameters<typeof maySeeArtifacts>[1][number]])).toEqual(new Set());
  expect(loads).toBe(0);
});

test('a live strict Artifact access check still loads its canonical Files visibility dependencies and fails closed', async () => {
  const key = config.PLATINUM_API_KEY;
  config.PLATINUM_API_KEY = 'synthetic-notification-access';
  try { await expect(maySeeArtifacts('synthetic-user', [{ projectMetadata: { experimental: { artifacts: true, artifact_comments: true } } } as Parameters<typeof maySeeArtifacts>[1][number]], true))
    .rejects.toThrow('Artifact Files dependency unavailable');
  expect(loads).toBeGreaterThan(0);
  } finally { config.PLATINUM_API_KEY = key; }
});

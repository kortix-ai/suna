import { expect, test } from 'bun:test';
import { MIN_STALE_AFTER_MS } from '../runtime/job';
import { JOBS } from '.';

test('every job tick declares a stale limit of at least 10 minutes; only the one-shot startup build has none', () => {
  const limits = JOBS.flatMap((job) => Object.entries(job.ticks));
  expect(limits.filter(([, limit]) => limit === null).map(([name]) => name)).toEqual(['startup-prebuild']);
  expect(limits.filter(([, limit]) => limit !== null && limit < MIN_STALE_AFTER_MS)).toEqual([]);
});

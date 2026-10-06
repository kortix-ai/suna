import { afterEach, expect, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import { configureKortix } from '../http/config';
import { fetchProjectArchive } from './projects-client/files';
import { fetchCostExportCsv } from './projects-client/session-costs';
import { getAllVersions, getFullChangelog } from './platform-client/updates';

// Binary downloads and the version endpoints used a bare `fetch`: no deadline,
// no 401 replay, a plain `Error`. They go through `send()` like every call.

let seenAuth: Array<string | null> = [];
let statuses: number[] = [];

function configure(tokens: string[]) {
  seenAuth = [];
  const queue = [...tokens];
  const getToken = Object.assign(async () => queue[0] ?? null, {
    invalidate: () => {
      if (queue.length > 1) queue.shift();
    },
  });
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken,
    fetch: async (_input, init) => {
      seenAuth.push(new Headers(init?.headers).get('authorization'));
      const status = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? 200);
      return new Response(status === 200 ? '{"changelog":[]}' : 'nope', { status });
    },
  });
}

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

test('fetchProjectArchive replays a 401 once with the fresh token', async () => {
  statuses = [401, 200];
  configure(['old', 'new']);
  await fetchProjectArchive('p1', 'main');
  expect(seenAuth).toEqual(['Bearer old', 'Bearer new']);
});

test('fetchProjectArchive throws an ApiError carrying the status', async () => {
  statuses = [500];
  configure(['tok']);
  const error = await fetchProjectArchive('p1', 'main').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(500);
});

test('fetchCostExportCsv replays a 401 and throws an ApiError with the status', async () => {
  statuses = [401, 200];
  configure(['old', 'new']);
  await fetchCostExportCsv('projects');
  expect(seenAuth).toEqual(['Bearer old', 'Bearer new']);
  statuses = [503];
  const error = await fetchCostExportCsv('projects').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(503);
});

test('the version endpoints send the bearer and throw an ApiError', async () => {
  statuses = [200];
  configure(['tok']);
  await getFullChangelog('stable');
  expect(seenAuth).toEqual(['Bearer tok']);
  statuses = [502];
  const error = await getAllVersions().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(502);
});

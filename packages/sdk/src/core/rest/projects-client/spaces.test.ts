import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createProjectSpace,
  deleteProjectSpace,
  getProjectSpace,
  listProjectSpaces,
  updateProjectSpace,
} from './index';

let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        spaces: [],
        errors: [],
        slug: 'marketing',
        name: 'Marketing',
        description: null,
        agent: null,
        sessions: 'private',
        path: 'kortix-marketing.yaml',
        agents: ['writer'],
        session_count: 0,
        trigger_count: 0,
        can_manage: true,
        ok: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listProjectSpaces gets the collection and returns spaces + errors', async () => {
  const result = await listProjectSpaces('P1');
  expect(last().url).toBe('http://test.local/projects/P1/spaces');
  expect(last().method).toBe('GET');
  expect(result.spaces).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('getProjectSpace gets one space by slug', async () => {
  const result = await getProjectSpace('P1', 'marketing');
  expect(last().url).toBe('http://test.local/projects/P1/spaces/marketing');
  expect(last().method).toBe('GET');
  expect(result.slug).toBe('marketing');
  expect(result.sessions).toBe('private');
});

test('createProjectSpace posts the input body verbatim', async () => {
  await createProjectSpace('P1', {
    name: 'Marketing',
    slug: 'marketing',
    description: 'Campaign work.',
    agent: 'writer',
    sessions: 'shared',
  });
  expect(last().url).toBe('http://test.local/projects/P1/spaces');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    name: 'Marketing',
    slug: 'marketing',
    description: 'Campaign work.',
    agent: 'writer',
    sessions: 'shared',
  });
});

test('updateProjectSpace patches the slug and forwards explicit nulls', async () => {
  await updateProjectSpace('P1', 'marketing', { description: null, agent: null });
  expect(last().url).toBe('http://test.local/projects/P1/spaces/marketing');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ description: null, agent: null });
});

test('deleteProjectSpace deletes by slug', async () => {
  await deleteProjectSpace('P1', 'marketing');
  expect(last().url).toBe('http://test.local/projects/P1/spaces/marketing');
  expect(last().method).toBe('DELETE');
});

test('a slug with a slash-unsafe character is URL-encoded in the path', async () => {
  await getProjectSpace('P1', 'a b');
  expect(last().url).toBe('http://test.local/projects/P1/spaces/a%20b');
});

test('a space carries the agents usable in it beyond the globals', async () => {
  const space = await getProjectSpace('p1', 'marketing');
  // The wire field is `agents: string[]` — owned or referenced names, in file
  // order. An older server omits it; the type still names it so hosts can
  // build the roster as globals + these without a second request.
  const agents: string[] = space.agents ?? [];
  expect(Array.isArray(agents)).toBe(true);
  expect(space.path).toBe('kortix-marketing.yaml');
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  addProjectSubprojectContext,
  createProjectSubproject,
  deleteProjectSubproject,
  getProjectSubproject,
  listProjectSubprojects,
  removeProjectSubprojectContext,
  updateProjectSubproject,
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
        subprojects: [],
        errors: [],
        slug: 'marketing',
        name: 'Marketing',
        description: null,
        instructions: null,
        context: [],
        agent: null,
        sessions: 'private',
        path: 'kortix.yaml#subprojects.marketing',
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

test('listProjectSubprojects gets the collection and returns subprojects + errors', async () => {
  const result = await listProjectSubprojects('P1');
  expect(last().url).toBe('http://test.local/projects/P1/subprojects');
  expect(last().method).toBe('GET');
  expect(result.subprojects).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('getProjectSubproject gets one subproject by slug', async () => {
  const result = await getProjectSubproject('P1', 'marketing');
  expect(last().url).toBe('http://test.local/projects/P1/subprojects/marketing');
  expect(last().method).toBe('GET');
  expect(result.slug).toBe('marketing');
  expect(result.sessions).toBe('private');
});

test('createProjectSubproject posts the input body verbatim', async () => {
  await createProjectSubproject('P1', {
    name: 'Marketing',
    slug: 'marketing',
    description: 'Campaign work.',
    instructions: 'British English.',
    context: ['docs/brand.md'],
    agent: 'writer',
    sessions: 'shared',
  });
  expect(last().url).toBe('http://test.local/projects/P1/subprojects');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    name: 'Marketing',
    slug: 'marketing',
    description: 'Campaign work.',
    instructions: 'British English.',
    context: ['docs/brand.md'],
    agent: 'writer',
    sessions: 'shared',
  });
});

test('updateProjectSubproject patches the slug and forwards explicit nulls', async () => {
  await updateProjectSubproject('P1', 'marketing', { description: null, agent: null });
  expect(last().url).toBe('http://test.local/projects/P1/subprojects/marketing');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ description: null, agent: null });
});

test('deleteProjectSubproject deletes by slug', async () => {
  await deleteProjectSubproject('P1', 'marketing');
  expect(last().url).toBe('http://test.local/projects/P1/subprojects/marketing');
  expect(last().method).toBe('DELETE');
});

test('addProjectSubprojectContext posts path + content to the context route', async () => {
  const result = await addProjectSubprojectContext('P1', 'marketing', {
    path: 'brand.md',
    content: '# Brand\n',
  });
  expect(last().url).toBe('http://test.local/projects/P1/subprojects/marketing/context');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ path: 'brand.md', content: '# Brand\n' });
  expect(result.slug).toBe('marketing');
});

test('removeProjectSubprojectContext deletes with a URL-encoded ?path=', async () => {
  await removeProjectSubprojectContext('P1', 'marketing', '.kortix/subprojects/marketing/a b.md');
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe(
    'http://test.local/projects/P1/subprojects/marketing/context?path=.kortix%2Fsubprojects%2Fmarketing%2Fa+b.md',
  );
});

test('a slug with a slash-unsafe character is URL-encoded in the path', async () => {
  await getProjectSubproject('P1', 'a b');
  expect(last().url).toBe('http://test.local/projects/P1/subprojects/a%20b');
});

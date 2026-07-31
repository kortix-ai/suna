import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  type CreateProjectRepoInput,
  type ProvisionProjectInput,
  getProjectDetail,
  provisionProject,
  provisionProjectWithToken,
} from './projects';

let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  globalThis.fetch = mock(async () => nextResponse()) as unknown as typeof fetch;
});

const opts = { backendUrl: 'http://backend.test/v1', accessToken: 'tok' };
const input = { account_id: 'acc-1', name: 'My First Project', seed_starter: true };

test('GitHub project creation accepts a marketplace project template', () => {
  const createInput: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'support-agent',
    source_item_id: 'kortix-projects:support-agent-kit',
  };

  expect(createInput.source_item_id).toBe('kortix-projects:support-agent-kit');
});

test('CreateProjectRepoInput accepts an optional icon', () => {
  const createInput: CreateProjectRepoInput = {
    account_id: 'acc-1',
    name: 'support-agent',
    icon: '🚀',
  };

  expect(createInput.icon).toBe('🚀');
});

test('returns ok:true with the parsed project on a real 200 body', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result.ok).toBe(true);
  expect(result.ok && result.project.project_id).toBe('proj-1');
});

test('provisionProject applies the caller timeout to slow managed-git provisioning', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  globalThis.fetch = mock(
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ project_id: 'proj-too-late' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            ),
          50,
        );
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  ) as unknown as typeof fetch;

  await expect(
    provisionProject(
      { account_id: 'acc-1', name: 'Slow Project', seed_starter: true },
      { timeout: 5 },
    ),
  ).rejects.toMatchObject({
    code: 'TIMEOUT',
    endpoint: '/projects/provision',
    timeout: 5,
  });
});

// Regression: a 200 whose body has no project_id used to be reported as a
// fake success — the caller would build an unusable `/projects/undefined` path.
test('reports not-ok when the response is 200 but the body has no project_id', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports not-ok when the 200 body is not valid JSON', async () => {
  nextResponse = () => new Response('not json', { status: 200 });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports limitReached on a 403 with the project_limit_reached code', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ code: 'project_limit_reached' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: true });
});

test('returns ok:false without hitting the network when credentials are missing', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = mock(async (...args: unknown[]) => {
    calls.push(args);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const result = await provisionProjectWithToken({ backendUrl: '', accessToken: '' }, input);
  expect(result).toEqual({ ok: false, limitReached: false });
  expect(calls).toHaveLength(0);
});

test('normalizes the provider-neutral default_agent field from legacy project config', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  nextResponse = () =>
    new Response(
      JSON.stringify({
        project: { project_id: 'proj-1' },
        config: {
          open_code_default_agent: 'kortix',
          agents: [],
          commands: [],
          skills: [],
          env: { required: [], optional: [] },
        },
        file_count: 0,
        files: [],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

  const detail = await getProjectDetail('proj-1');

  expect(detail.config.default_agent).toBe('kortix');
  expect(detail.config.open_code_default_agent).toBe('kortix');
});

// getProjectDetail goes through backendApi/unwrap — the same parsing path
// createProject, getProject, and updateProject use to return a KortixProject.
// provisionProjectWithToken (covered above) bypasses backendApi entirely with
// its own explicit-token fetch, so it does not exercise this path.
test('a project response carries the icon through the backendApi/unwrap parsing path', async () => {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'tok',
  });
  nextResponse = () =>
    new Response(
      JSON.stringify({
        project: { project_id: 'proj-1', name: 'Iconic', icon: '🚀' },
        config: {
          open_code_default_agent: null,
          agents: [],
          commands: [],
          skills: [],
          env: { required: [], optional: [] },
        },
        file_count: 0,
        files: [],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

  const detail = await getProjectDetail('proj-1');

  expect(detail.project.icon).toBe('🚀');
});

test('provisionProject sends the icon in the request body', async () => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });

  let sentBody: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ project_id: 'proj-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await provisionProject({ account_id: 'acc-1', name: 'Iconic', icon: '🚀' });

  expect(sentBody).toMatchObject({ icon: '🚀' });
});

test('a project response carries the icon through to KortixProject', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'Iconic', icon: '🚀' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, { ...input, icon: '🚀' });

  expect(result.ok).toBe(true);
  expect(result.ok && result.project.icon).toBe('🚀');
});

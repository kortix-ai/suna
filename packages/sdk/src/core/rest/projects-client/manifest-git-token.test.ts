// Covers two small project-scoped mutations that live in `./projects.ts`
// (manifest validation + git push-token minting) — split into their own file
// because `projects.test.ts` is dedicated to the server-token
// (`provisionProjectWithToken`) idiom, not the standard configureKortix() one.

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getProjectGitToken, validateProjectManifest } from './projects';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('validateProjectManifest posts { raw } and returns the verdict', async () => {
  nextResponse = { status: 200, body: { valid: false, issues: [{ message: 'missing [project]' }] } };
  const result = await validateProjectManifest('P1', 'name = "x"');
  expect(last().url).toContain('/projects/P1/manifest/validate');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ raw: 'name = "x"' });
  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
});

test('getProjectGitToken posts to git-token and returns the push token', async () => {
  nextResponse = { status: 200, body: { push_token: 'tok_abc', repo_id: 'r1', repo_url: 'https://github.com/x/y' } };
  const result = await getProjectGitToken('P1');
  expect(last().url).toContain('/projects/P1/git-token');
  expect(last().method).toBe('POST');
  expect(result.push_token).toBe('tok_abc');
});

test('getProjectGitToken throws on a 409 (BYO project, not managed)', async () => {
  nextResponse = { status: 409, body: { message: 'Project is not a managed repo' } };
  await expect(getProjectGitToken('P1')).rejects.toThrow();
});

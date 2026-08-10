// Covers two small workspace-scoped mutations that live in `./workspaces.ts`
// (manifest validation + git push-token minting) — split into their own file
// because `workspaces.test.ts` is dedicated to the server-token
// (`provisionWorkspaceWithToken`) idiom, not the standard configureKortix() one.

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getWorkspaceGitToken, validateWorkspaceManifest } from './workspaces';

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

test('validateWorkspaceManifest posts { raw } and returns the verdict', async () => {
  nextResponse = { status: 200, body: { valid: false, issues: [{ message: 'missing [workspace]' }] } };
  const result = await validateWorkspaceManifest('P1', 'name = "x"');
  expect(last().url).toContain('/workspaces/P1/manifest/validate');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ raw: 'name = "x"' });
  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
});

test('getWorkspaceGitToken posts to git-token and returns the push token', async () => {
  nextResponse = { status: 200, body: { push_token: 'tok_abc', git_username: 't', repo_id: 'r1', repo_url: 'https://kortix.code.storage/x.git' } };
  const result = await getWorkspaceGitToken('P1');
  expect(last().url).toContain('/workspaces/P1/git-token');
  expect(last().method).toBe('POST');
  expect(result.push_token).toBe('tok_abc');
  const gitUsername: string = result.git_username;
  expect(gitUsername).toBe('t');
});

test('getWorkspaceGitToken throws on a 409 (BYO workspace, not managed)', async () => {
  nextResponse = { status: 409, body: { message: 'Workspace is not a managed repo' } };
  await expect(getWorkspaceGitToken('P1')).rejects.toThrow();
});

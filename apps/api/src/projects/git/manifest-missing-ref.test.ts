import { afterEach, beforeEach, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { installHttpErrors } from '../../http-errors';
import { HTTPException } from 'hono/http-exception';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifestFromRepo } from './files';
import type { GitBackedProject } from './types';

let root: string;
let project: GitBackedProject;
let previousCache: string | undefined;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifest-missing-ref-'));
  previousCache = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  git('init', '--bare', '--initial-branch=main', 'remote.git');
  project = { projectId: crypto.randomUUID(), repoUrl: join(root, 'remote.git'), defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'synthetic' };
});
afterEach(async () => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  await rm(root, { recursive: true, force: true });
});

function app() {
  const server = new OpenAPIHono();
  installHttpErrors(server);
  server.post('/sessions', async (c) => {
    const manifest = await readManifestFromRepo(project, ['kortix.yaml'], undefined, { strictRef: true });
    return c.json({ manifest: manifest?.content ?? null });
  });
  return server;
}

test('an unseeded repository refuses a strict manifest read with an actionable conflict', async () => {
  const response = await app().request('/sessions', { method: 'POST' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'git_ref_not_found', status: 409 });
  await expect(readManifestFromRepo(project, ['kortix.yaml'], undefined, { strictRef: true })).rejects.toThrow("Push a commit to 'main'");
});

test('pushing another branch does not synthesize a permissive manifest for the missing default', async () => {
  git('init', '--initial-branch=other', 'work');
  await writeFile(join(root, 'work', 'kortix.yaml'), 'kortix_version: 2\n');
  git('-C', 'work', 'add', 'kortix.yaml');
  git('-C', 'work', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'seed');
  git('-C', 'work', 'push', project.repoUrl, 'other');
  expect((await app().request('/sessions', { method: 'POST' })).status).toBe(409);
  const found = await readManifestFromRepo(project, ['kortix.yaml'], 'other', { strictRef: true });
  expect(found?.content).toBe('kortix_version: 2\n');
});

test('an existing commit without a manifest still returns absent', async () => {
  git('init', '--initial-branch=main', 'work');
  git('-C', 'work', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'seed');
  git('-C', 'work', 'push', project.repoUrl, 'main');
  expect(await readManifestFromRepo(project, ['kortix.yaml'], undefined, { strictRef: true })).toBeNull();
  const response = await app().request('/sessions', { method: 'POST' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ manifest: null });
});

test('an unavailable repository is not mislabeled as a missing ref', async () => {
  project.repoUrl = join(root, 'not-a-repository.git');
  await expect(readManifestFromRepo(project, ['kortix.yaml'], undefined, { strictRef: true })).rejects.not.toBeInstanceOf(HTTPException);
});

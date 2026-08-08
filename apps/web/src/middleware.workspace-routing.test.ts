import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

interface MiddlewareProof {
  projectRedirect: { status: number; location: string | null };
  unauthenticatedWorkspace: {
    status: number;
    pathname: string;
    redirect: string | null;
  };
  authenticatedWorkspace: { status: number; rewrite: string | null };
}

const run = Bun.spawnSync({
  cmd: ['bun', resolve(import.meta.dir, 'middleware.workspace-routing.harness.ts')],
  cwd: import.meta.dir,
  stdout: 'pipe',
  stderr: 'pipe',
});

if (run.exitCode !== 0) {
  throw new Error(run.stderr.toString() || `middleware harness exited ${run.exitCode}`);
}

const proof = JSON.parse(run.stdout.toString()) as MiddlewareProof;

describe('Workspace middleware routing', () => {
  test('redirects a Project URL to its canonical Workspace URL with query intact', () => {
    expect(proof.projectRedirect).toEqual({
      status: 308,
      location: 'http://localhost/workspaces/w1/sessions/s1?x=1',
    });
  });

  test('redirects an unauthenticated Workspace request to auth', () => {
    expect(proof.unauthenticatedWorkspace).toEqual({
      status: 307,
      pathname: '/auth',
      redirect: '/workspaces/w1?x=1',
    });
  });

  test('rewrites an authenticated Workspace request to the compatibility implementation', () => {
    expect(proof.authenticatedWorkspace).toEqual({
      status: 200,
      rewrite: 'http://localhost/projects/w1?x=1',
    });
  });
});

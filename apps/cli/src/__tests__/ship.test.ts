import { describe, expect, test } from 'bun:test';

import { ApiError, type ApiClient } from '../api/client.ts';
import type { ProjectSummary } from '../api/types.ts';
import {
  authHeaderArgs,
  linkGitHubBackedProject,
  reconcileShippedManifest,
  resolveExistingShipGitTarget,
  resolveProvisionShipGitTarget,
} from '../commands/ship.ts';
import { resolveProjectCloneTarget } from '../commands/projects.ts';

test('managed git auth headers honor the provider-selected username', () => {
  const args = authHeaderArgs('https://kortix.code.storage/demo.git', 'jwt-token', 't');
  expect(args.at(-1)).toStartWith(
    'http.https://kortix.code.storage/.extraheader=Authorization: Basic ',
  );
  const encoded = args.at(-1)?.split('Authorization: Basic ')[1];
  expect(encoded && Buffer.from(encoded, 'base64').toString('utf8')).toBe('t:jwt-token');
});

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: 'proj_1',
    account_id: 'acct_1',
    name: 'Demo',
    repo_url: 'https://github.com/managed-kortix/demo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function recordingClient(
  calls: Array<{ path: string; body: unknown }>,
  linkedProject: ProjectSummary,
): ApiClient {
  return {
    apiBase: 'https://api.kortix.test',
    post: async <T>(path: string, body?: unknown) => {
      calls.push({ path, body });
      return { project: linkedProject } as T;
    },
  } as unknown as ApiClient;
}

describe('GitHub-backed project linking', () => {
  test('uses the projects-mounted route with a GitHub PAT', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedProject(recordingClient(calls, project()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      githubToken: 'github_pat_test',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/projects/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
          github_token: 'github_pat_test',
        },
      },
    ]);
  });

  test('uses the projects-mounted route with the GitHub App', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedProject(recordingClient(calls, project()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/projects/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
        },
      },
    ]);
  });
});

describe('ship git target resolution', () => {
  // A host whose managed git runs on an org-wide PAT cannot export a push token
  // at all (POST /git-token 503s — the token would grant write to every managed
  // repo). Ship must therefore prefer the proxy origin for MANAGED projects
  // too, exactly like clone does; insisting on a minted provider token is what
  // broke `kortix ship` against Kortix Cloud.
  test('first-time managed ship pushes through the proxy origin, not the raw upstream', () => {
    const target = resolveProvisionShipGitTarget({
      ...project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('existing managed ship pushes through the proxy origin', () => {
    const target = resolveExistingShipGitTarget(
      project({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('managed ship falls back to a minted token when the host has no proxy', () => {
    // Proxy off ⇒ the server mirrors repo_url into git_origin_url.
    const raw = 'https://github.com/managed-kortix/demo.git';
    const target = resolveExistingShipGitTarget(
      project({ git_origin_url: raw, metadata: { git: { managed: true } } }),
    );

    expect(target).toEqual({ repoUrl: raw, credentialMode: 'managed-git-token' });
  });

  test('first-time managed ship on a proxy-less host mints a provider token', () => {
    const target = resolveProvisionShipGitTarget({
      ...project({ metadata: { git: { managed: true } } }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('non-managed proxy projects still push through the Kortix git proxy', () => {
    const target = resolveExistingShipGitTarget(
      project({
        repo_url: 'https://github.com/acme/byo.git',
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('plain BYO projects rely on local git credentials', () => {
    const target = resolveExistingShipGitTarget(
      project({
        repo_url: 'https://github.com/acme/byo.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://github.com/acme/byo.git',
      credentialMode: 'none',
    });
  });

  // The regression this whole module exists to prevent: ship and clone drifted
  // apart and ship picked a credential the server can't issue. They resolve
  // from the same function now — assert they agree on every project shape.
  test('ship and clone resolve the same repo URL for every project shape', () => {
    const proxy = 'https://api.kortix.com/v1/git/proj_1.git';
    const shapes: ProjectSummary[] = [
      project({ git_origin_url: proxy, metadata: { git: { managed: true } } }),
      project({ git_origin_url: proxy, metadata: { git: { managed: false } } }),
      project({ metadata: { git: { managed: true } } }),
      project({ repo_url: 'https://github.com/acme/byo.git', metadata: {} }),
    ];

    for (const shape of shapes) {
      const ship = resolveExistingShipGitTarget(shape);
      const clone = resolveProjectCloneTarget(shape, 'kortix_pat_abc');
      expect(clone.repoUrl).toBe(ship.repoUrl);
      expect(clone.needsManagedToken).toBe(ship.credentialMode === 'managed-git-token');
      expect(clone.token).toBe(ship.credentialMode === 'kortix-token' ? 'kortix_pat_abc' : null);
    }
  });
});

test('ship reconciles the remote manifest independently of connector prompts', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = recordingClient(calls, project());

  await reconcileShippedManifest(client, 'proj_1');

  expect(calls).toEqual([
    {
      path: '/connectors/projects/proj_1/connectors/sync',
      body: undefined,
    },
  ]);
});

describe('stale-CLI warning on a 404 from the connector routes', () => {
  function stderrCapture() {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    return {
      chunks,
      restore: () => {
        (process.stderr as unknown as { write: unknown }).write = original;
      },
    };
  }

  function throwingClient(status: number): ApiClient {
    return {
      apiBase: 'https://api.kortix.test',
      post: async () => {
        throw new ApiError(status, `Not Found: ${status}`);
      },
    } as unknown as ApiClient;
  }

  test('a 404 sync tells the user their CLI is out of date and how to fix it', async () => {
    const capture = stderrCapture();
    try {
      // The whole point: it still does not throw. A reconcile failure must never
      // invalidate the git push that already succeeded.
      await reconcileShippedManifest(throwingClient(404), 'proj_1');
    } finally {
      capture.restore();
    }
    const out = capture.chunks.join('');
    expect(out).toContain('404');
    expect(out).toContain('out of date');
    expect(out).toContain('kortix update');
    expect(out).toContain('Connectors were NOT reconciled');
  });

  test('a non-404 failure stays silent — it is transient and the server retries', async () => {
    for (const status of [0, 401, 409, 500, 502, 503]) {
      const capture = stderrCapture();
      try {
        await reconcileShippedManifest(throwingClient(status), 'proj_1');
      } finally {
        capture.restore();
      }
      expect(capture.chunks.join('')).toBe('');
    }
  });

  test('a non-ApiError failure stays silent', async () => {
    const capture = stderrCapture();
    try {
      await reconcileShippedManifest(
        {
          apiBase: 'https://api.kortix.test',
          post: async () => {
            throw new Error('socket hang up');
          },
        } as unknown as ApiClient,
        'proj_1',
      );
    } finally {
      capture.restore();
    }
    expect(capture.chunks.join('')).toBe('');
  });
});

// `kortix ship` scaffolds the folder with `kortix init` and then pushes that
// history with a PLAIN (non-force) push. Server-side seeding is the default now
// (apps/api/src/projects/managed-repo-seed.ts — "a project always has a
// manifest"), so a seeded repo would turn ship's push into a non-fast-forward
// rejection. Ship therefore has to say `seed_starter: false` OUT LOUD; an
// absent flag no longer means "leave it empty", it means "seed it".
//
// Pinned on the source because the failure is silent and remote: the provision
// call still returns 201 and the break only shows up at `git push`.
describe('ship provisioning declares who owns the first commit', () => {
  test('the provision body sends seed_starter:false', async () => {
    const source = await Bun.file(
      new URL('../commands/ship.ts', import.meta.url).pathname,
    ).text();
    const call = source.slice(source.indexOf("client.post<ProvisionResponse>('/projects/provision'"));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toContain('seed_starter: false');
  });
});

// A project always has a manifest. Ship declares `seed_starter: false` — it
// takes responsibility for the first commit — so it must actually HAVE a
// kortix.yaml to push. This used to pass as "a `.kortix/`-only project —
// nothing to verify", which is how a shipped project could end up with no
// declared agents, no skills, and manifest detection falling back to v1.
describe('ship refuses a project with no manifest', () => {
  test('prepareManifest treats a missing kortix.yaml as fatal, and --no-verify does not bypass it', async () => {
    const source = await Bun.file(
      new URL('../commands/ship.ts', import.meta.url).pathname,
    ).text();
    const fn = source.slice(source.indexOf('function prepareManifest'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    // The old escape hatch must be gone.
    expect(body).not.toContain('if (!manifest) return { ok: true, env: empty };');
    // Absence is now fatal.
    expect(body).toContain('if (!manifest) {');
    expect(body).toContain('refusing to ship a project with no manifest');

    // --no-verify waives VALIDATION of a manifest, never its existence: the
    // missing-manifest branch must not be gated on the flag.
    const missingBranch = body.slice(body.indexOf('if (!manifest) {'));
    const refusal = missingBranch.slice(0, missingBranch.indexOf('return { ok: false'));
    expect(refusal).not.toContain('noVerify');
  });
});

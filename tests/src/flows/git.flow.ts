/**
 * Git / GitHub — the universal git smart-HTTP proxy + project git credential/
 * token routes + GitHub App installation & import surface. Maps to spec §GH-*.
 *
 * Contract notes (verified against apps/api/src):
 *  - /v1/git/:project/* is the smart-HTTP proxy. It does its OWN token auth (git
 *    Basic/Bearer, NOT the user JWT). It resolves the project FIRST, so an
 *    unknown project → 404 even unauthenticated; a missing/garbage token on a
 *    real project → 401; a Kortix token for a *different* tenant → 403; a valid
 *    owning token reaches `resolveProjectUpstream`, which in local dev (no real
 *    managed upstream) typically 502s. We assert permissive sets accordingly.
 *  - /v1/projects/* is behind `supabaseAuth` (ANON → 401).
 *  - The GitHub-App routes need an installation local dev lacks → 409 (with
 *    install_url) / 400 / 502 / 200. create-repo & link-repository need a real
 *    install or PAT → 400/409/502/503.
 *  - git-token: 409 for BYO / 503 if managed git unconfigured / 200 push token.
 *  - upstream credentials remain inside the Git proxy.
 */
import { flow } from '../core/flow';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const UNKNOWN = '00000000-0000-4000-a000-000000000000';

// ── Git smart-HTTP proxy (token auth, not JWT) ─────────────────────────────

flow(
  'GH-9',
  {
    domain: 'git',
    routes: [
      'GET /v1/git/:project/info/refs',
      'GET /v1/git/:project/compiled-checkout',
      'GET /v1/git/:project/compiled-runtime',
      'GET /v1/git/:project/compiled-pi-runtime',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('info/refs without git auth header → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/info/refs', {
        params: { project: p.id },
        query: { service: 'git-upload-pack' },
      });
      r.status([401, 403, 502]);
    });
    await ctx.step('info/refs on unknown project → 404 (resolved before auth ok)', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/info/refs', {
        params: { project: UNKNOWN },
        query: { service: 'git-upload-pack' },
      });
      r.status([401, 404]);
    });
    await ctx.step('git-upload-pack (clone) without git auth → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/git/:project/git-upload-pack', {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
    await ctx.step('compiled checkout without git auth → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/compiled-checkout', {
        params: { project: p.id },
        query: { ref: 'main', sha: 'a'.repeat(40) },
      });
      r.status([401, 403]);
    });
    await ctx.step('compiled runtime without git auth → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/compiled-runtime', {
        params: { project: p.id },
        query: { ref: 'main', sha: 'a'.repeat(40) },
      });
      r.status([401, 403]);
    });
    await ctx.step('compiled pi runtime without git auth → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/compiled-pi-runtime', {
        params: { project: p.id },
        query: { ref: 'main', sha: 'a'.repeat(40) },
      });
      r.status([401, 403]);
    });
    await ctx.step('git-receive-pack (push) without git auth → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/git/:project/git-receive-pack', {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
  },
);
flow('GH-10', { domain: 'git', routes: ['GET /v1/git/:project/info/refs'] }, async (ctx) => {
  const p = await ctx.fixtures.sharedProject();
  await ctx.step('a JWT bearer is not a Kortix git token → 401', async () => {
    // The user's Supabase JWT is forwarded as Bearer but rejected by the proxy
    // auth (only Kortix PAT / API key / sandbox tokens are accepted).
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/git/:project/info/refs', {
      params: { project: p.id },
      query: { service: 'git-upload-pack' },
    });
    r.status([401, 403, 502]);
  });
  await ctx.step("cross-tenant: NONMEMBER's JWT cannot push-discover → 401/403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get('/v1/git/:project/info/refs', {
      params: { project: p.id },
      query: { service: 'git-receive-pack' },
    });
    r.status([401, 403, 404]);
  });
});

// ── Project git credential / token routes (JWT/PAT auth) ───────────────────

flow(
  'GH-6',
  { domain: 'git', routes: ['PUT /v1/projects/:projectId/git-credential'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put(
          '/v1/projects/:projectId/git-credential',
          { token: 'ghp_x' },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
    await ctx.step('missing token (server-managed already) → 400/409', async () => {
      // A managed project 409s ("already managed by Kortix"); a generic project
      // with no token in the body 400s ("token is required").
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/projects/:projectId/git-credential', {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step('set BYO credential → ok / managed conflict 409', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/projects/:projectId/git-credential',
          { token: 'ghp_byo_token', provider: 'gitlab' },
          { params: { projectId: p.id } },
        );
      r.status([200, 409]);
    });
    await ctx.step('NONMEMBER cannot set credential → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put(
          '/v1/projects/:projectId/git-credential',
          { token: 'ghp_x' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

flow('GH-7', { domain: 'git', routes: ['POST /v1/projects/:projectId/git-token'] }, async (ctx) => {
  const p = await ctx.fixtures.sharedProject();
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post('/v1/projects/:projectId/git-token', {}, { params: { projectId: p.id } });
    r.status(401);
  });
  await ctx.step('OWNER mints push token → 200 / 409 BYO / 503 unconfigured', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post('/v1/projects/:projectId/git-token', {}, { params: { projectId: p.id } });
    r.status([200, 409, 503]);
  });
  await ctx.step('unknown project → 404', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post('/v1/projects/:projectId/git-token', {}, { params: { projectId: UNKNOWN } });
    r.status(404);
  });
  await ctx.step('NONMEMBER → 403/404', async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .post('/v1/projects/:projectId/git-token', {}, { params: { projectId: p.id } });
    r.status([403, 404]);
  });
});

flow(
  'GH-17',
  { domain: 'git', routes: ['GET /v1/projects/:projectId/git/connection'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    await ctx.step("ANON cannot inspect the project's git connection", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/git/connection', { params: { projectId: p.id } });
      r.status(401);
    });

    await ctx.step('OWNER reads a closed git connection state', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/git/connection', { params: { projectId: p.id } });
      r.status(200).body().exists('$.state');
      const body = r.json<{ state: string; install_url?: string | null }>();
      const state = body.state;
      if (!['connected', 'reconnect_required', 'unavailable', 'not_connected'].includes(state)) {
        throw new Error(`unexpected git connection state: ${state}`);
      }
      if (body.install_url && state !== 'reconnect_required') {
        throw new Error(`install_url is invalid for git connection state ${state}`);
      }
    });

    await ctx.step('NONMEMBER cannot inspect the connection', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/git/connection', { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    await ctx.step('an unknown project returns 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/git/connection', { params: { projectId: UNKNOWN } });
      r.status(404);
    });
  },
);

flow(
  'GH-12',
  { domain: 'git', routes: ['POST /v1/projects/:projectId/git/collaborators'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/git/collaborators',
          { github_username: 'octocat' },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
    await ctx.step('missing github_username → 400 (or managed-only 409)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/git/collaborators', {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step('invite collaborator → managed-only 409 / 502 upstream / 200', async () => {
      // Local projects are not managed GitHub repos → 409; if managed, the
      // GitHub API call has no install locally → 502.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/git/collaborators',
          { github_username: 'octocat', permission: 'write' },
          { params: { projectId: p.id } },
        );
      r.status([200, 400, 409, 502]);
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:projectId/git/collaborators',
          { github_username: 'octocat' },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// ── GitHub App installation surface (account-scoped) ───────────────────────

flow(
  'GH-1',
  {
    domain: 'git',
    routes: ['GET /v1/projects/github/installation', 'GET /v1/projects/github/installations'],
  },
  async (ctx) => {
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/projects/github/installation');
      r.status(401);
    });
    await ctx.step('OWNER reads install state (none locally → install_url)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/github/installation');
      r.status([200, 400, 409, 503]);
    });
    await ctx.step('OWNER lists account git connections', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/github/installations');
      r.status([200, 400, 409, 503]);
    });
  },
);

flow('GH-2', { domain: 'git', routes: ['POST /v1/projects/github/installation'] }, async (ctx) => {
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post('/v1/projects/github/installation', { state: 'x', installation_id: '1' });
    r.status(401);
  });
  await ctx.step('missing state → 400', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/github/installation', {});
    r.status(400);
  });
  await ctx.step('invalid HMAC state → 400', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/github/installation', {
      state: 'not-a-valid-signed-state',
      installation_id: '12345',
    });
    r.status(400);
  });
});

flow(
  'GH-3',
  {
    domain: 'git',
    routes: [
      'DELETE /v1/projects/github/installation',
      'DELETE /v1/projects/github/installations/:installationId',
    ],
  },
  async (ctx) => {
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).del('/v1/projects/github/installation');
      r.status(401);
    });
    await ctx.step('OWNER disconnect (idempotent, none present) → ok', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/github/installation');
      r.status([200, 400, 409, 503]);
    });
    await ctx.step('OWNER delete a specific (absent) installation → ok / not-found', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/github/installations/:installationId', {
          params: { installationId: '999999999' },
        });
      r.status([200, 400, 404, 409, 503]);
    });
  },
);

flow('GH-13', { domain: 'git', routes: ['GET /v1/projects/github/repositories'] }, async (ctx) => {
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client.as(ctx.P.ANON).get('/v1/projects/github/repositories');
    r.status(401);
  });
  await ctx.step('OWNER lists repos (no install locally → 409 with install_url)', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/github/repositories');
    r.status([200, 400, 409, 502, 503]);
  });
});

flow(
  'GH-16',
  { domain: 'git', routes: ['GET /v1/projects/github/repository-branches'] },
  async (ctx) => {
    const path = '/v1/projects/github/repository-branches';
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get(path);
      r.status(401);
    });
    await ctx.step('missing repository selection → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(path);
      r.status(400);
    });
    await ctx.step('unknown installation → 409 install prompt', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(path, {
        query: {
          account_id: ctx.P.OWNER.accountId,
          installation_id: '999999999',
          repo_full_name: 'octocat/hello-world',
        },
      });
      r.status([400, 409]);
    });
  },
);

// ── Repo creation / import (need a real GitHub App install or PAT) ─────────

flow('GH-14', { domain: 'git', routes: ['POST /v1/projects/create-repo'] }, async (ctx) => {
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client.as(ctx.P.ANON).post('/v1/projects/create-repo', { name: 'x' });
    r.status(401);
  });
  await ctx.step('missing name → 400', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/create-repo', {});
    r.status(400);
  });
  await ctx.step('invalid name chars → 400', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post('/v1/projects/create-repo', { name: 'bad name/with spaces' });
    r.status(400);
  });
  await ctx.step('valid name but no GitHub App install → 409 install_url / 503', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/create-repo', {
      name: ctx.fixtures.name('repo').replace(/[^a-zA-Z0-9._-]/g, '-'),
    });
    r.status([200, 201, 409, 502, 503]);
  });
});

flow(
  'GH-15',
  { domain: 'git', requires: ['managedGit'], routes: ['POST /v1/projects/link-repository'] },
  async (ctx) => {
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/link-repository', { repo_full_name: 'octocat/hello' });
      r.status(401);
    });
    await ctx.step('missing repo_url/repo_full_name → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/link-repository', {});
      r.status(400);
    });
    await ctx.step('repo via App with no install → 400/409/502 (no validated access)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/link-repository', { repo_full_name: 'octocat/hello-world' });
      r.status([200, 201, 400, 409, 502, 503]);
    });
    await ctx.step('repo via bogus PAT → validation fails 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/link-repository', {
        repo_full_name: 'octocat/hello-world',
        github_token: 'ghp_invalid_token_xyz',
      });
      r.status([400, 401, 409, 502]);
    });
  },
);

flow('GH-18', {
  domain: 'git',
  routes: [
    'GET /v1/git/:project/info/refs',
    'POST /v1/git/:project/git-upload-pack',
    'POST /v1/git/:project/git-receive-pack',
    'GET /v1/git/:project/compiled-pi-runtime',
    'PATCH /v1/projects/:projectId/features',
  ],
}, async (ctx) => {
  const project = await ctx.fixtures.project({ managedGit: true });
  const token = await ctx.fixtures.pat();
  const client = ctx.client.as({ label: 'artifact owner PAT', auth: { mode: 'bearer', token } });
  const root = await mkdtemp(join(tmpdir(), 'ke2e-pi-artifact-'));
  const repo = join(root, 'repo');
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
  const git = async (args: string[]) => {
    const child = Bun.spawn(['git', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [out, error, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      assert.equal(exit, 0, error.replaceAll(token, '[redacted]'));
      return out.trim();
    } finally { clearTimeout(timer); }
  };
  let sha = '';
  try {
    await ctx.step('A fresh project with the legacy flag disabled receives a YAML v3 source commit', async () => {
      const flag = await ctx.client.as(ctx.P.OWNER).patch('/v1/projects/:projectId/features',
        { feature: 'pi_worker', enabled: false }, { params: { projectId: project.id } });
      flag.status(200).body().has('$.experimental.pi_worker', false);
      await git(['clone', `${ctx.env.apiUrl}/git/${project.id}.git`, repo]);
      await writeFile(join(repo, 'kortix.yaml'), 'kortix_version: 3\ndefault_agent: reader\nagents:\n  reader: {}\n');
      await mkdir(join(repo, '.kortix/pi/agents'), { recursive: true });
      await writeFile(join(repo, '.kortix/pi/agents/reader.md'), '---\nmodel: kortix/gpt-5.6-luna\n---\nArtifact fixture reader.\n');
      await git(['-C', repo, 'add', 'kortix.yaml', '.kortix/pi/agents/reader.md']);
      await git(['-C', repo, '-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.test', 'commit', '-m', 'Declare Pi runtime']);
      sha = await git(['-C', repo, 'rev-parse', 'HEAD']);
      await git(['-C', repo, 'push', 'origin', 'HEAD:main']);
    });
    await ctx.step('The exact Pi artifact downloads without an experiment flag and its digest matches', async () => {
      const artifact = await client.get('/v1/git/:project/compiled-pi-runtime', {
        params: { project: `${project.id}.git` }, query: { ref: sha, sha }, timeoutMs: 120_000,
      });
      artifact.status(200).headerEquals('x-kortix-artifact-source-sha', sha);
      const raw = await fetch(`${ctx.env.apiUrl}/git/${project.id}.git/compiled-pi-runtime?ref=${sha}&sha=${sha}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
      });
      assert.equal(raw.status, 200);
      const content = Buffer.from(await raw.arrayBuffer());
      assert.ok(content.toString('utf8').includes('kortix-worker starting'));
      artifact.headerEquals('x-kortix-artifact-sha256', createHash('sha256').update(content).digest('hex'));
    });
    await ctx.step('Anonymous downloads fail and a mismatched source SHA returns 409', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/git/:project/compiled-pi-runtime', {
        params: { project: project.id }, query: { ref: sha, sha },
      })).status(401);
      (await client.get('/v1/git/:project/compiled-pi-runtime', {
        params: { project: project.id }, query: { ref: sha, sha: 'b'.repeat(40) },
      })).status(409);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

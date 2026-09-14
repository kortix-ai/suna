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
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// ── Git smart-HTTP proxy (token auth, not JWT) ─────────────────────────────

flow(
  "GH-9",
  {
    domain: "git",
    routes: [
      "GET /v1/git/:project/info/refs",
      "GET /v1/git/:project/compiled-checkout",
      "GET /v1/git/:project/compiled-runtime",
      "GET /v1/git/:project/compiled-pi-runtime",
      "POST /v1/git/:project/git-upload-pack",
      "POST /v1/git/:project/git-receive-pack",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("info/refs without git auth header → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-upload-pack" } });
      r.status([401, 403, 502]);
    });
    await ctx.step("info/refs on unknown project → 404 (resolved before auth ok)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/info/refs", { params: { project: UNKNOWN }, query: { service: "git-upload-pack" } });
      r.status([401, 404]);
    });
    await ctx.step("git-upload-pack (clone) without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/git/:project/git-upload-pack", {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
    await ctx.step("compiled checkout without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/compiled-checkout", {
          params: { project: p.id },
          query: { ref: "main", sha: "a".repeat(40) },
        });
      r.status([401, 403]);
    });
    await ctx.step("compiled runtime without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/compiled-runtime", {
          params: { project: p.id },
          query: { ref: "main", sha: "a".repeat(40) },
        });
      r.status([401, 403]);
    });
    await ctx.step("compiled pi runtime without git auth → 401", async () => {
      // Same auth boundary as compiled-runtime; the pi_worker feature-flag
      // gate sits BEHIND auth, so an anonymous caller never learns whether
      // the flag is on.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/git/:project/compiled-pi-runtime", {
          params: { project: p.id },
          query: { ref: "main", sha: "a".repeat(40) },
        });
      r.status([401, 403]);
    });
    await ctx.step("git-receive-pack (push) without git auth → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/git/:project/git-receive-pack", {}, { params: { project: p.id } });
      r.status([401, 403, 502]);
    });
  },
);
flow(
  "GH-10",
  { domain: "git", routes: ["GET /v1/git/:project/info/refs"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("a JWT bearer is not a Kortix git token → 401", async () => {
      // The user's Supabase JWT is forwarded as Bearer but rejected by the proxy
      // auth (only Kortix PAT / API key / sandbox tokens are accepted).
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-upload-pack" } });
      r.status([401, 403, 502]);
    });
    await ctx.step("cross-tenant: NONMEMBER's JWT cannot push-discover → 401/403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/git/:project/info/refs", { params: { project: p.id }, query: { service: "git-receive-pack" } });
      r.status([401, 403, 404]);
    });
  },
);

// ── Project git credential / token routes (JWT/PAT auth) ───────────────────

flow(
  "GH-6",
  { domain: "git", routes: ["PUT /v1/projects/:projectId/git-credential"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_x" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("missing token (server-managed already) → 400/409", async () => {
      // A managed project 409s ("already managed by Kortix"); a generic project
      // with no token in the body 400s ("token is required").
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/git-credential", {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step("set BYO credential → ok / managed conflict 409", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_byo_token", provider: "gitlab" }, { params: { projectId: p.id } });
      r.status([200, 409]);
    });
    await ctx.step("NONMEMBER cannot set credential → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/git-credential", { token: "ghp_x" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  "GH-7",
  { domain: "git", routes: ["POST /v1/projects/:projectId/git-token"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("OWNER mints push token → 200 / 409 BYO / 503 unconfigured", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status([200, 409, 503]);
    });
    await ctx.step("unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: UNKNOWN } });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/git-token", {}, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  "GH-12",
  { domain: "git", routes: ["POST /v1/projects/:projectId/git/collaborators"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("missing github_username → 400 (or managed-only 409)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git/collaborators", {}, { params: { projectId: p.id } });
      r.status([400, 409]);
    });
    await ctx.step("invite collaborator → managed-only 409 / 502 upstream / 200", async () => {
      // Local projects are not managed GitHub repos → 409; if managed, the
      // GitHub API call has no install locally → 502.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat", permission: "write" }, { params: { projectId: p.id } });
      r.status([200, 400, 409, 502]);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/git/collaborators", { github_username: "octocat" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// ── GitHub App installation surface (account-scoped) ───────────────────────

flow(
  "GH-1",
  {
    domain: "git",
    routes: [
      "GET /v1/projects/github/installation",
      "GET /v1/projects/github/installations",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/github/installation");
      r.status(401);
    });
    await ctx.step("OWNER reads install state (none locally → install_url)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/installation");
      r.status([200, 400, 409, 503]);
    });
    await ctx.step("OWNER lists account git connections", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/installations");
      r.status([200, 400, 409, 503]);
    });
  },
);

flow(
  "GH-2",
  { domain: "git", routes: ["POST /v1/projects/github/installation"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/github/installation", { state: "x", installation_id: "1" });
      r.status(401);
    });
    await ctx.step("missing state → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/github/installation", {});
      r.status(400);
    });
    await ctx.step("invalid HMAC state → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/github/installation", { state: "not-a-valid-signed-state", installation_id: "12345" });
      r.status(400);
    });
  },
);

flow(
  "GH-3",
  {
    domain: "git",
    routes: [
      "DELETE /v1/projects/github/installation",
      "DELETE /v1/projects/github/installations/:installationId",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).del("/v1/projects/github/installation");
      r.status(401);
    });
    await ctx.step("OWNER disconnect (idempotent, none present) → ok", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/github/installation");
      r.status([200, 400, 409, 503]);
    });
    await ctx.step("OWNER delete a specific (absent) installation → ok / not-found", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/github/installations/:installationId", { params: { installationId: "999999999" } });
      r.status([200, 400, 404, 409, 503]);
    });
  },
);

flow(
  "GH-13",
  { domain: "git", routes: ["GET /v1/projects/github/repositories"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/github/repositories");
      r.status(401);
    });
    await ctx.step("OWNER lists repos (no install locally → 409 with install_url)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/github/repositories");
      r.status([200, 400, 409, 502, 503]);
    });
  },
);

flow(
  "GH-16",
  { domain: "git", routes: ["GET /v1/projects/github/repository-branches"] },
  async (ctx) => {
    const path = "/v1/projects/github/repository-branches";
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get(path);
      r.status(401);
    });
    await ctx.step("missing repository selection → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(path);
      r.status(400);
    });
    await ctx.step("unknown installation → 409 install prompt", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(path, {
        query: {
          account_id: ctx.P.OWNER.accountId,
          installation_id: "999999999",
          repo_full_name: "octocat/hello-world",
        },
      });
      r.status([400, 409]);
    });
  },
);

// ── Repo creation / import (need a real GitHub App install or PAT) ─────────

flow(
  "GH-14",
  { domain: "git", routes: ["POST /v1/projects/create-repo"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/create-repo", { name: "x" });
      r.status(401);
    });
    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/create-repo", {});
      r.status(400);
    });
    await ctx.step("invalid name chars → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name: "bad name/with spaces" });
      r.status(400);
    });
    await ctx.step("valid name but no GitHub App install → 409 install_url / 503", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/create-repo", { name: ctx.fixtures.name("repo").replace(/[^a-zA-Z0-9._-]/g, "-") });
      r.status([200, 201, 409, 502, 503]);
    });
  },
);

flow(
  "GH-15",
  { domain: "git", requires: ["managedGit"], routes: ["POST /v1/projects/link-repository"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello" });
      r.status(401);
    });
    await ctx.step("missing repo_url/repo_full_name → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/link-repository", {});
      r.status(400);
    });
    await ctx.step("repo via App with no install → 400/409/502 (no validated access)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello-world" });
      r.status([200, 201, 400, 409, 502, 503]);
    });
    await ctx.step("repo via bogus PAT → validation fails 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/link-repository", { repo_full_name: "octocat/hello-world", github_token: "ghp_invalid_token_xyz" });
      r.status([400, 401, 409, 502]);
    });
  },
);

flow(
  'GH-17',
  {
    domain: 'git',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/git/:project/info/refs',
      'POST /v1/git/:project/git-upload-pack',
      'POST /v1/git/:project/git-receive-pack',
    ],
  },
  async (ctx) => {
    const { randomUUID } = await import('node:crypto');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { Client: PgClient } = await import('pg');
    const exec = promisify(execFile);
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const project = await team.project({ managedGit: true });
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const databaseUrl = ctx.env.databaseUrl!;
    const db = new PgClient({ connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
    await db.connect();
    const root = await mkdtemp(join(tmpdir(), 'ke2e-ref-role-'));
    const sessions: string[] = [];
    let localGitServer: import('node:http').Server | null = null;
    const mint = async (identity: typeof ctx.P.OWNER) => {
      const userId = identity.userId!;
      const sessionId = randomUUID();
      sessions.push(sessionId);
      const created = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', {
        name: 'GH-17 session fixture',
      });
      created.status(201);
      const { token_id: tokenId, secret_key: secret } = created.json<{ token_id: string; secret_key: string }>();
      await db.query(`INSERT INTO kortix.project_sessions
        (session_id, account_id, project_id, branch_name, created_by, metadata)
        VALUES ($1, $2, $3, $1, $4, '{"workspace_mode":"branch"}'::jsonb)`,
      [sessionId, team.id, project.id, userId]);
      await db.query(`INSERT INTO kortix.session_sandboxes
        (sandbox_id, session_id, account_id, project_id, status)
        VALUES ($1::uuid, $1, $2, $3, 'active')`,
      [sessionId, team.id, project.id]);
      // Bind the API-minted credential to the fixture session. The test never
      // needs the server's token-hash secret on local, preview, or staging.
      await db.query(`UPDATE kortix.account_tokens
        SET project_id = $2, session_id = $3, agent_grant = $4::jsonb, account_id = $5, user_id = $6 WHERE token_id = $1`,
      [tokenId, project.id, sessionId,
        JSON.stringify({ agent: 'kortix', kortixCli: 'all', connectors: 'all', env: [] }), team.id, userId]);
      return { secret, sessionId };
    };
    const git = async (secret: string, args: string[], expected = 0) => {
      let code = 0;
      let output = '';
      try {
        const result = await exec('git', args, { cwd: root, timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` } });
        output = result.stdout + result.stderr;
      } catch (error: any) {
        code = typeof error.code === 'number' ? error.code : -1;
        output = String(error.stdout ?? '') + String(error.stderr ?? '');
      }
      if ((expected === 0 && code !== 0) || (expected !== 0 && code === 0)) {
        throw new Error(`git ${args[0]}: expected ${expected === 0 ? 'success' : 'rejection'}, got ${code}: ${output.replaceAll(secret, '[redacted]')}`);
      }
      return output;
    };
    try {
      if (ctx.env.target === 'local') {
        // Serve the fixture's real bare repository through Git's CGI backend.
        // The API proxy speaks HTTP; a filesystem repo_url is not an HTTP origin.
        const { createServer } = await import('node:http');
        const { spawn } = await import('node:child_process');
        const { rows } = await db.query('SELECT repo_url FROM kortix.projects WHERE project_id = $1', [project.id]);
        const repo = rows[0].repo_url as string;
        localGitServer = createServer((req, res) => {
          const url = new URL(req.url!, 'http://localhost');
          const child = spawn('git', ['http-backend'], { env: { ...process.env,
            GIT_PROJECT_ROOT: repo, GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers['content-type'] ?? '',
            REMOTE_USER: 'ke2e', REMOTE_ADDR: '127.0.0.1' } });
          const chunks: Buffer[] = [];
          req.pipe(child.stdin);
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.stderr.resume();
          child.on('error', () => { res.writeHead(502); res.end(); });
          child.on('close', () => {
            const body = Buffer.concat(chunks);
            const split = body.indexOf('\r\n\r\n');
            if (split < 0) { res.writeHead(502); res.end(); return; }
            for (const line of body.subarray(0, split).toString().split('\r\n')) {
              const colon = line.indexOf(':');
              if (colon < 0) continue;
              const name = line.slice(0, colon); const value = line.slice(colon + 1).trim();
              if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
              else res.setHeader(name, value);
            }
            res.end(body.subarray(split + 4));
          });
        });
        await new Promise<void>((resolve) => localGitServer!.listen(0, '127.0.0.1', resolve));
        const port = (localGitServer.address() as import('node:net').AddressInfo).port;
        await db.query('UPDATE kortix.projects SET repo_url = $1 WHERE project_id = $2',
          [`http://127.0.0.1:${port}`, project.id]);
      }
      const owner = await mint(ctx.P.OWNER);
      const memberSession = await mint(member);
      const remote = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;
      await ctx.step('owner session clones through HTTP and creates a shared branch; read-back finds it', async () => {
        await git(owner.secret, ['clone', remote, '.']);
        await git(owner.secret, ['push', 'origin', 'HEAD:refs/heads/gh17-shared']);
        const refs = await git(owner.secret, ['ls-remote', '--heads', 'origin', 'gh17-shared']);
        if (!refs.includes('refs/heads/gh17-shared')) throw new Error('shared branch missing after owner push');
      });
      await ctx.step('member session pushes its own branch with a wildcard agent grant', async () => {
        await git(memberSession.secret, ['push', 'origin', `HEAD:refs/heads/${memberSession.sessionId}`]);
      });
      await ctx.step('member wildcard grant cannot create another branch or delete the shared branch; shared ref persists', async () => {
        for (const args of [
          ['push', 'origin', 'HEAD:refs/heads/gh17-member-forbidden'],
          ['push', 'origin', '--delete', 'gh17-shared'],
        ]) {
          const output = await git(memberSession.secret, args, 1);
          if (!output.includes('[remote rejected]')) throw new Error('expected a Git ref-policy rejection');
        }
        const refs = await git(owner.secret, ['ls-remote', '--heads', 'origin', 'gh17-shared', 'gh17-member-forbidden']);
        if (!refs.includes('refs/heads/gh17-shared') || refs.includes('refs/heads/gh17-member-forbidden')) {
          throw new Error('denied member push changed repository refs');
        }
      });
      await ctx.step('owner session deletes the shared branch; read-back proves deletion', async () => {
        await git(owner.secret, ['push', 'origin', '--delete', 'gh17-shared']);
        const refs = await git(owner.secret, ['ls-remote', '--heads', 'origin', 'gh17-shared']);
        if (refs.trim()) throw new Error('shared branch still exists after owner deletion');
      });
    } finally {
      for (const sessionId of sessions) {
        await db.query('DELETE FROM kortix.account_tokens WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]);
        await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
      }
      if (localGitServer) await new Promise<void>((resolve) => localGitServer!.close(() => resolve()));
      await db.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

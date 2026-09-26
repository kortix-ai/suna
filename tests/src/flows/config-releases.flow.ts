/**
 * Config releases — the descriptor route and the archive route
 * (docs/specs/config-releases.md, "Routes"). Maps to spec §CFG-*.
 *
 * A session's sandbox token is minted the way the daemon's `KORTIX_TOKEN` is:
 * an account token bound by SQL to one project and one session, with a live
 * `session_sandboxes` row. No cloud sandbox runs.
 *
 * Every flow commits the same config dir onto the project's base branch with
 * the real Git CLI, so each target asserts the same bytes. On the local target
 * the repository is a bare repository on disk. On a deployed target it is the
 * managed repository, reached through the Kortix git proxy
 * (`/v1/git/<project>.git`) with an OWNER PAT, the way `kortix ship` pushes.
 */
import { flow } from '../core/flow';
import { sleep, waitFor } from '../core/poll';
import type { CreatedProject, FlowContext, TeamFixture } from '../core/types';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DESCRIPTOR = 'POST /v1/projects/:projectId/sessions/:sessionId/config-release';
const ARCHIVE = 'GET /v1/projects/:projectId/config-archives/:configTreeId';
const MINT = 'POST /v1/accounts/tokens';
const CONFIG_STATE = 'GET /v1/projects/:projectId/sessions/:sessionId/config';
const FEATURES = 'PATCH /v1/projects/:projectId/features';
const PROJECT_DETAIL = 'GET /v1/projects/:projectId';
/** The git proxy routes `commitTo` and `tipOf` use on a deployed target. */
const GIT_PROXY = [
  'GET /v1/git/:project/info/refs',
  'POST /v1/git/:project/git-upload-pack',
  'POST /v1/git/:project/git-receive-pack',
];

type Descriptor = {
  format: string;
  release_id: string | null;
  mode: string;
  source_commit: string;
  config_dir: string | null;
  config_tree_id: string | null;
  archive: { url: string; bytes: number } | null;
  files: Array<[string, string, string]> | null;
  compiled_governance: string | null;
  compiled_governance_etag: string | null;
  reason: string | null;
  agent_repoint: {
    from: string;
    to: string | null;
    applied: boolean;
    reason: string;
  } | null;
};

interface SessionToken {
  sessionId: string;
  secret: string;
}

/**
 * A project's repository as a Git client reaches it: a bare repository path on
 * the local target, the Kortix git proxy with an OWNER PAT on a deployed one.
 */
interface ProjectRepo {
  projectId: string;
  url: string;
  branch: string;
  /** `git -c` arguments that authenticate every request to `url`. */
  auth: string[];
}

interface Fixture {
  ctx: FlowContext;
  db: import('pg').Client;
  team: TeamFixture;
  projectId: string;
  /** The project itself, for the one flow that boots a real sandbox in it. */
  project: CreatedProject;
  repo: ProjectRepo;
  sessions: string[];
  mint(opts?: {
    repositoryAccess?: boolean;
    agentName?: string;
    projectId?: string;
    repositoryGeneration?: string;
    /** `project_sessions.created_by` — whose access an agent re-point clears. */
    ownerUserId?: string;
  }): Promise<SessionToken>;
  descriptor(secret: string | null, sessionId: string, body?: unknown): Promise<{ status: number; body: any }>;
  download(secret: string | null, treeId: string): Promise<{ status: number; bytes: Buffer; source: string | null }>;
  /** Commit files onto the base branch of the project repository. Returns the new tip. */
  commit(files: Record<string, string>, message: string): Promise<string>;
  /** Open another project's repository with the same credential. */
  openRepo(projectId: string): Promise<ProjectRepo>;
  /** `GET .../sessions/:sessionId/config` as the project owner. */
  configState(sessionId: string): Promise<{ status: number; body: any }>;
  /**
   * The project's own switch for `config_releases`, through the published
   * write path. `true` opts in, `false` opts out, `null` clears the override
   * and returns the project to the platform default — which is OFF
   * (`apps/api/src/feature-flags/registry.ts`, `platformDefault: () => false`).
   */
  setFeature(enabled: boolean | null): Promise<void>;
  /** The project's effective `config_releases` value, read back from the API. */
  featureEnabled(): Promise<boolean>;
  cleanup(): Promise<void>;
}

const MANIFEST = [
  'kortix_version: 2',
  'project:',
  '  name: ke2e-config-releases',
  'default_agent: kortix',
  'agents:',
  '  kortix:',
  '    skills: all',
  '  reviewer:',
  '    skills: none',
  '',
].join('\n');

function PACKAGE_JSON(pin: string, extra = ''): string {
  return `{\n  "dependencies": {\n    "@opencode-ai/plugin": "${pin}"${extra}\n  }\n}\n`;
}

const CONFIG_FILES: Record<string, string> = {
  'kortix.yaml': MANIFEST,
  '.kortix/opencode/opencode.json': '{ "$schema": "https://opencode.ai/config.json" }\n',
  '.kortix/opencode/agents/kortix.md': '---\ndescription: main agent\nmode: primary\n---\nYou are the main agent.\n',
  '.kortix/opencode/agents/reviewer.md': '---\ndescription: reviews\n---\nReview.\n',
  '.kortix/opencode/skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\nDemo skill.\n',
  '.kortix/opencode/tools/hello.ts': 'export default {}\n',
  // `git archive` would drop this file and rewrite the next one. The
  // archive must hold both unmodified, or blob verification on the box fails.
  '.kortix/opencode/.gitattributes': 'notes.md export-ignore\nversion.txt export-subst\n',
  '.kortix/opencode/notes.md': 'kept verbatim\n',
  '.kortix/opencode/version.txt': 'commit $Format:%H$\n',
  // Platform-written paths the mode decision ignores (spec, "Config mode").
  '.kortix/opencode/package.json': PACKAGE_JSON('1.17.11'),
  '.kortix/opencode/bun.lock': '"@opencode-ai/plugin": "1.17.11"\n',
};

async function run(cmd: string, args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(
            new Error(
              // A git-proxy credential rides in `-c http.extraHeader=...`; never print it.
              `${cmd} ${args.map((a) => (/authorization:/i.test(a) ? '<credential>' : a)).join(' ')} exited ${code}: ${Buffer.concat(err).toString()}`,
            ),
          ),
    );
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

/** The Git blob ID of `bytes`. */
async function gitBlobId(bytes: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

/** Extract a tar.gz and return every regular file and symlink with its bytes. */
async function extract(archive: Buffer): Promise<Map<string, Buffer>> {
  const { mkdtemp, readFile, readlink, rm, lstat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ke2e-cfg-archive-'));
  try {
    await run('tar', ['-xzf', '-', '-C', dir], dir, archive);
    const listed = (await run('find', ['.', '(', '-type', 'f', '-o', '-type', 'l', ')'], dir))
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^\.\//, ''))
      // A commit archive carries a pax global header; tar does not extract it
      // as a file, but guard against implementations that do.
      .filter((p) => p !== 'pax_global_header');
    const files = new Map<string, Buffer>();
    for (const path of listed) {
      const full = join(dir, path);
      const stat = await lstat(full);
      files.set(path, stat.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full));
    }
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Clone `repo`, write `files`, commit, and push to its base branch. Returns the new tip. */
async function commitTo(repo: ProjectRepo, files: Record<string, string>, message: string): Promise<string> {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const work = await mkdtemp(join(tmpdir(), 'ke2e-cfg-commit-'));
  try {
    await run('git', [...repo.auth, 'clone', '-q', '--branch', repo.branch, repo.url, '.'], work);
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), body);
    }
    await run('git', ['add', '-A'], work);
    await run('git', ['-c', 'user.name=KE2E', '-c', 'user.email=ke2e@kortix.invalid', 'commit', '-qm', message], work);
    await run('git', [...repo.auth, 'push', '-q', 'origin', `HEAD:refs/heads/${repo.branch}`], work);
    return (await run('git', ['rev-parse', 'HEAD'], work)).toString().trim();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The tip of `repo`'s base branch, read from the repository itself. */
async function tipOf(repo: ProjectRepo): Promise<string> {
  const out = (await run('git', [...repo.auth, 'ls-remote', repo.url, `refs/heads/${repo.branch}`], '/')).toString();
  const tip = out.split(/\s+/)[0] ?? '';
  if (!HEX40.test(tip)) throw new Error(`no tip for ${repo.branch} in ${repo.url}: ${out}`);
  return tip;
}

async function setup(ctx: FlowContext): Promise<Fixture> {
  const { randomUUID } = await import('node:crypto');
  const { Client: PgClient } = await import('pg');
  const team = await ctx.fixtures.team();
  const local = ctx.env.target === 'local';
  const project = await team.project({ managedGit: true });
  const databaseUrl = ctx.env.databaseUrl!;
  const db = new PgClient({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  await db.connect();
  const sessions: string[] = [];
  const origin = ctx.env.apiUrl.replace(/\/v1$/, '');

  // One OWNER PAT authenticates every git-proxy request of this flow. The
  // proxy accepts a PAT, never a Supabase JWT (`authorizeGitProxy`).
  let proxyAuth: string[] | null = null;
  const openRepo = async (projectId: string): Promise<ProjectRepo> => {
    const { rows } = await db.query('SELECT repo_url, default_branch FROM kortix.projects WHERE project_id = $1', [projectId]);
    const repoUrl = String(rows[0]?.repo_url ?? '');
    const branch = String(rows[0]?.default_branch || 'main');
    if (local) {
      if (!repoUrl.startsWith('/')) throw new Error(`local project repo_url is not a path: ${repoUrl}`);
      return { projectId, url: repoUrl, branch, auth: [] };
    }
    if (!proxyAuth) {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cfg-git') });
      const basic = Buffer.from(`ke2e:${pat}`).toString('base64');
      proxyAuth = ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
    }
    return { projectId, url: `${origin}/v1/git/${projectId}.git`, branch, auth: proxyAuth };
  };
  const repo = await openRepo(project.id);

  const fixture: Fixture = {
    ctx,
    db,
    team,
    projectId: project.id,
    project,
    repo,
    sessions,
    openRepo,
    async mint(opts = {}) {
      const sessionId = randomUUID();
      const projectId = opts.projectId ?? project.id;
      sessions.push(sessionId);
      const created = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: `CFG session ${sessionId.slice(0, 8)}` });
      created.status(201);
      const { token_id: tokenId, secret_key: secret } = created.json<{ token_id: string; secret_key: string }>();
      ctx.track('token', tokenId);
      const metadata = {
        ...(opts.repositoryAccess === false ? { workspace_mode: 'none', repository_access: false } : { workspace_mode: 'branch' }),
        // Session create copies the project's generation (`sessions.ts`).
        ...(opts.repositoryGeneration ? { repository_generation: opts.repositoryGeneration } : {}),
      };
      await db.query(
        `INSERT INTO kortix.project_sessions
           (session_id, account_id, project_id, branch_name, agent_name, status, metadata, created_by, visibility)
         VALUES ($1, $2, $3, $1, $4, 'running', $5::jsonb, $6, 'project')`,
        [
          sessionId,
          team.id,
          projectId,
          opts.agentName ?? 'kortix',
          JSON.stringify(metadata),
          opts.ownerUserId ?? ctx.P.OWNER.userId,
        ],
      );
      await db.query(
        `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
         VALUES ($1::uuid, $1, $2, $3, 'active')`,
        [sessionId, team.id, projectId],
      );
      // Bind the API-minted credential exactly as the sandbox's KORTIX_TOKEN is bound.
      await db.query(
        `UPDATE kortix.account_tokens
            SET account_id = $2, user_id = $3, project_id = $4, session_id = $5, agent_grant = $6::jsonb
          WHERE token_id = $1`,
        [
          tokenId,
          team.id,
          ctx.P.OWNER.userId,
          projectId,
          sessionId,
          JSON.stringify({ agent: opts.agentName ?? 'kortix', kortixCli: [], connectors: [], env: [] }),
        ],
      );
      return { sessionId, secret };
    },
    async descriptor(secret, sessionId, body = {}) {
      const response = await fetch(`${origin}/v1/projects/${project.id}/sessions/${sessionId}/config-release`, {
        method: 'POST',
        headers: {
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          'Content-Type': 'application/json',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: response.status, body: parsed };
    },
    commit(files, message) {
      return commitTo(repo, files, message);
    },
    async setFeature(enabled) {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'config_releases', enabled },
          { params: { projectId: project.id } },
        );
      r.status(200);
    },
    async featureEnabled() {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId', { params: { projectId: project.id } });
      r.status(200);
      return r.json<{ experimental: Record<string, boolean> }>().experimental.config_releases === true;
    },
    async configState(sessionId) {
      const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
      const response = await fetch(`${origin}/v1/projects/${project.id}/sessions/${sessionId}/config`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: response.status, body: parsed };
    },
    async download(secret, treeId) {
      const response = await fetch(`${origin}/v1/projects/${project.id}/config-archives/${treeId}`, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 302) {
        // The daemon follows one redirect, with no credentials, to the store.
        const location = response.headers.get('location');
        if (!location) throw new Error('302 without a Location header');
        const stored = await fetch(location, { signal: AbortSignal.timeout(60_000) });
        return { status: stored.status, bytes: Buffer.from(await stored.arrayBuffer()), source: 'redirect' };
      }
      return {
        status: response.status,
        bytes: Buffer.from(await response.arrayBuffer()),
        source: response.headers.get('x-kortix-config-archive-source'),
      };
    },
    async cleanup() {
      await db.query('DELETE FROM kortix.config_release_failures WHERE project_id = $1', [project.id]).catch(() => {});
      await db.query('DELETE FROM kortix.config_releases WHERE project_id = $1', [project.id]).catch(() => {});
      for (const sessionId of sessions) {
        await db.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]).catch(() => {});
        await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]).catch(() => {});
      }
      // The archives this flow stored. The bucket stays: it is shared state.
      const key = ctx.env.supabaseServiceRoleKey;
      if (key) {
        const base = `${ctx.env.supabaseUrl}/storage/v1`;
        const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
        const listed = await fetch(`${base}/object/list/kortix-config-releases`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ prefix: `projects/${project.id}/trees/`, limit: 1000 }),
        }).catch(() => null);
        const objects = listed?.ok ? ((await listed.json()) as Array<{ name: string }>) : [];
        if (objects.length > 0) {
          await fetch(`${base}/object/kortix-config-releases`, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ prefixes: objects.map((o) => `projects/${project.id}/trees/${o.name}`) }),
          }).catch(() => {});
        }
      }
      await db.end().catch(() => {});
    },
  };

  // The same config dir on every target, so every step asserts known bytes.
  await commitTo(repo, CONFIG_FILES, 'config dir');
  return fixture;
}

function baseTip(fixture: Fixture): Promise<string> {
  return tipOf(fixture.repo);
}

async function assertArchiveMatches(descriptor: Descriptor, bytes: Buffer): Promise<Map<string, Buffer>> {
  if (bytes.length !== descriptor.archive?.bytes) {
    throw new Error(`archive has ${bytes.length} bytes; descriptor says ${descriptor.archive?.bytes}`);
  }
  const files = await extract(bytes);
  const listed = new Map(descriptor.files!.map(([path, mode, blob]) => [path, { mode, blob }]));
  for (const [path, content] of files) {
    const entry = listed.get(path);
    if (!entry) throw new Error(`archive holds ${path}, which is not in the descriptor's files`);
    const blob = await gitBlobId(content);
    if (blob !== entry.blob) throw new Error(`${path}: blob ${blob}, descriptor says ${entry.blob}`);
  }
  for (const [path] of listed) {
    if (!files.has(path)) throw new Error(`descriptor lists ${path}, which the archive lacks`);
  }
  return files;
}

// ── CFG-1 — descriptor route authentication and input-free contract ────────
flow(
  'CFG-1',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      const sibling = await fixture.mint();
      const otherProject = await fixture.team.project();

      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('ANON posting for a session is rejected with 401', async () => {
        const r = await fixture.descriptor(null, own.sessionId);
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
      });
      await ctx.step("the session's own sandbox token receives a descriptor (200)", async () => {
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.format !== 'config-release-v1') throw new Error(`unexpected format ${r.body.format}`);
      });
      await ctx.step("a sibling session's token in the same project is refused (403) for this session", async () => {
        const r = await fixture.descriptor(sibling.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });
      await ctx.step("a session token of another project is refused (403) by the token's project scope", async () => {
        const foreign = await fixture.mint({ projectId: otherProject.id });
        const r = await fixture.descriptor(foreign.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });
      await ctx.step('a non-member user cannot read the descriptor (403/404)', async () => {
        const token = (ctx.P.NONMEMBER.auth as { token?: string }).token ?? null;
        const r = await fixture.descriptor(token, own.sessionId);
        if (r.status !== 403 && r.status !== 404) throw new Error(`expected 403/404, got ${r.status}`);
      });
      await ctx.step('the project owner (a reader of the session) receives the same release (200)', async () => {
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const mine = await fixture.descriptor(own.secret, own.sessionId);
        const r = await fixture.descriptor(token, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.release_id !== mine.body.release_id) throw new Error('owner and sandbox read different releases');
      });
      await ctx.step('the request has no inputs: any body returns the same release (200)', async () => {
        // The desired release is always the base branch's current one for this
        // session's variant. Nothing a caller sends can change it, so nothing
        // a caller sends is read.
        const plain = await fixture.descriptor(own.secret, own.sessionId);
        const bodies: unknown[] = [
          '{"workspace":',
          '"a string"',
          { workspace: null, descriptor: {} },
          { anything: [1, 2, 3] },
        ];
        for (const body of bodies) {
          const r = await fixture.descriptor(own.secret, own.sessionId, body);
          if (r.status !== 200) throw new Error(`body ${JSON.stringify(body)}: expected 200, got ${r.status}`);
          if (r.body.release_id !== plain.body.release_id) {
            throw new Error(`body ${JSON.stringify(body)} changed the assigned release`);
          }
        }
      });
      await ctx.step('a session with local config edits still receives the base release', async () => {
        // There is no session-files mode: /workspace is an editable clone, and
        // an edit there reaches the box only once it is pushed to the base
        // branch. The descriptor never withholds the archive for that reason.
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        if (r.body.mode !== 'follow-base') throw new Error(`mode ${r.body.mode}, expected follow-base`);
        if (r.body.archive === null) throw new Error('the base release carries no archive');
      });
      await ctx.step('a malformed session id is rejected with 400', async () => {
        const r = await fixture.descriptor(own.secret, 'not-a-uuid');
        if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-2 — descriptor round trip and a verified archive download ──────────
flow(
  'CFG-2',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ARCHIVE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      let descriptor!: Descriptor;
      let firstBytes!: Buffer;

      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('the descriptor names the base tip, its config tree, and a release ID over tree and governance', async () => {
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        descriptor = r.body as Descriptor;
        if (descriptor.mode !== 'follow-base') throw new Error(`mode ${descriptor.mode}`);
        if (!HEX40.test(descriptor.source_commit)) throw new Error('source_commit is not a commit SHA');
        const tip = await baseTip(fixture);
        if (descriptor.source_commit !== tip) {
          throw new Error(`source_commit ${descriptor.source_commit} is not the base tip ${tip}`);
        }
        if (!descriptor.config_dir || !HEX40.test(descriptor.config_tree_id ?? '')) {
          throw new Error(`no config tree: ${descriptor.reason}`);
        }
        if (!HEX64.test(descriptor.release_id ?? '')) throw new Error('release_id is not 64 hex');
        const { createHash } = await import('node:crypto');
        const expected = createHash('sha256')
          .update(`${descriptor.config_tree_id}:${descriptor.compiled_governance_etag ?? ''}`)
          .digest('hex');
        if (descriptor.release_id !== expected) throw new Error('release_id is not sha256(tree:etag)');
        if (descriptor.archive?.url !== `/v1/projects/${fixture.projectId}/config-archives/${descriptor.config_tree_id}`) {
          throw new Error(`archive url ${descriptor.archive?.url}`);
        }
        if (!descriptor.files?.length) throw new Error('descriptor lists no files');
        if (descriptor.reason !== null) throw new Error(`unexpected reason ${descriptor.reason}`);
      });

      await ctx.step('a second request for an unchanged base returns the same release ID', async () => {
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.body.release_id !== descriptor.release_id) throw new Error('release ID moved without a base change');
      });

      await ctx.step('the session token downloads the archive; every file matches its blob ID and nothing extra ships', async () => {
        const r = await fixture.download(own.secret, descriptor.config_tree_id!);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${r.bytes.toString().slice(0, 200)}`);
        firstBytes = r.bytes;
        const files = await assertArchiveMatches(descriptor, r.bytes);
        for (const path of ['opencode.json', 'agents/kortix.md', 'skills/demo/SKILL.md', 'tools/hello.ts']) {
          if (!files.has(path)) throw new Error(`archive lacks ${path}`);
        }
        if (files.get('notes.md')?.toString() !== 'kept verbatim\n') throw new Error('export-ignore dropped notes.md');
        if (files.get('version.txt')?.toString() !== 'commit $Format:%H$\n') {
          throw new Error('export-subst rewrote version.txt');
        }
      });

      await ctx.step('a second download returns byte-identical bytes', async () => {
        const r = await fixture.download(own.secret, descriptor.config_tree_id!);
        if (r.status !== 200 || !r.bytes.equals(firstBytes)) throw new Error('the archive bytes changed between downloads');
      });

      if (ctx.env.target === 'local') {
        await ctx.step('local storage is loopback: the API streams, and a later download is served from the store', async () => {
          let source: string | null = null;
          for (let attempt = 0; attempt < 20 && source !== 'store'; attempt += 1) {
            const r = await fixture.download(own.secret, descriptor.config_tree_id!);
            if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
            if (!r.bytes.equals(firstBytes)) throw new Error('store bytes differ from the built archive');
            source = r.source;
            if (source !== 'store') await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (source !== 'store') throw new Error(`archive never came from the store (last source ${source})`);
        });
      }

      await ctx.step('the project owner (project.file.read) downloads the same archive', async () => {
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const r = await fixture.download(token, descriptor.config_tree_id!);
        if (r.status !== 200 || !r.bytes.equals(firstBytes)) throw new Error(`owner download: ${r.status}`);
      });

      await ctx.step('ANON is rejected (401); a non-member is rejected (403/404)', async () => {
        const anon = await fixture.download(null, descriptor.config_tree_id!);
        if (anon.status !== 401) throw new Error(`ANON: expected 401, got ${anon.status}`);
        const token = (ctx.P.NONMEMBER.auth as { token?: string }).token ?? null;
        const r = await fixture.download(token, descriptor.config_tree_id!);
        if (r.status !== 403 && r.status !== 404) throw new Error(`non-member: expected 403/404, got ${r.status}`);
      });

      await ctx.step('a blob ID, an unknown tree ID, and a malformed ID are 404', async () => {
        const blob = descriptor.files![0]![2];
        for (const id of [blob, 'e'.repeat(40), 'HEAD']) {
          const r = await fixture.download(own.secret, id);
          if (r.status !== 404) throw new Error(`${id}: expected 404, got ${r.status}`);
        }
      });

      await ctx.step('a session without repository access gets governance, no archive, and a refused download', async () => {
        const restricted = await fixture.mint({ repositoryAccess: false, agentName: 'reviewer' });
        const r = await fixture.descriptor(restricted.secret, restricted.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.archive !== null || d.files !== null) throw new Error('restricted session received an archive or files');
        if (d.reason !== 'repository access withheld') throw new Error(`reason ${d.reason}`);
        // Governance-only release ID: sha256(":" + etag).
        const { createHash } = await import('node:crypto');
        const governanceOnly = createHash('sha256').update(`:${d.compiled_governance_etag}`).digest('hex');
        if (d.release_id !== governanceOnly) throw new Error(`restricted release_id ${d.release_id} is not sha256(":" + etag)`);
        if (!d.compiled_governance) throw new Error('restricted session lost its compiled governance');
        const agents = Object.keys(JSON.parse(d.compiled_governance).agent ?? {});
        if (agents.length !== 1 || agents[0] !== 'reviewer') {
          throw new Error(`selected-agent governance compiled ${agents.join(',')}`);
        }
        const download = await fixture.download(restricted.secret, descriptor.config_tree_id!);
        if (download.status !== 403) throw new Error(`restricted download: expected 403, got ${download.status}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-3 — no project secret value in any release ─────────────────────────
flow(
  'CFG-3',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ARCHIVE, 'POST /v1/projects/:projectId/secrets', ...GIT_PROXY],
  },
  async (ctx) => {
    const { randomBytes } = await import('node:crypto');
    const fixture = await setup(ctx);
    try {
      const value = `ke2e-cfg-secret-${randomBytes(16).toString('hex')}`;
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('seed a project secret with a known value', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/secrets',
            { name: 'KE2E_CFG_SECRET', value },
            { params: { projectId: fixture.projectId } },
          );
        r.status([200, 201]);
      });
      const full = await fixture.mint();
      const restricted = await fixture.mint({ repositoryAccess: false, agentName: 'kortix' });

      await ctx.step('neither descriptor JSON contains the secret value', async () => {
        for (const session of [full, restricted]) {
          const r = await fixture.descriptor(session.secret, session.sessionId);
          if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
          if (JSON.stringify(r.body).includes(value)) throw new Error('the secret value appears in a descriptor');
        }
      });

      await ctx.step('neither the archive bytes nor any extracted file contains the secret value', async () => {
        const d = (await fixture.descriptor(full.secret, full.sessionId)).body as Descriptor;
        const r = await fixture.download(full.secret, d.config_tree_id!);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        if (r.bytes.includes(Buffer.from(value))) throw new Error('the secret value appears in the archive bytes');
        const files = await extract(r.bytes);
        for (const [path, content] of files) {
          if (content.includes(Buffer.from(value))) throw new Error(`the secret value appears in ${path}`);
        }
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

/** A report entry for `path` (repo-relative) with `bytes` in the working tree. */
async function reported(path: string, status: 'modified' | 'added' | 'deleted' | 'untracked', bytes: string | null) {
  return { path, status, blob: bytes === null ? null : await gitBlobId(Buffer.from(bytes)) };
}

// ── CFG-5 — project quarantine: threshold, fallback, clear on a new release ─
flow(
  'CFG-5',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ARCHIVE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const a = await fixture.mint();
      const b = await fixture.mint();
      const c = await fixture.mint();
      const assigned = async () =>
        (
          await fixture.db.query(
            'SELECT release_id, variant, source_commit, proven_at FROM kortix.config_releases WHERE project_id = $1 ORDER BY created_at',
            [fixture.projectId],
          )
        ).rows as Array<{ release_id: string; variant: string; source_commit: string; proven_at: Date | null }>;
      // A daemon's health report reaches these tables through GET /config and
      // the reload. No daemon runs in this profile, so the flow writes the
      // same rows those paths write.
      const failed = (releaseId: string, sessionId: string) =>
        fixture.db.query(
          `INSERT INTO kortix.config_release_failures (project_id, release_id, session_id, reason)
           VALUES ($1, $2, $3, 'proven check failed') ON CONFLICT DO NOTHING`,
          [fixture.projectId, releaseId, sessionId],
        );
      let good!: Descriptor;
      let bad!: Descriptor;

      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step("the daemon's descriptor request records the assignment; a human read does not", async () => {
        const r = await fixture.descriptor(a.secret, a.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        good = r.body as Descriptor;
        const rows = await assigned();
        if (rows.length !== 1 || rows[0]!.release_id !== good.release_id || rows[0]!.variant !== 'project') {
          throw new Error(`assignment rows ${JSON.stringify(rows)}`);
        }
        if (rows[0]!.source_commit !== good.source_commit || rows[0]!.proven_at !== null) throw new Error('assignment row fields');
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const human = await fixture.descriptor(token, a.sessionId);
        if (human.status !== 200) throw new Error(`owner read: ${human.status}`);
        if ((await assigned()).length !== 1) throw new Error('a human read recorded an assignment');
      });

      await ctx.step('session A proves the release; the base branch then moves to a new release', async () => {
        await fixture.db.query(
          'UPDATE kortix.config_releases SET proven_at = now(), proven_session_id = $3 WHERE project_id = $1 AND release_id = $2',
          [fixture.projectId, good.release_id, a.sessionId],
        );
        const tip = await fixture.commit({ '.kortix/opencode/agents/kortix.md': '---\ndescription: main agent\nmode: primary\n---\nBROKEN.\n' }, 'broken agent');
        const r = await fixture.descriptor(a.secret, a.sessionId);
        bad = r.body as Descriptor;
        if (bad.source_commit !== tip || bad.release_id === good.release_id) throw new Error('the new base did not produce a new release');
      });

      await ctx.step('a failure from one session does not quarantine the release', async () => {
        await failed(bad.release_id!, a.sessionId);
        await failed(bad.release_id!, a.sessionId);
        const r = await fixture.descriptor(b.secret, b.sessionId);
        if (r.body.release_id !== bad.release_id) throw new Error(`one session quarantined: got ${r.body.release_id}`);
      });

      await ctx.step('after failures from 2 distinct sessions, a third session is assigned the last proven release', async () => {
        await failed(bad.release_id!, b.sessionId);
        const r = await fixture.descriptor(c.secret, c.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        const d = r.body as Descriptor;
        if (d.release_id !== good.release_id) throw new Error(`expected the proven release, got ${d.release_id}`);
        if (d.source_commit !== good.source_commit || d.config_tree_id !== good.config_tree_id) throw new Error('fallback commit or tree');
        const download = await fixture.download(c.secret, d.config_tree_id!);
        if (download.status !== 200) throw new Error(`fallback archive download: ${download.status}`);
        await assertArchiveMatches(d, download.bytes);
      });

      await ctx.step('a new base commit with a new release ID is assignable again', async () => {
        const tip = await fixture.commit({ '.kortix/opencode/agents/kortix.md': '---\ndescription: main agent\nmode: primary\n---\nFIXED.\n' }, 'fixed agent');
        const r = await fixture.descriptor(c.secret, c.sessionId);
        const d = r.body as Descriptor;
        if (d.source_commit !== tip) throw new Error(`expected the new tip ${tip}, got ${d.source_commit}`);
        if (d.release_id === good.release_id || d.release_id === bad.release_id) throw new Error('the new release was not assigned');
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-6 — GET /config without a reachable daemon stays unknown ───────────
flow(
  'CFG-6',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, CONFIG_STATE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('a session whose daemon cannot be reached reports stale null, never false, and no release block', async () => {
        const r = await fixture.configState(own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.sandbox_reachable !== false) throw new Error(`sandbox_reachable ${r.body.sandbox_reachable}`);
        if (r.body.stale !== null) throw new Error(`stale ${r.body.stale}`);
        if ('release' in r.body) throw new Error('release block without a daemon report');
        for (const field of ['base_ref', 'running_etag', 'latest_etag', 'commit_sha']) {
          if (!(field in r.body)) throw new Error(`missing ${field}`);
        }
      });
      await ctx.step('ANON is rejected with 401', async () => {
        const origin = ctx.env.apiUrl.replace(/\/v1$/, '');
        const response = await fetch(`${origin}/v1/projects/${fixture.projectId}/sessions/${own.sessionId}/config`);
        if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-7 — a previous-repository session receives the CURRENT release ─────
//
// REVERSED on 2026-09-24. This flow used to assert that a session created
// before a repository replacement was frozen: `409 session_repository_changed`
// on the descriptor and on the archive, and `stale: false` from `GET /config`.
// That policy is deleted. A config release is the project's CURRENT config; it
// never touches a session's `/workspace` clone, so withholding it bought no
// protection and left the session running the config of its provisioning day.
// What remains is physical, not a policy: that session's clone and the new
// origin hold unrelated histories, so Git itself refuses a push without a
// rebase.
//
// The replacement route (`PUT /v1/projects/:projectId/git/repository`) takes a
// GitHub credential from the caller: a token, or an installation plus a GitHub
// user token. The runner holds neither on any target, and a host whose managed
// git runs on the org-wide PAT refuses to export one (`POST .../git-token` →
// 503), which is the preview's configuration. PROJ-36 covers the route's
// validation; `repository-replacement.integration.test.ts` covers its writes.
// This flow owns what the config-release routes answer AFTER a replacement, so
// it writes the same columns `persistProjectRepositoryReplacement` writes,
// pointing the project at a second project's real repository.
flow(
  'CFG-7',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ARCHIVE, CONFIG_STATE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    const { randomUUID } = await import('node:crypto');
    // The project's own repository identity, restored before teardown so the
    // fixture deletes the repository it created and not the second project's.
    let original: { repo_url: string; default_branch: string; metadata: unknown; connection: unknown } | null = null;
    try {
      const old = await fixture.mint();
      let oldDescriptor!: Descriptor;
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('before the replacement the session receives a descriptor', async () => {
        const r = await fixture.descriptor(old.secret, old.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        oldDescriptor = r.body as Descriptor;
      });

      const generation = randomUUID();
      let newTip = '';
      await ctx.step("the project repository is replaced by a second project's repository with a new generation", async () => {
        // OWNER's funded personal account: the free team account holds one project.
        const other = await ctx.fixtures.project({ managedGit: true });
        const otherRepo = await fixture.openRepo(other.id);
        newTip = await commitTo(
          otherRepo,
          { ...CONFIG_FILES, '.kortix/opencode/agents/kortix.md': '---\ndescription: main agent\nmode: primary\n---\nNEW REPOSITORY.\n' },
          'new repository',
        );
        const { rows } = await fixture.db.query(
          `SELECT p.repo_url, p.default_branch, p.metadata,
                  (SELECT row_to_json(c) FROM kortix.project_git_connections c WHERE c.project_id = p.project_id) AS connection,
                  (SELECT count(*)::int FROM kortix.project_git_connections c WHERE c.project_id = $2) AS other_connections
             FROM kortix.projects p WHERE p.project_id = $1`,
          [fixture.projectId, other.id],
        );
        const row = rows[0];
        if (!row) throw new Error('project row missing');
        if (Boolean(row.connection) !== (row.other_connections === 1)) {
          throw new Error('the two projects do not both carry a git connection row');
        }
        original = { repo_url: row.repo_url, default_branch: row.default_branch, metadata: row.metadata, connection: row.connection };
        await fixture.db.query('BEGIN');
        try {
          await fixture.db.query(
            `UPDATE kortix.projects a
                SET repo_url = b.repo_url, default_branch = b.default_branch,
                    metadata = coalesce(a.metadata, '{}'::jsonb)
                      || jsonb_strip_nulls(jsonb_build_object('git', b.metadata->'git', 'github', b.metadata->'github'))
                      || jsonb_build_object('repository_generation', $3::text),
                    updated_at = now()
               FROM kortix.projects b
              WHERE a.project_id = $1 AND b.project_id = $2`,
            [fixture.projectId, other.id, generation],
          );
          await fixture.db.query(
            `UPDATE kortix.project_git_connections a
                SET repo_url = b.repo_url, upstream_url = b.upstream_url, repo_owner = b.repo_owner,
                    repo_name = b.repo_name, external_repo_id = b.external_repo_id,
                    default_branch = b.default_branch, updated_at = now()
               FROM kortix.project_git_connections b
              WHERE a.project_id = $1 AND b.project_id = $2`,
            [fixture.projectId, other.id],
          );
          await fixture.db.query('COMMIT');
        } catch (error) {
          await fixture.db.query('ROLLBACK').catch(() => {});
          throw error;
        }
        // The project's own origin now serves the second repository.
        const tip = await tipOf(await fixture.openRepo(fixture.projectId));
        if (tip !== newTip) throw new Error(`the project's git origin serves ${tip}, not the new repository's tip ${newTip}`);
      });

      let newDescriptor!: Descriptor;
      await ctx.step("the previous-repository session receives a descriptor built from the NEW repository's tip (200)", async () => {
        const r = await fixture.descriptor(old.secret, old.sessionId);
        if (r.status !== 200) throw new Error(`descriptor: expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        newDescriptor = r.body as Descriptor;
        if (newDescriptor.source_commit !== newTip) {
          throw new Error(`source_commit ${newDescriptor.source_commit}, new tip ${newTip}`);
        }
        if (newDescriptor.release_id === oldDescriptor.release_id) {
          throw new Error('the session kept the old repository release');
        }
        if (newDescriptor.reason !== null) throw new Error(`unexpected reason ${newDescriptor.reason}`);
      });

      await ctx.step("the previous-repository session downloads the new repository's archive (200)", async () => {
        const download = await fixture.download(old.secret, newDescriptor.config_tree_id!);
        if (download.status !== 200) throw new Error(`archive: expected 200, got ${download.status}`);
        const files = await assertArchiveMatches(newDescriptor, download.bytes);
        if (!files.get('agents/kortix.md')?.toString().includes('NEW REPOSITORY.')) {
          throw new Error('the archive is not from the new repository');
        }
      });

      await ctx.step("the descriptor points at the NEW repository's config tree", async () => {
        if (newDescriptor.config_tree_id === oldDescriptor.config_tree_id) {
          throw new Error('the config tree did not move with the repository');
        }
        if (newDescriptor.archive?.url !== `/v1/projects/${fixture.projectId}/config-archives/${newDescriptor.config_tree_id}`) {
          throw new Error(`archive url ${newDescriptor.archive?.url}`);
        }
        // The OLD tree's archive stays readable: it is this project's own
        // stored archive of its own former config, keyed by tree ID under
        // `projects/<project>/trees/`. Nothing of another tenant is reachable,
        // and no session is ever TOLD to fetch it again.
        const stale = await fixture.download(old.secret, oldDescriptor.config_tree_id!);
        if (stale.status !== 200) throw new Error(`the project's own stored archive: ${stale.status}`);
      });

      await ctx.step('GET /config compares by release ID for this session like any other', async () => {
        const r = await fixture.configState(old.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        // No daemon runs in this profile, so the box is unreachable and `stale`
        // is `null` — "could not tell", never a confident `false`.
        if (r.body.sandbox_reachable !== false) throw new Error(`sandbox_reachable ${r.body.sandbox_reachable}`);
        if (r.body.stale !== null) throw new Error(`stale ${r.body.stale}, expected null`);
        // The compile is no longer withheld: the new repository's manifest is read.
        if (r.body.latest_etag === null) throw new Error('the session was not compiled against the new repository');
        if ('release' in r.body) throw new Error('release block without a daemon report');
      });

      await ctx.step('a session created after the replacement receives a descriptor from the new repository', async () => {
        const fresh = await fixture.mint({ repositoryGeneration: generation });
        const r = await fixture.descriptor(fresh.secret, fresh.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.source_commit !== newTip) throw new Error(`source_commit ${d.source_commit}, new tip ${newTip}`);
        if (d.release_id === oldDescriptor.release_id) throw new Error('the new session got the old release');
        const download = await fixture.download(fresh.secret, d.config_tree_id!);
        if (download.status !== 200) throw new Error(`new archive: ${download.status}`);
        const files = await assertArchiveMatches(d, download.bytes);
        if (!files.get('agents/kortix.md')?.toString().includes('NEW REPOSITORY.')) throw new Error('archive is not from the new repository');
      });
    } finally {
      const restore = original as { repo_url: string; default_branch: string; metadata: unknown; connection: unknown } | null;
      if (restore) {
        await fixture.db
          .query('UPDATE kortix.projects SET repo_url = $2, default_branch = $3, metadata = $4::jsonb WHERE project_id = $1', [
            fixture.projectId,
            restore.repo_url,
            restore.default_branch,
            JSON.stringify(restore.metadata),
          ])
          .catch(() => {});
        if (restore.connection) {
          await fixture.db
            .query(
              `UPDATE kortix.project_git_connections c
                  SET repo_url = r.repo_url, upstream_url = r.upstream_url, repo_owner = r.repo_owner,
                      repo_name = r.repo_name, external_repo_id = r.external_repo_id, default_branch = r.default_branch
                 FROM jsonb_populate_record(NULL::kortix.project_git_connections, $2::jsonb) r
                WHERE c.project_id = $1`,
              [fixture.projectId, JSON.stringify(restore.connection)],
            )
            .catch(() => {});
        }
      }
      await fixture.cleanup();
    }
  },
);

// ── CFG-8 — the `config_releases` feature flag: the whole three-state contract
//
// `config_releases` is OPT-IN. Its platform default is OFF
// (`apps/api/src/feature-flags/registry.ts`, `platformDefault: () => false`),
// so a project that made no choice gets the pre-release behaviour, and only a
// project that turns the flag on gets a release. This flow drives all three
// states through the published write path, in order:
//
//   1. no choice  ⇒ the flag reads false and the release path is 403 `feature_disabled`
//   2. enabled    ⇒ the descriptor and the archive work
//   3. disabled   ⇒ the pre-release behaviour returns, and the session survives it
//
// The flag's authority is the boot/start of a box, but the API side of it is
// the descriptor route and the archive route: OFF ⇒ both answer 403
// `feature_disabled`, the box then reads its workspace config dir, and no
// release is built, stored, or recorded.
flow(
  'CFG-8',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [MINT, DESCRIPTOR, ARCHIVE, CONFIG_STATE, FEATURES, PROJECT_DETAIL, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    const setFlag = (enabled: boolean | null) => fixture.setFeature(enabled);
    const sessionExists = async (sessionId: string) =>
      Number(
        (await fixture.db.query('SELECT count(*)::int AS n FROM kortix.project_sessions WHERE session_id = $1', [sessionId]))
          .rows[0].n,
      ) === 1;
    try {
      const own = await fixture.mint();
      let treeId!: string;

      await ctx.step('state 1 — a project that made no choice reports the flag OFF', async () => {
        if (await fixture.featureEnabled()) throw new Error('config_releases is on for a project that never opted in');
      });

      await ctx.step('state 1 — with no choice made, the session gets the PRE-RELEASE behaviour, not a release', async () => {
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'feature_disabled') throw new Error(`code ${r.body.code}`);
        if (r.body.feature !== 'config_releases') throw new Error(`feature ${r.body.feature}`);
        const state = await fixture.configState(own.sessionId);
        if (state.status !== 200) throw new Error(`config state: ${state.status}`);
        if ('release' in state.body) throw new Error('release block for a project that never opted in');
        const rows = await fixture.db.query('SELECT count(*)::int AS n FROM kortix.config_releases WHERE project_id = $1', [
          fixture.projectId,
        ]);
        if (rows.rows[0].n !== 0) throw new Error(`${rows.rows[0].n} ledger row(s) for a project that never opted in`);
      });

      await ctx.step('state 2 — the project opts in, and the same session then receives a release', async () => {
        await setFlag(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on');
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (!HEX64.test(r.body.release_id)) throw new Error(`release_id ${r.body.release_id}`);
        treeId = r.body.config_tree_id;
        if (!HEX40.test(treeId)) throw new Error(`config_tree_id ${treeId}`);
        const archive = await fixture.download(own.secret, treeId);
        if (archive.status !== 200) throw new Error(`archive: expected 200, got ${archive.status}`);
      });

      await ctx.step('state 3 — turning it OFF makes the descriptor route answer 403 feature_disabled', async () => {
        await setFlag(false);
        if (await fixture.featureEnabled()) throw new Error('config_releases still reads on after an explicit off');
        if (!(await sessionExists(own.sessionId))) throw new Error('turning the flag off deleted the session');
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'feature_disabled') throw new Error(`code ${r.body.code}`);
        if (r.body.feature !== 'config_releases') throw new Error(`feature ${r.body.feature}`);
      });

      await ctx.step('the archive route answers the same 403, so no archive can be fetched', async () => {
        const r = await fixture.download(own.secret, treeId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
      });

      await ctx.step('a human reader is refused the same way, after authz', async () => {
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const r = await fixture.descriptor(token, own.sessionId);
        if (r.status !== 403) throw new Error(`owner: expected 403, got ${r.status}`);
        const anon = await fixture.descriptor(null, own.sessionId);
        if (anon.status !== 401) throw new Error(`ANON: expected 401, got ${anon.status}`);
      });

      await ctx.step('GET /config carries no release block while the flag is off', async () => {
        const r = await fixture.configState(own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if ('release' in r.body) throw new Error('release block while the flag is off');
        if (r.body.stale !== null) throw new Error(`stale ${r.body.stale}, expected null`);
      });

      await ctx.step('nothing is recorded while the flag is off: no new ledger row', async () => {
        const before = await fixture.db.query('SELECT count(*)::int AS n FROM kortix.config_releases WHERE project_id = $1', [
          fixture.projectId,
        ]);
        await fixture.descriptor(own.secret, own.sessionId);
        await fixture.configState(own.sessionId);
        const after = await fixture.db.query('SELECT count(*)::int AS n FROM kortix.config_releases WHERE project_id = $1', [
          fixture.projectId,
        ]);
        if (after.rows[0].n !== before.rows[0].n) {
          throw new Error(`config_releases rows moved from ${before.rows[0].n} to ${after.rows[0].n} with the flag off`);
        }
      });

      await ctx.step('a base-branch commit while the flag is off changes nothing', async () => {
        await fixture.commit({ '.kortix/opencode/agents/kortix.md': '---\ndescription: edited\n---\nEdited.\n' }, 'off');
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
      });

      await ctx.step('turning it back ON converges the same session, on the new tip', async () => {
        await setFlag(true);
        const tip = await baseTip(fixture);
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.source_commit !== tip) throw new Error(`source_commit ${r.body.source_commit}, tip ${tip}`);
        if (r.body.mode !== 'follow-base') throw new Error(`mode ${r.body.mode}`);
        const archive = await fixture.download(own.secret, r.body.config_tree_id);
        if (archive.status !== 200) throw new Error(`archive: expected 200, got ${archive.status}`);
      });

      await ctx.step('clearing the override returns the project to the OFF platform default', async () => {
        await setFlag(null);
        if (await fixture.featureEnabled()) throw new Error('clearing the override left config_releases on');
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'feature_disabled') throw new Error(`code ${r.body.code}`);
        if (!(await sessionExists(own.sessionId))) throw new Error('the session did not survive the whole toggle cycle');
      });
    } finally {
      await setFlag(null).catch(() => {});
      await fixture.cleanup();
    }
  },
);

// ── CFG-4 — a session whose agent the manifest dropped ─────────────────────
//
// `project_sessions.agent_name` is written at session create. A change request
// that removes or renames an agent used to leave every session that named it
// with `release_id: null` and `reason: 'compiled governance failed'` — no
// config at all — and a deny-all token grant.
//
// Now the session is RE-POINTED once to the project's declared default agent:
// audited, persisted by the daemon's own request alone, and only when the
// session's owner may run that agent. A project with no declared default
// leaves the session with no agent, a valid empty config, and a sentence that
// says why.
flow(
  'CFG-4',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    const auditRows = async (sessionId: string) =>
      (
        await fixture.db.query(
          `SELECT action, before, after, agent_name
             FROM kortix.audit_events
            WHERE session_id = $1 AND action = 'SESSION_AGENT_REPOINTED'`,
          [sessionId],
        )
      ).rows as Array<{ action: string; before: any; after: any; agent_name: string | null }>;
    // Audit rows reach the table through the 250 ms flush queue
    // (`AUDIT_FLUSH_MS_DEFAULT`, apps/api/src/shared/audit-queue.ts): the
    // descriptor answers before the row is committed. A read taken the moment
    // the call returns is ahead of the writer, and CFG-4 read 0 rows 0.5 s into
    // the flow on CI run 36161395127. So: wait for a row the step expects, and
    // give the queue a full window before reading for a row it must NOT have
    // written.
    const AUDIT_FLUSH_WINDOW_MS = 1_500;
    const auditRowsOnceWritten = (sessionId: string, expected: number) =>
      waitFor(() => auditRows(sessionId), {
        until: (rows) => rows.length >= expected,
        timeoutMs: 20_000,
        intervalMs: 200,
        description: `${expected} SESSION_AGENT_REPOINTED audit row(s)`,
      });
    const auditRowsAfterFlush = async (sessionId: string) => {
      await sleep(AUDIT_FLUSH_WINDOW_MS);
      return auditRows(sessionId);
    };
    const storedAgent = async (sessionId: string) =>
      String(
        (await fixture.db.query('SELECT agent_name FROM kortix.project_sessions WHERE session_id = $1', [sessionId]))
          .rows[0]?.agent_name ?? '',
      );
    try {
      // No repository access, so the release compiles exactly ONE agent. That
      // is what proves which agent the session ended up being.
      const dropped = await fixture.mint({ repositoryAccess: false, agentName: 'retired' });

      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('a dropped agent still produces a release, built for the declared default agent', async () => {
        const r = await fixture.descriptor(dropped.secret, dropped.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.release_id === null) throw new Error('a dropped agent produced no release');
        if (d.reason?.includes('compiled governance failed')) throw new Error(`reason ${d.reason}`);
        if (!d.compiled_governance) throw new Error('no compiled governance');
        const agents = Object.keys(JSON.parse(d.compiled_governance).agent ?? {});
        if (agents.length !== 1 || agents[0] !== 'kortix') {
          throw new Error(`compiled ${agents.join(',')}, expected the declared default agent kortix`);
        }
        if (!d.agent_repoint) throw new Error('the descriptor does not state the re-point');
        if (d.agent_repoint.from !== 'retired' || d.agent_repoint.to !== 'kortix' || d.agent_repoint.applied !== true) {
          throw new Error(`agent_repoint ${JSON.stringify(d.agent_repoint)}`);
        }
        if (!d.agent_repoint.reason.includes('retired') || !d.agent_repoint.reason.includes('kortix')) {
          throw new Error(`agent_repoint reason names neither agent: ${d.agent_repoint.reason}`);
        }
      });

      await ctx.step('the session row now names the declared default agent, and one audit row says so', async () => {
        if ((await storedAgent(dropped.sessionId)) !== 'kortix') {
          throw new Error(`agent_name is ${await storedAgent(dropped.sessionId)}`);
        }
        const rows = await auditRowsOnceWritten(dropped.sessionId, 1);
        if (rows.length !== 1) throw new Error(`${rows.length} audit rows, expected 1`);
        if (rows[0]!.before?.agent_name !== 'retired' || rows[0]!.after?.agent_name !== 'kortix') {
          throw new Error(`audit before/after ${JSON.stringify(rows[0])}`);
        }
        if (rows[0]!.agent_name !== 'kortix') throw new Error(`audit agent_name ${rows[0]!.agent_name}`);
      });

      await ctx.step('the re-point happens ONCE: a second request writes nothing and states nothing', async () => {
        const r = await fixture.descriptor(dropped.secret, dropped.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        const d = r.body as Descriptor;
        if (d.agent_repoint !== null) throw new Error(`agent_repoint still set: ${JSON.stringify(d.agent_repoint)}`);
        const agents = Object.keys(JSON.parse(d.compiled_governance!).agent ?? {});
        if (agents.join(',') !== 'kortix') throw new Error(`compiled ${agents.join(',')}`);
        if ((await auditRowsAfterFlush(dropped.sessionId)).length !== 1)
          throw new Error('a second audit row was written');
      });

      await ctx.step('a HUMAN read decides the same answer and writes nothing', async () => {
        const other = await fixture.mint({ repositoryAccess: false, agentName: 'retired' });
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const r = await fixture.descriptor(token, other.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.agent_repoint?.to !== 'kortix' || d.agent_repoint.applied !== true) {
          throw new Error(`human read decided ${JSON.stringify(d.agent_repoint)}`);
        }
        // Only the daemon's own request persists. A read that wrote would move
        // a session's identity every time somebody opened the session page.
        if ((await storedAgent(other.sessionId)) !== 'retired') throw new Error('a human read wrote the column');
        if ((await auditRowsAfterFlush(other.sessionId)).length !== 0)
          throw new Error('a human read wrote an audit row');
      });

      await ctx.step('a declared agent is never re-pointed', async () => {
        const fine = await fixture.mint({ repositoryAccess: false, agentName: 'reviewer' });
        const r = await fixture.descriptor(fine.secret, fine.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        if ((r.body as Descriptor).agent_repoint !== null) throw new Error('a declared agent was re-pointed');
        if ((await storedAgent(fine.sessionId)) !== 'reviewer') throw new Error('a declared agent moved');
        if ((await auditRowsAfterFlush(fine.sessionId)).length !== 0)
          throw new Error('a declared agent produced an audit row');
      });

      await ctx.step('with no declared default agent the session keeps none, gets a valid release, and is told why', async () => {
        await fixture.commit(
          { 'kortix.yaml': MANIFEST.split('\n').filter((line) => !line.startsWith('default_agent:')).join('\n') },
          'drop the default agent',
        );
        const orphan = await fixture.mint({ repositoryAccess: false, agentName: 'retired' });
        const r = await fixture.descriptor(orphan.secret, orphan.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.release_id === null) throw new Error('an orphaned session produced no release');
        if (d.reason?.includes('compiled governance failed')) throw new Error(`reason ${d.reason}`);
        if (JSON.parse(d.compiled_governance!).agent !== undefined) throw new Error('an orphaned session received an agent');
        if (d.agent_repoint?.to !== null || d.agent_repoint.applied !== false) {
          throw new Error(`agent_repoint ${JSON.stringify(d.agent_repoint)}`);
        }
        if (!d.agent_repoint.reason.includes('retired')) throw new Error(`reason ${d.agent_repoint.reason}`);
        if ((await storedAgent(orphan.sessionId)) !== 'retired') throw new Error('an orphaned session was moved');
        if ((await auditRowsAfterFlush(orphan.sessionId)).length !== 0)
          throw new Error('an orphaned session produced an audit row');
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-9 — turn-start convergence, the API half ───────────────────────────
//
// C9: a prompt on a box that is behind converges first, then runs. The gate is
// `convergeBeforeTurnStart`, inside `forwardToSandbox`. It decides by comparing
// the release the API last saw the box running against the DESIRED release,
// memoised per `(project, base ref, agent, repository access)`.
//
// The API half of that contract — the half a profile with no sandbox can
// prove — is the agreement itself: the daemon's descriptor route and the
// human `GET /config` read must resolve the SAME desired release for the same
// session, and both must move together when the base branch moves. If they
// disagreed, a memo filled by one would mislead the other.
flow(
  'CFG-9',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, CONFIG_STATE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      let first!: string;

      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('the daemon assignment and the human read resolve one desired release', async () => {
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const daemon = await fixture.descriptor(own.secret, own.sessionId);
        if (daemon.status !== 200) throw new Error(`descriptor: ${daemon.status}`);
        const human = await fixture.descriptor(token, own.sessionId);
        if (human.status !== 200) throw new Error(`human descriptor: ${human.status}`);
        if (human.body.release_id !== daemon.body.release_id) {
          throw new Error(`human ${human.body.release_id} !== daemon ${daemon.body.release_id}`);
        }
        first = daemon.body.release_id as string;
        const state = await fixture.configState(own.sessionId);
        if (state.status !== 200) throw new Error(`config state: ${state.status}`);
        // No daemon runs here, so `/config` reports the box as unreachable and
        // `stale: null`. It must never answer a confident `false`, which is
        // what the turn-start gate would read as "this box is current".
        if (state.body.stale !== null) throw new Error(`stale ${state.body.stale}, expected null`);
        if (state.body.sandbox_reachable !== false) throw new Error('a box answered in a profile with none');
      });

      await ctx.step('a base branch move moves the desired release for both readers together', async () => {
        const tip = await fixture.commit(
          { '.kortix/opencode/agents/kortix.md': '---\ndescription: main agent\nmode: primary\n---\nTURN START.\n' },
          'turn-start convergence',
        );
        const token = (ctx.P.OWNER.auth as { token?: string }).token ?? null;
        const daemon = await fixture.descriptor(own.secret, own.sessionId);
        const human = await fixture.descriptor(token, own.sessionId);
        if (daemon.body.source_commit !== tip) throw new Error(`daemon commit ${daemon.body.source_commit}, tip ${tip}`);
        if (daemon.body.release_id === first) throw new Error('the desired release did not move with the base branch');
        if (human.body.release_id !== daemon.body.release_id) {
          throw new Error(`readers disagree after the move: ${human.body.release_id} vs ${daemon.body.release_id}`);
        }
      });

      await ctx.step('an unchanged base branch resolves the same release again, so a current box converges nothing', async () => {
        const a = await fixture.descriptor(own.secret, own.sessionId);
        const b = await fixture.descriptor(own.secret, own.sessionId);
        if (a.body.release_id !== b.body.release_id) throw new Error('the desired release moved without a base change');
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-10 — degenerate clones, the API half ───────────────────────────────
//
// C4: `/workspace` is never read to decide config. Missing, empty, foreign or
// broken changes nothing. The daemon half is V5 on a real box; this is the API
// half — the descriptor a session receives depends on the project's base
// branch and on that session's own agent and access, and on nothing else.
flow(
  'CFG-10',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [FEATURES, PROJECT_DETAIL, MINT, DESCRIPTOR, ARCHIVE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    const { randomUUID } = await import('node:crypto');
    try {
      const ordinary = await fixture.mint();
      let expected!: Descriptor;
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on for this project');
      });

      await ctx.step('an ordinary session fixes the release every other session must receive', async () => {
        const r = await fixture.descriptor(ordinary.secret, ordinary.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        expected = r.body as Descriptor;
        if (!expected.release_id) throw new Error('no release for an ordinary session');
      });

      await ctx.step('a session from another repository generation receives the same release', async () => {
        // The session metadata a replacement leaves behind. Its clone came from
        // a repository the project no longer uses; its CONFIG does not.
        const foreign = await fixture.mint({ repositoryGeneration: randomUUID() });
        const r = await fixture.descriptor(foreign.secret, foreign.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.release_id !== expected.release_id) {
          throw new Error(`release ${r.body.release_id}, expected ${expected.release_id}`);
        }
        const download = await fixture.download(foreign.secret, r.body.config_tree_id);
        if (download.status !== 200) throw new Error(`archive: expected 200, got ${download.status}`);
      });

      await ctx.step('a session whose metadata claims a broken or absent workspace receives the same release', async () => {
        for (const claim of [
          { workspace_mode: 'branch', workspace_clone: 'missing' },
          { workspace_mode: 'branch', workspace_clone: 'empty', commit_sha: null },
          { workspace_mode: 'branch', workspace_clone: 'foreign', base_sha: 'f'.repeat(40) },
        ]) {
          const session = await fixture.mint();
          await fixture.db.query('UPDATE kortix.project_sessions SET metadata = $2::jsonb WHERE session_id = $1', [
            session.sessionId,
            JSON.stringify(claim),
          ]);
          const r = await fixture.descriptor(session.secret, session.sessionId);
          if (r.status !== 200) throw new Error(`${JSON.stringify(claim)}: expected 200, got ${r.status}`);
          if (r.body.release_id !== expected.release_id) {
            throw new Error(`${JSON.stringify(claim)}: release ${r.body.release_id}, expected ${expected.release_id}`);
          }
        }
      });

      await ctx.step('the descriptor names a config dir and a tree that come from the base branch, never from a session', async () => {
        if (expected.config_dir !== '.kortix/opencode') throw new Error(`config_dir ${expected.config_dir}`);
        const tip = await baseTip(fixture);
        if (expected.source_commit !== tip) throw new Error(`source_commit ${expected.source_commit}, tip ${tip}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

/**
 * Boot a real session on a real box and open an OpenCode conversation on it.
 *
 * Shared by the two flows that need a booted sandbox with a
 * `config.release.v1` daemon. Everything a box-half contract asks about — the
 * transcript, a prompt sent the way `kortix sessions chat` sends it, the
 * release the box reports — is reachable from what this returns.
 */
async function boxSession(ctx: FlowContext, fixture: Fixture) {
  const oc = (suffix: string, sandbox: string) => `/v1/p/${sandbox}/8000${suffix}`;
  const session = await ctx.fixtures.session(fixture.project, { prompt: 'say hello' });
  const sessionId = session.id;
  const started = await waitFor(
    async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/sessions/:sessionId/start', {}, {
          params: { projectId: fixture.projectId, sessionId },
          query: { wait_ms: '8000' },
          timeoutMs: 25_000,
        });
      if (r.statusCode >= 500) return null;
      r.status(200);
      return r.json<any>();
    },
    {
      until: (s) => s?.stage === 'ready' && Boolean(s?.sandbox?.external_id ?? s?.sandbox?.externalId),
      timeoutMs: 600_000,
      intervalMs: 3_000,
      description: `session runtime ready for ${sessionId}`,
    },
  );
  const sandboxId = String(started.sandbox.external_id ?? started.sandbox.externalId);
  const created = await waitFor(
    async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(oc(`/session?directory=${encodeURIComponent('/workspace')}`, sandboxId), {});
      return r.statusCode >= 500 ? null : r;
    },
    { until: (r) => Boolean(r), timeoutMs: 180_000, intervalMs: 3_000, description: 'opencode conversation' },
  );
  created!.status(200);
  const conversationId = String(created!.json<{ id: string }>().id);

  return {
    sessionId,
    sandboxId,
    conversationId,
    box: (suffix: string) => oc(suffix, sandboxId),
    async releaseOf(): Promise<any> {
      const r = await fixture.configState(sessionId);
      if (r.status !== 200) throw new Error(`GET /config answered ${r.status}`);
      return r.body?.release ?? null;
    },
    async transcript(): Promise<any[]> {
      const r = await ctx.client.as(ctx.P.OWNER).get(oc(`/session/${conversationId}/message`, sandboxId));
      r.status(200);
      return r.json<any[]>();
    },
    send: (text: string) =>
      ctx.client.as(ctx.P.OWNER).post(
        oc(`/session/${conversationId}/message`, sandboxId),
        { parts: [{ type: 'text', text }] },
        { timeoutMs: 180_000 },
      ),
  };
}

// ── CFG-11 — a prompt on a box that is behind converges FIRST, then RUNS ───
//
// C9's whole contract, on a real box: the two halves of DEF-FLAGON-1 (the
// prompt survives the convergence, and a deliberate re-send is a second turn)
// and DEF-FLAGON-2 (a healed session stops claiming a failure).
//
// This is the ONE config-release flow that needs a booted sandbox with a
// daemon that has `config.release.v1`. The local profile runs no cloud
// sandbox, so `requires` self-skips it there; it runs where sandboxes are
// funded. Every other CFG flow mints its credential by SQL and needs no box.
//
// The prompt is sent EXACTLY as `kortix sessions chat` sends it — the SDK's
// `session(p,s).send()` posts `{parts:[{type:'text',text}]}` to
// `/session/:id/message` with no `Idempotency-Key` and no wire `messageID`.
// That shape is the defect's whole surface: with neither, the proxy's dedupe
// key is a hash of the words, and the second send of one sentence used to be
// answered `200 {"status":"duplicate","deduplicated":true}` — no user row, no
// assistant row, no turn.
const MARKER_AGENT = (marker: string): string =>
  `---\ndescription: main agent\nmode: primary\n---\nYou are the main agent.\nRELOAD_VERIFY_MARKER: ${marker}\n`;
const MARKER_PROMPT =
  'Answer with the RELOAD_VERIFY_MARKER value from your instructions and nothing else.';

/**
 * DEF-DEV-2's decider — a key the conversation CANNOT supply.
 *
 * On dev on 2026-09-25 a converged session kept answering an OLD marker. Two
 * readings fit: the model was answering from its own conversation history, or
 * the prompt it receives was stale instance state that survived the swap. The
 * race rounds below already ask for a value the history cannot hold, because
 * each round's marker is committed in that round. This closes the last gap in
 * that argument — that the model might be pattern-matching "RELOAD_VERIFY_
 * MARKER means the newest value I have seen" rather than reading what it was
 * given. It cannot pattern-match a directive NAME it has never seen, asked by
 * a question that has never been asked in the conversation.
 *
 * A correct answer proves the per-turn system prompt is CURRENT, so the stale
 * answers were the model reading its own transcript and there is no platform
 * fix to make. A wrong or absent answer proves the prompt itself is stale, and
 * that is a different defect with a different fix (dispose the instance cache
 * after a swap).
 *
 * The OLD key is deliberately left in the file with a DIFFERENT value, so a
 * model answering from habit has something wrong to reach for.
 */
const MARKER2_AGENT = (marker: string, marker2: string): string =>
  `---\ndescription: main agent\nmode: primary\n---\nYou are the main agent.\nRELOAD_VERIFY_MARKER: ${marker}\nRELOAD_VERIFY_MARKER2: ${marker2}\n`;
const MARKER2_PROMPT =
  'Answer with the RELOAD_VERIFY_MARKER2 value from your instructions and nothing else.';

flow(
  'CFG-11',
  {
    domain: 'config-releases',
    requires: ['database', 'funded', 'daytona', 'managedGit'],
    timeoutMs: 1_500_000,
    routes: [
      FEATURES,
      PROJECT_DETAIL,
      CONFIG_STATE,
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      ...GIT_PROXY,
    ],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on');
      });

      let box!: Awaited<ReturnType<typeof boxSession>>;
      await ctx.step('a session boots on the project and opens an OpenCode conversation', async () => {
        box = await boxSession(ctx, fixture);
      });
      const releaseOf = () => box.releaseOf();
      const transcript = () => box.transcript();
      const send = (text: string) => box.send(text);

      let behindRelease = '';
      await ctx.step('the box runs a release, and a push then puts it behind', async () => {
        const before = await releaseOf();
        if (!before || before.source !== 'release' || before.proven !== true) {
          throw new Error(`the box is not on a proven release: ${JSON.stringify(before)}`);
        }
        behindRelease = String(before.running_release_id);
        await fixture.commit(
          { '.kortix/opencode/agents/kortix.md': MARKER_AGENT('marker-one') },
          'marker-one',
        );
      });

      await ctx.step('the prompt is NOT lost: it answers, and the answer comes from the NEW release', async () => {
        const r = await send(MARKER_PROMPT);
        r.status(200);
        const body = r.json<any>();
        // The defect's signature: `200 {"status":"duplicate","deduplicated":true}`
        // — a body with neither `info` nor `parts`, which is why the CLI died on
        // `msg.parts.filter` rather than printing an answer.
        if (body?.deduplicated) throw new Error('the prompt was swallowed as a duplicate');
        if (!body?.info || !Array.isArray(body?.parts)) {
          throw new Error(`the send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
        }
        const rows = await transcript();
        const users = rows.filter((m) => m.info?.role === 'user');
        const assistants = rows.filter((m) => m.info?.role === 'assistant');
        const asked = users.some((m) =>
          (m.parts ?? []).some((part: any) => typeof part.text === 'string' && part.text.includes(MARKER_PROMPT)),
        );
        if (!asked) throw new Error('the transcript holds no user row for the prompt');
        const answered = assistants
          .flatMap((m) => (m.parts ?? []).map((part: any) => part.text))
          .filter((t: unknown): t is string => typeof t === 'string')
          .join('\n');
        if (!answered.includes('marker-one')) {
          throw new Error(`the answer does not come from the new release: ${answered.slice(0, 200)}`);
        }
      });

      await ctx.step('the release moved: running == desired, and it is not the release the box was behind on', async () => {
        const after = await waitFor(releaseOf, {
          until: (rel) => Boolean(rel) && rel.running_release_id === rel.desired_release_id,
          timeoutMs: 120_000,
          intervalMs: 3_000,
          description: 'running release == desired release',
        });
        if (after.running_release_id === behindRelease) {
          throw new Error(`the release never moved off ${behindRelease}`);
        }
        if (after.proven !== true) throw new Error('the new release is not proven');
      });

      await ctx.step('DEF-FLAGON-1 — the SAME sentence sent again is a SECOND turn, not a duplicate', async () => {
        const before = (await transcript()).filter((m) => m.info?.role === 'user').length;
        const r = await send(MARKER_PROMPT);
        r.status(200);
        const body = r.json<any>();
        if (body?.deduplicated) throw new Error('the re-send was answered `duplicate` and never ran');
        if (!body?.info || !Array.isArray(body?.parts)) {
          throw new Error(`the re-send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
        }
        const after = (await transcript()).filter((m) => m.info?.role === 'user').length;
        if (after !== before + 1) throw new Error(`user rows ${before} -> ${after}; the re-send left no turn`);
      });

      await ctx.step('DEF-FLAGON-2 — a broken base branch makes the session report a fallback', async () => {
        await fixture.commit(
          { '.kortix/opencode/opencode.json': '{ "$schema": "https://opencode.ai/config.json",, }\n' },
          'break the config',
        );
        const broken = await waitFor(releaseOf, {
          until: (rel) => Boolean(rel?.fallback_reason) && Boolean(rel?.failed_release_id),
          timeoutMs: 300_000,
          intervalMs: 5_000,
          description: 'the session reports the broken release',
        });
        if (broken.running_release_id === broken.failed_release_id) {
          throw new Error('the box is running the release it reported as failed');
        }
      });

      await ctx.step('DEF-FLAGON-2 — the fix clears the fallback with no further push', async () => {
        // The fix restores the config tree exactly, so the release the box is
        // ALREADY running becomes the desired one again — a release is
        // content-addressed. The convergence that carries the fix answers
        // `unchanged`, and that answer must state that there is no failure any
        // more. Before the fix it did not, and a session whose config never
        // changed again kept the warning indefinitely.
        await fixture.commit(
          { '.kortix/opencode/opencode.json': CONFIG_FILES['.kortix/opencode/opencode.json']! },
          'fix the config',
        );
        const healed = await waitFor(releaseOf, {
          until: (rel) =>
            Boolean(rel) &&
            rel.running_release_id === rel.desired_release_id &&
            rel.proven === true &&
            rel.fallback_reason === null &&
            rel.failed_release_id === null,
          timeoutMs: 300_000,
          intervalMs: 5_000,
          description: 'the healed session reports no fallback',
        });
        if (healed.source !== 'release') throw new Error(`healed source ${healed.source}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

// ── CFG-12 — a base move and a prompt in the same instant ──────────────────
//
// DEF-DEV-1, on a real box. A convergence retires the OpenCode process that is
// serving the session. If a prompt lands between the turn gate and the swap,
// the process writing that turn is killed: the client gets `HTTP 503` and the
// assistant row stays `completed = null` for ever.
//
// Two ways to land in that window, both here:
//
//  1. RACED. Push a base move, send a prompt within 200 ms, N times. This is
//     the shape a user produces (`git push` then type), and each round also
//     proves the answer comes from the config pushed in THAT round — the
//     cross-process invalidation, end to end, because nothing tells the pod
//     that answers the prompt about the push except the broadcast.
//  2. SCHEDULED. `?delay_before_swap_ms` parks a convergence between the gate
//     and the swap, and the prompt is sent while it is parked. No race to win:
//     the prompt is provably inside the window.
//
// Rounds are `KORTIX_CFG_RACE_ROUNDS` (default 5). The acceptance run for the
// fix is 50; a round costs one push plus one turn, so 50 needs the flow's own
// timeout raised with it.
const RACE_ROUNDS = Math.max(1, Number(process.env.KORTIX_CFG_RACE_ROUNDS ?? '5') || 5);
/** Commit to `running_release_id === desired_release_id` on a box nobody is prompting. */
const IDLE_CONVERGENCE_CEILING_MS = 65_000;

flow(
  'CFG-12',
  {
    domain: 'config-releases',
    requires: ['database', 'funded', 'daytona', 'managedGit'],
    timeoutMs: 1_800_000,
    routes: [
      FEATURES,
      PROJECT_DETAIL,
      CONFIG_STATE,
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      ...GIT_PROXY,
    ],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      await ctx.step('the project opts in: `config_releases` is OFF by default, so this flow enables it', async () => {
        await fixture.setFeature(true);
        if (!(await fixture.featureEnabled())) throw new Error('config_releases did not turn on');
      });

      let box!: Awaited<ReturnType<typeof boxSession>>;
      await ctx.step('a session boots on a proven release and opens an OpenCode conversation', async () => {
        box = await boxSession(ctx, fixture);
        const release = await box.releaseOf();
        if (!release || release.source !== 'release' || release.proven !== true) {
          throw new Error(`the box is not on a proven release: ${JSON.stringify(release)}`);
        }
      });

      /** Every assistant row that never completed. This must stay empty. */
      const openAssistantRows = async (): Promise<string[]> =>
        (await box.transcript())
          .filter((m) => m.info?.role === 'assistant' && !m.info?.time?.completed && !m.info?.error)
          .map((m) => String(m.info?.id ?? 'unknown'));

      const answerTo = async (prompt: string): Promise<string> => {
        const rows = await box.transcript();
        const user = [...rows]
          .reverse()
          .find((m) =>
            m.info?.role === 'user' &&
            (m.parts ?? []).some((part: any) => typeof part.text === 'string' && part.text.includes(prompt)),
          );
        if (!user) throw new Error('the transcript holds no user row for the prompt');
        return rows
          .filter((m) => m.info?.role === 'assistant' && m.info?.parentID === user.info?.id)
          .flatMap((m) => (m.parts ?? []).map((part: any) => part.text))
          .filter((t: unknown): t is string => typeof t === 'string')
          .join('\n');
      };

      for (let round = 1; round <= RACE_ROUNDS; round += 1) {
        const marker = `marker-race-${round}`;
        await ctx.step(`round ${round}/${RACE_ROUNDS}: a base move and a prompt 200 ms apart`, async () => {
          await fixture.commit({ '.kortix/opencode/agents/kortix.md': MARKER_AGENT(marker) }, marker);
          await new Promise((resolve) => setTimeout(resolve, 200));

          const r = await box.send(MARKER_PROMPT);
          // THE DEFECT: `503` here, because the swap killed the process that
          // had already accepted this prompt.
          if (r.statusCode === 503) throw new Error(`round ${round}: the send answered 503`);
          r.status(200);
          const body = r.json<any>();
          if (body?.deduplicated) throw new Error(`round ${round}: the prompt was swallowed as a duplicate`);
          if (!body?.info || !Array.isArray(body?.parts)) {
            throw new Error(`round ${round}: the send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
          }

          const answer = await answerTo(MARKER_PROMPT);
          if (!answer.includes(marker)) {
            throw new Error(`round ${round}: the answer does not carry this round's marker: ${answer.slice(0, 200)}`);
          }
          const open = await openAssistantRows();
          if (open.length > 0) throw new Error(`round ${round}: assistant rows never completed: ${open.join(', ')}`);
        });
      }

      await ctx.step('a prompt sent while a convergence is PARKED before its swap still answers', async () => {
        const marker = 'marker-parked';
        await fixture.commit({ '.kortix/opencode/agents/kortix.md': MARKER_AGENT(marker) }, marker);
        // Fault injection: hold the convergence between the turn gate and the
        // swap. The prompt below is provably inside the window, not racing it.
        const parked = ctx.client
          .as(ctx.P.OWNER)
          .post(box.box('/kortix/config/converge?delay_before_swap_ms=10000'), {}, { timeoutMs: 240_000 });
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const r = await box.send(MARKER_PROMPT);
        if (r.statusCode === 503) throw new Error('the send answered 503 while a convergence was parked');
        r.status(200);
        const body = r.json<any>();
        if (!body?.info || !Array.isArray(body?.parts)) {
          throw new Error(`the send did not answer with a message: ${JSON.stringify(body).slice(0, 200)}`);
        }
        const held = await parked;
        // The convergence that found a turn defers; it never reports `applied`
        // over a turn it ended.
        if (held.statusCode === 200 && held.json<any>()?.outcome === 'applied') {
          const open = await openAssistantRows();
          if (open.length > 0) throw new Error(`the swap left assistant rows open: ${open.join(', ')}`);
        }
        const open = await openAssistantRows();
        if (open.length > 0) throw new Error(`assistant rows never completed: ${open.join(', ')}`);
      });

      await ctx.step('an IDLE session still converges: the deferral is not the new normal', async () => {
        // The fix must not turn every convergence into a deferral. With nobody
        // prompting, a base move still reaches the box.
        const marker = 'marker-idle';
        const started = Date.now();
        await fixture.commit({ '.kortix/opencode/agents/kortix.md': MARKER_AGENT(marker) }, marker);
        const converged = await waitFor(() => box.releaseOf(), {
          until: (rel) => Boolean(rel) && rel.running_release_id === rel.desired_release_id && rel.proven === true,
          timeoutMs: 300_000,
          intervalMs: 3_000,
          description: 'an idle box converges on the new release',
        });
        const took = Date.now() - started;
        console.log(`[CFG-12] idle convergence took ${took} ms`);
        if (converged.fallback_reason !== null) {
          throw new Error(`the idle convergence reported a fallback: ${converged.fallback_reason}`);
        }
        // A deferral that never resolves would time out above. This catches the
        // softer regression: a convergence that still lands, but only after the
        // gate has deferred it several times over. Dev measured 8.5-15.4 s end
        // to end; the ceiling is 4x that plus one poll interval, which is wide
        // enough for a shared preview host and far below a deferral loop.
        if (took > IDLE_CONVERGENCE_CEILING_MS) {
          throw new Error(
            `an idle convergence took ${took} ms, over the ${IDLE_CONVERGENCE_CEILING_MS} ms ceiling ` +
              '(dev measures 8.5-15.4 s); the fix must not turn a convergence into a deferral',
          );
        }
      });

      await ctx.step('DEF-DEV-2: the answer comes from the CURRENT instructions, not the conversation', async () => {
        const marker2 = 'marker2-delta';
        const before = String((await box.releaseOf())?.running_release_id ?? '');
        await fixture.commit(
          { '.kortix/opencode/agents/kortix.md': MARKER2_AGENT('marker-stale-on-purpose', marker2) },
          marker2,
        );
        // Ask only once the BOX is serving it. A wrong answer before that would
        // say the push had not landed, not that the prompt was stale.
        await waitFor(() => box.releaseOf(), {
          until: (rel) =>
            Boolean(rel) &&
            rel.running_release_id === rel.desired_release_id &&
            rel.proven === true &&
            rel.running_release_id !== before,
          timeoutMs: 300_000,
          intervalMs: 3_000,
          description: 'the box serves the RELOAD_VERIFY_MARKER2 release',
        });
        const r = await box.send(MARKER2_PROMPT);
        r.status(200);
        const answer = await answerTo(MARKER2_PROMPT);
        if (!answer.includes(marker2)) {
          throw new Error(
            `DEF-DEV-2: the model did not answer from the current instructions: ${answer.slice(0, 200)}`,
          );
        }
      });

      await ctx.step('nothing was half-written: no assistant row is still open', async () => {
        const open = await openAssistantRows();
        if (open.length > 0) throw new Error(`assistant rows never completed: ${open.join(', ')}`);
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

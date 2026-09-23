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
import type { FlowContext, TeamFixture } from '../core/types';

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
  repo: ProjectRepo;
  sessions: string[];
  mint(opts?: { repositoryAccess?: boolean; agentName?: string; projectId?: string; repositoryGeneration?: string }): Promise<SessionToken>;
  descriptor(secret: string | null, sessionId: string, body?: unknown): Promise<{ status: number; body: any }>;
  download(secret: string | null, treeId: string): Promise<{ status: number; bytes: Buffer; source: string | null }>;
  /** Commit files onto the base branch of the project repository. Returns the new tip. */
  commit(files: Record<string, string>, message: string): Promise<string>;
  /** Open another project's repository with the same credential. */
  openRepo(projectId: string): Promise<ProjectRepo>;
  /** `GET .../sessions/:sessionId/config` as the project owner. */
  configState(sessionId: string): Promise<{ status: number; body: any }>;
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
        [sessionId, team.id, projectId, opts.agentName ?? 'kortix', JSON.stringify(metadata), ctx.P.OWNER.userId],
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
    routes: [MINT, DESCRIPTOR, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      const sibling = await fixture.mint();
      const otherProject = await fixture.team.project();

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
    routes: [MINT, DESCRIPTOR, ARCHIVE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
      let descriptor!: Descriptor;
      let firstBytes!: Buffer;

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
    routes: [MINT, DESCRIPTOR, ARCHIVE, 'POST /v1/projects/:projectId/secrets', ...GIT_PROXY],
  },
  async (ctx) => {
    const { randomBytes } = await import('node:crypto');
    const fixture = await setup(ctx);
    try {
      const value = `ke2e-cfg-secret-${randomBytes(16).toString('hex')}`;
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
    routes: [MINT, DESCRIPTOR, ARCHIVE, ...GIT_PROXY],
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
    routes: [MINT, CONFIG_STATE, ...GIT_PROXY],
  },
  async (ctx) => {
    const fixture = await setup(ctx);
    try {
      const own = await fixture.mint();
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

// ── CFG-7 — a previous-repository session receives no release ──────────────
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
    routes: [MINT, DESCRIPTOR, ARCHIVE, CONFIG_STATE, ...GIT_PROXY],
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

      await ctx.step('the previous-repository session gets 409 session_repository_changed for the descriptor and the archive', async () => {
        const r = await fixture.descriptor(old.secret, old.sessionId);
        if (r.status !== 409) throw new Error(`descriptor: expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body?.error !== 'Session belongs to a previous repository' || r.body?.code !== 'session_repository_changed') {
          throw new Error(`descriptor body ${JSON.stringify(r.body)}`);
        }
        const download = await fixture.download(old.secret, oldDescriptor.config_tree_id!);
        if (download.status !== 409) throw new Error(`archive: expected 409, got ${download.status}`);
        const body = JSON.parse(download.bytes.toString());
        if (body.code !== 'session_repository_changed') throw new Error(`archive body ${download.bytes.toString()}`);
      });

      await ctx.step('GET /config for the previous-repository session reports stale false', async () => {
        const r = await fixture.configState(old.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.stale !== false) throw new Error(`stale ${r.body.stale}`);
        if (r.body.latest_etag !== null) throw new Error('a frozen session compiled the new repository');
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

// ── CFG-8 — the `config_releases` feature flag, off and back on ────────────
//
// The flag's authority is the boot/start of a box, but the API side of it is
// the descriptor route and the archive route: OFF ⇒ both answer 403
// `feature_disabled`, the box then reads its workspace config dir, and no
// release is built, stored, or recorded. This flow drives the toggle through
// the published write path and asserts both directions.
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
    const setFlag = async (enabled: boolean | null) => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'config_releases', enabled },
          { params: { projectId: fixture.projectId } },
        );
      r.status(200);
    };
    try {
      const own = await fixture.mint();
      let treeId!: string;

      await ctx.step('the flag is ON by default: the session receives a release', async () => {
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        if (!HEX64.test(r.body.release_id)) throw new Error(`release_id ${r.body.release_id}`);
        treeId = r.body.config_tree_id;
        if (!HEX40.test(treeId)) throw new Error(`config_tree_id ${treeId}`);
        const catalog = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId', { params: { projectId: fixture.projectId } });
        catalog.status(200);
        const flags = catalog.json<{ experimental: Record<string, boolean> }>().experimental;
        if (flags.config_releases !== true) throw new Error('config_releases is not on by default');
      });

      await ctx.step('turning it OFF makes the descriptor route answer 403 feature_disabled', async () => {
        await setFlag(false);
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

      await ctx.step('clearing the override returns the project to the ON default', async () => {
        await setFlag(null);
        const r = await fixture.descriptor(own.secret, own.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
      });
    } finally {
      await setFlag(null).catch(() => {});
      await fixture.cleanup();
    }
  },
);

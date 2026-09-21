/**
 * Config releases — the descriptor route and the archive route
 * (docs/specs/config-releases.md, "Routes"). Maps to spec §CFG-*.
 *
 * A session's sandbox token is minted the way the daemon's `KORTIX_TOKEN` is:
 * an account token bound by SQL to one project and one session, with a live
 * `session_sandboxes` row. No cloud sandbox runs.
 *
 * On the local target the project repository is a bare repository on disk.
 * The flow commits a config dir into it with the real Git CLI. On a deployed
 * target the project is seeded with the starter, which ships a config dir.
 */
import { flow } from '../core/flow';
import type { FlowContext, TeamFixture } from '../core/types';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DESCRIPTOR = 'POST /v1/projects/:projectId/sessions/:sessionId/config-release';
const ARCHIVE = 'GET /v1/projects/:projectId/config-archives/:configTreeId';
const MINT = 'POST /v1/accounts/tokens';

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

interface Fixture {
  ctx: FlowContext;
  db: import('pg').Client;
  team: TeamFixture;
  projectId: string;
  /** Filesystem path of the bare repository on the local target, else null. */
  localRepo: string | null;
  sessions: string[];
  mint(opts?: { repositoryAccess?: boolean; agentName?: string; projectId?: string }): Promise<SessionToken>;
  descriptor(secret: string | null, sessionId: string, body?: unknown): Promise<{ status: number; body: any }>;
  download(secret: string | null, treeId: string): Promise<{ status: number; bytes: Buffer; source: string | null }>;
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
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString()}`)),
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

async function setup(ctx: FlowContext): Promise<Fixture> {
  const { randomUUID } = await import('node:crypto');
  const { Client: PgClient } = await import('pg');
  const team = await ctx.fixtures.team();
  const local = ctx.env.target === 'local';
  const project = await team.project(local ? { managedGit: true } : { seed: true });
  const databaseUrl = ctx.env.databaseUrl!;
  const db = new PgClient({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  await db.connect();
  const sessions: string[] = [];
  const origin = ctx.env.apiUrl.replace(/\/v1$/, '');

  let localRepo: string | null = null;
  if (local) {
    const { rows } = await db.query('SELECT repo_url FROM kortix.projects WHERE project_id = $1', [project.id]);
    const repoUrl = String(rows[0]?.repo_url ?? '');
    if (!repoUrl.startsWith('/')) throw new Error(`local project repo_url is not a path: ${repoUrl}`);
    localRepo = repoUrl;
  }

  const fixture: Fixture = {
    ctx,
    db,
    team,
    projectId: project.id,
    localRepo,
    sessions,
    async mint(opts = {}) {
      const sessionId = randomUUID();
      const projectId = opts.projectId ?? project.id;
      sessions.push(sessionId);
      const created = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: `CFG session ${sessionId.slice(0, 8)}` });
      created.status(201);
      const { token_id: tokenId, secret_key: secret } = created.json<{ token_id: string; secret_key: string }>();
      ctx.track('token', tokenId);
      const metadata =
        opts.repositoryAccess === false ? { workspace_mode: 'none', repository_access: false } : { workspace_mode: 'branch' };
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
    async descriptor(secret, sessionId, body = { workspace: null }) {
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

  if (localRepo) {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const work = await mkdtemp(join(tmpdir(), 'ke2e-cfg-work-'));
    try {
      await run('git', ['clone', '-q', localRepo, '.'], work);
      for (const [path, body] of Object.entries(CONFIG_FILES)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), body);
      }
      await run('git', ['add', '-A'], work);
      await run('git', ['-c', 'user.name=KE2E', '-c', 'user.email=ke2e@kortix.invalid', 'commit', '-qm', 'config dir'], work);
      await run('git', ['push', '-q', 'origin', 'HEAD:main'], work);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return fixture;
}

async function baseTip(fixture: Fixture): Promise<string | null> {
  if (!fixture.localRepo) return null;
  const out = (await run('git', ['ls-remote', fixture.localRepo, 'refs/heads/main'], '/')).toString();
  return out.split(/\s+/)[0] ?? null;
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

// ── CFG-1 — descriptor route authentication and body validation ────────────
flow(
  'CFG-1',
  {
    domain: 'config-releases',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [MINT, DESCRIPTOR],
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
      await ctx.step('malformed bodies are rejected with 400 and name the problem', async () => {
        const cases: Array<[string, unknown]> = [
          ['invalid JSON', '{"workspace":'],
          ['a non-object body', '"report"'],
          ['an unknown top-level key', { workspace: null, descriptor: {} }],
          ['a short head', { workspace: { head: 'abc', config_dir: '.kortix/opencode', changed: [] } }],
          [
            'a deleted file with a blob',
            {
              workspace: {
                head: 'a'.repeat(40),
                config_dir: '.kortix/opencode',
                changed: [{ path: '.kortix/opencode/x.md', status: 'deleted', blob: 'b'.repeat(40) }],
              },
            },
          ],
          [
            'an unknown status',
            {
              workspace: {
                head: 'a'.repeat(40),
                config_dir: '.kortix/opencode',
                changed: [{ path: '.kortix/opencode/x.md', status: 'renamed', blob: 'b'.repeat(40) }],
              },
            },
          ],
        ];
        for (const [label, body] of cases) {
          const r = await fixture.descriptor(own.secret, own.sessionId, body);
          if (r.status !== 400) throw new Error(`${label}: expected 400, got ${r.status}`);
          const named = typeof r.body === 'string' ? r.body : (r.body?.message ?? r.body?.error);
          if (!named) throw new Error(`${label}: 400 without an error message`);
        }
      });
      await ctx.step('a well-formed workspace report is accepted (200)', async () => {
        const head = (await baseTip(fixture)) ?? 'a'.repeat(40);
        const r = await fixture.descriptor(own.secret, own.sessionId, {
          workspace: {
            head,
            config_dir: '.kortix/opencode',
            changed: [
              { path: '.kortix/opencode/agents/kortix.md', status: 'modified', blob: 'c'.repeat(40) },
              { path: '.kortix/opencode/skills/x/SKILL.md', status: 'deleted', blob: null },
            ],
          },
        });
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
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
    routes: [MINT, DESCRIPTOR, ARCHIVE],
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
        if (tip && descriptor.source_commit !== tip) {
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
        if (fixture.localRepo) {
          for (const path of ['opencode.json', 'agents/kortix.md', 'skills/demo/SKILL.md', 'tools/hello.ts']) {
            if (!files.has(path)) throw new Error(`archive lacks ${path}`);
          }
          if (files.get('notes.md')?.toString() !== 'kept verbatim\n') throw new Error('export-ignore dropped notes.md');
          if (files.get('version.txt')?.toString() !== 'commit $Format:%H$\n') {
            throw new Error('export-subst rewrote version.txt');
          }
        }
      });

      await ctx.step('a second download returns byte-identical bytes', async () => {
        const r = await fixture.download(own.secret, descriptor.config_tree_id!);
        if (r.status !== 200 || !r.bytes.equals(firstBytes)) throw new Error('the archive bytes changed between downloads');
      });

      if (fixture.localRepo) {
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
        // The starter on a deployed target declares `kortix`; the local fixture
        // manifest also declares `reviewer`.
        const restricted = await fixture.mint({
          repositoryAccess: false,
          agentName: fixture.localRepo ? 'reviewer' : 'kortix',
        });
        const r = await fixture.descriptor(restricted.secret, restricted.sessionId);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        const d = r.body as Descriptor;
        if (d.archive !== null || d.files !== null) throw new Error('restricted session received an archive or files');
        if (d.reason !== 'repository access withheld') throw new Error(`reason ${d.reason}`);
        if (!d.compiled_governance) throw new Error('restricted session lost its compiled governance');
        const agents = Object.keys(JSON.parse(d.compiled_governance).agent ?? {});
        if (fixture.localRepo && (agents.length !== 1 || agents[0] !== 'reviewer')) {
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
    routes: [MINT, DESCRIPTOR, ARCHIVE, 'POST /v1/projects/:projectId/secrets'],
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

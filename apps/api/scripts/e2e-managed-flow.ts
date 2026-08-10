/**
 * Live end-to-end test of the managed project flow — start to end.
 *
 * This is NOT a unit test: it runs against a REAL backend + REAL managed git
 * (and exercises the real session-create path). Run it on demand:
 *
 *     cd apps/api && bun run scripts/e2e-managed-flow.ts
 *
 * Env:
 *   BACKEND_URL   backend to hit (default http://localhost:8008)
 *
 * It mints a CLI PAT for a local owner account, then walks the whole flow:
 *   provision (web "Create project", seeded) → verify starter in repo →
 *   clone + push exactly the way `kortix ship` does → create session (the path
 *   that 403'd) → delete session → rm --purge → confirm the repo is gone.
 * Exits non-zero if any step fails. Cleans up everything it created.
 *
 * The git steps deliberately resolve their remote + credential the SAME way the
 * CLI does (see apps/cli/src/project-git.ts): the Kortix git proxy origin with
 * our own PAT when the host advertises one, a minted provider token against the
 * raw upstream only when it doesn't. An earlier version always minted a token
 * and pushed the raw upstream — a path no client actually takes — so it stayed
 * green while `kortix ship` was 100% broken against a host whose managed git
 * runs on an org-wide PAT (POST /git-token fails closed there, by design).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';

const execFileAsync = promisify(execFile);
const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const PAT_NAME = 'e2e-managed-flow';

let passed = 0;
let failed = 0;
const log = (m: string) => console.log(m);
function ok(msg: string) { passed += 1; log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function assert(cond: unknown, msg: string, detail = ''): asserts cond {
  if (cond) { ok(msg); return; }
  failed += 1;
  log(`  \x1b[31m✗ ${msg}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  throw new Error(`step failed: ${msg}`);
}

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BACKEND}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function gitEnvArgs(token: string): string[] {
  const enc = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${enc}`];
}

/** Mirrors apps/cli/src/project-git.ts — keep the two in step. */
function isGitProxyUrl(url: string | undefined | null): boolean {
  return Boolean(url && /\/v1\/git\//.test(url));
}

/**
 * Resolve the remote + credential a real client would use for this project.
 * Proxy origin ⇒ our own PAT (no provider credential ever leaves the server);
 * proxy-less host ⇒ a repo-scoped provider token from POST /git-token.
 */
async function resolveClientGitTarget(
  project: any,
  token: string,
): Promise<{ repoUrl: string; gitToken: string; via: string }> {
  if (isGitProxyUrl(project.git_origin_url)) {
    return { repoUrl: project.git_origin_url, gitToken: token, via: 'git proxy + CLI PAT' };
  }
  const tk = await api('POST', `/projects/${project.project_id}/git-token`, token);
  assert(
    tk.status === 200 && tk.json.push_token,
    'git-token minted (proxy-less host)',
    `${tk.status} ${JSON.stringify(tk.json)}`,
  );
  return { repoUrl: project.repo_url, gitToken: tk.json.push_token, via: 'minted provider token' };
}

async function main() {
  log(`\n\x1b[1m[e2e] managed project flow\x1b[0m  →  ${BACKEND}\n`);

  // ── 0. backend reachable ────────────────────────────────────────────────
  const health = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  assert(health === 200, `backend healthy`, `GET /health → ${health}`);

  // ── 1. mint a PAT for a local owner account ─────────────────────────────
  const owner = (await db.select().from(accountMembers).limit(50)).find((m) => m.accountRole === 'owner');
  assert(owner, 'found a local owner account');
  const token = (await createAccountToken({ accountId: owner!.accountId, userId: owner!.userId, name: PAT_NAME })).secretKey;
  ok('minted e2e PAT');

  let workspaceId = '';
  let sessionId = '';

  try {
    // ── 2. provision (web "Create project", seeded) ───────────────────────
    const prov = await api('POST', '/projects/provision', token, {
      account_id: owner!.accountId,
      name: `e2e flow ${Date.now()}`,
      seed_starter: true,
    });
    assert(prov.status === 201, 'provision → 201', `${prov.status} ${JSON.stringify(prov.json)}`);
    assert(prov.json.seeded === true, 'repo seeded server-side');
    assert(prov.json.metadata?.git?.managed === true, 'metadata.git.managed = true');
    assert(typeof prov.json.metadata?.git?.provider === 'string', 'metadata.git.provider is set');
    assert(typeof prov.json.dashboard_url === 'string' && !prov.json.dashboard_url.includes('/v1'), 'dashboard_url is the web URL');
    workspaceId = prov.json.project_id;

    // ── 3. seeded starter actually landed in the repo ─────────────────────
    // Resolved the way a client resolves it — NOT by always minting a token.
    const git = await resolveClientGitTarget(prov.json, token);
    ok(`client git target: ${git.via}`);
    const dir = await mkdtemp(join(tmpdir(), 'e2e-flow-'));
    await execFileAsync('git', [...gitEnvArgs(git.gitToken), 'clone', '-q', git.repoUrl, dir]);
    const tracked = (await execFileAsync('git', ['-C', dir, 'ls-files'])).stdout;
    assert(tracked.includes('kortix.yaml'), 'seeded repo contains kortix.yaml');
    assert(tracked.includes('.kortix/opencode/opencode.jsonc'), 'seeded repo contains .kortix/opencode/opencode.jsonc');

    // ── 4. CLI "ship": commit + push current branch to the project origin ─
    await writeFile(join(dir, 'E2E.md'), `e2e ${new Date().toISOString()}\n`);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'e2e@kortix.ai']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'e2e']);
    await execFileAsync('git', ['-C', dir, 'add', '-A']);
    await execFileAsync('git', ['-C', dir, 'commit', '-q', '-m', 'e2e edit']);
    const head = (await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFileAsync('git', ['-C', dir, ...gitEnvArgs(git.gitToken), 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
    ok('pushed an update to the managed repo (ship)');

    // The push must be visible on the real upstream, not just accepted locally.
    const remoteMain = (
      await execFileAsync('git', ['-C', dir, ...gitEnvArgs(git.gitToken), 'ls-remote', 'origin', 'refs/heads/main'])
    ).stdout.trim();
    assert(remoteMain.startsWith(head), 'origin/main advanced to the pushed commit', remoteMain);
    await rm(dir, { recursive: true, force: true });

    // ── 5. create a session (the path that 403'd on managed git) ──────────
    const sess = await api('POST', `/projects/${workspaceId}/sessions`, token, {});
    assert(
      sess.status >= 200 && sess.status < 300,
      'session create succeeds (managed git auth resolves — no 403/502)',
      `${sess.status} ${JSON.stringify(sess.json)}`,
    );
    sessionId = sess.json?.session_id ?? sess.json?.id ?? '';
    ok(`session created${sessionId ? ` (${sessionId})` : ''}`);
  } finally {
    // ── 6. cleanup ────────────────────────────────────────────────────────
    if (sessionId && workspaceId) {
      await api('DELETE', `/projects/${workspaceId}/sessions/${sessionId}`, token).catch(() => undefined);
    }
    if (workspaceId) {
      const del = await api('DELETE', `/projects/${workspaceId}?purge=true`, token);
      assert(del.status === 200, 'rm --purge → 200', `${del.status} ${JSON.stringify(del.json)}`);
      assert(del.json?.repo_deleted === true, 'managed repo deleted on purge');
    }
    await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => undefined);
  }

  log(`\n\x1b[1m[e2e] ${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  log(`\n\x1b[31m[e2e] FAILED: ${err?.message || err}\x1b[0m`);
  log(`\x1b[1m[e2e] ${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(1);
});

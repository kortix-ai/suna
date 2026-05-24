/**
 * Benchmark the synchronous POST /sessions critical path to attribute the
 * "session create took N seconds" wall time to its sub-steps.
 *
 *   cd apps/api && PROJECT_ID=<uuid> bun run scripts/bench-session-create.ts
 *
 * Times, against the project's REAL git remote (Freestyle/GitHub):
 *   - POST /git-token            (≈ resolveProjectGitAuth → mintRepoPushToken)
 *   - git ls-remote              (network RTT baseline to the remote)
 *   - git fetch --depth=1 tip    (what createRemoteSessionBranch fetches)
 *   - git push (create branch)   (what createRemoteSessionBranch pushes)
 *   - POST /sessions (full)      (the end-to-end number the user sees)
 * Cleans up the branches + session it creates.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, projects } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';

const execFileAsync = promisify(execFile);
const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const PAT_NAME = 'bench-session-create';

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BACKEND}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function authArgs(token: string): string[] {
  const enc = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${enc}`];
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`  ${label.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(2)}s`);
    return r;
  } catch (e) {
    console.log(`  ${label.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(2)}s  ✗ ${(e as Error).message?.slice(0, 80)}`);
    throw e;
  }
}

async function main() {
  const owner = (await db.select().from(accountMembers).limit(50)).find((m) => m.accountRole === 'owner');
  if (!owner) throw new Error('no owner');
  let projectId = process.env.PROJECT_ID || '';
  const [proj] = projectId
    ? await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1)
    : await db.select().from(projects).where(eq(projects.accountId, owner.accountId)).limit(1);
  if (!proj) throw new Error('no project');
  projectId = proj.projectId;
  const base = proj.defaultBranch || 'main';
  console.log(`\n[bench] project ${proj.name} (${projectId})\n  repo ${proj.repoUrl}\n  base ${base}\n`);

  const token = (await createAccountToken({ accountId: owner.accountId, userId: owner.userId, name: PAT_NAME })).secretKey;
  const benchBranch = `bench-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), 'bench-'));
  const sessionsToDelete: string[] = [];

  try {
    console.log('[bench] sub-steps on the create critical path:');
    const tk = await time('POST /git-token (mint push tok)', () => api('POST', `/projects/${projectId}/git-token`, token));
    const pushTok = tk.json?.push_token;
    if (!pushTok) throw new Error(`no push_token: ${tk.status} ${JSON.stringify(tk.json)}`);

    await time('git init --bare', () => execFileAsync('git', ['init', '--bare', join(dir, 'r.git')]));
    await execFileAsync('git', ['-C', join(dir, 'r.git'), 'remote', 'add', 'origin', proj.repoUrl!]);

    await time('git ls-remote (RTT baseline)', () =>
      execFileAsync('git', ['-C', join(dir, 'r.git'), ...authArgs(pushTok), 'ls-remote', '--heads', 'origin', base]));
    await time('git fetch --depth=1 base tip', () =>
      execFileAsync('git', ['-C', join(dir, 'r.git'), ...authArgs(pushTok), 'fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${base}:refs/heads/${base}`]));
    await time('git push (create branch)', () =>
      execFileAsync('git', ['-C', join(dir, 'r.git'), ...authArgs(pushTok), 'push', 'origin', `refs/heads/${base}:refs/heads/${benchBranch}`]));
    await time('git push --delete (cleanup)', () =>
      execFileAsync('git', ['-C', join(dir, 'r.git'), ...authArgs(pushTok), 'push', 'origin', `:refs/heads/${benchBranch}`]).catch(() => {}));

    console.log('\n[bench] full POST /sessions (end-to-end, x3):');
    for (let i = 1; i <= 3; i++) {
      const r = await time(`POST /sessions #${i}`, () => api('POST', `/projects/${projectId}/sessions`, token, { branch_already_created: false }));
      const sid = r.json?.session_id ?? r.json?.id;
      if (r.status >= 300) console.log(`     -> ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      if (sid) sessionsToDelete.push(sid);
    }
  } finally {
    console.log('\n[bench] cleanup…');
    for (const sid of sessionsToDelete) {
      await api('DELETE', `/projects/${projectId}/sessions/${sid}`, token).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => {});
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n[bench] FAILED: ${e?.message || e}\n`); process.exit(1); });

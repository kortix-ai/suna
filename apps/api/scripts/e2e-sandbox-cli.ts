/**
 * LIVE end-to-end test: prove the `kortix` CLI + injected token + git push work
 * inside a REAL Daytona sandbox — the exact flow that failed in the ref.json
 * transcript (commit → open a change request).
 *
 * Runs against a running dev API (+ real Daytona + managed git). It:
 *   1. mints an account PAT for an owner, picks an active project
 *   2. creates a session → real sandbox built from the layered Dockerfile
 *   3. waits for active + runtimeReady
 *   4. execs INSIDE the sandbox (Daytona toolbox): kortix --version, the token
 *      env, commit, `kortix cr open`, `git push origin HEAD`, `kortix cr ls`
 *   5. from the host, CURLs the API to confirm the CR exists WITH a real diff
 *      (which only happens if the push landed)
 *
 * Usage (from apps/api):
 *   KORTIX_URL=http://localhost:8008 bun run scripts/e2e-sandbox-cli.ts
 * Env:
 *   BACKEND_URL       default http://localhost:8008
 *   E2E_PROJECT_ID    project to use (default: first active project)
 *   READY_TIMEOUT_MS  default 600000 (10m — first build of the new layer is cold)
 *   KEEP=1            keep the session + CR + PAT
 */
import { and, desc, eq } from 'drizzle-orm';
import { accountMembers, accountTokens, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import { getDaytona } from '../src/shared/daytona';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 600_000);
const PAT_NAME = 'e2e-sandbox-cli';
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m: string) => console.log(`[${el()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(m: string) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); }
function bad(m: string) { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); }

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

async function main() {
  console.log(`\n=== LIVE sandbox CLI e2e → ${BACKEND} ===\n`);
  const health = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`backend not healthy (${health})`);

  // Pick a project + its owner.
  let projectId = process.env.E2E_PROJECT_ID || '';
  let projRow;
  if (projectId) {
    [projRow] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  } else {
    [projRow] = await db.select().from(projects).where(eq(projects.status, 'active')).limit(1);
  }
  if (!projRow) throw new Error('no active project found');
  projectId = projRow.projectId;
  const [owner] = await db.select().from(accountMembers)
    .where(and(eq(accountMembers.accountId, projRow.accountId), eq(accountMembers.accountRole, 'owner'))).limit(1);
  if (!owner) throw new Error('no owner for project account');
  log(`project ${projRow.name} (${projectId}) repo=${projRow.repoUrl}`);

  const token = (await createAccountToken({ accountId: owner.accountId, userId: owner.userId, name: PAT_NAME })).secretKey;

  let sessionId = '';
  try {
    // 1. create session → real sandbox
    const sess = await api('POST', `/projects/${projectId}/sessions`, token, {});
    if (sess.status < 200 || sess.status >= 300) throw new Error(`session create ${sess.status}: ${JSON.stringify(sess.json)}`);
    sessionId = sess.json?.session_id ?? sess.json?.id;
    log(`session ${sessionId} created — waiting for active (cold build can take minutes)…`);

    // 2. wait active + externalId
    let externalId = '';
    const tA = Date.now();
    for (;;) {
      const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).limit(1);
      const md = (row?.metadata ?? {}) as Record<string, any>;
      if (row?.status === 'error') throw new Error(`provision error: ${JSON.stringify(md.errorMessage ?? md.lastProvisioningError ?? md)}`);
      if (row?.status === 'active' && row.externalId) { externalId = row.externalId; break; }
      if (Date.now() - tA > READY_TIMEOUT_MS) throw new Error('timeout waiting for active');
      await sleep(1500);
    }
    log(`sandbox active: externalId=${externalId}  (create→active ${((Date.now() - tA) / 1000).toFixed(1)}s)`);

    // 3. wait runtimeReady (repo cloned + opencode up + git creds configured)
    const tR = Date.now();
    for (;;) {
      const r = await fetch(`${BACKEND}/v1/p/${externalId}/8000/kortix/health`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      const body = r ? await r.json().catch(() => null) : null;
      if (body?.runtimeReady === true) break;
      if (body?.boot_error) throw new Error(`boot_error: ${body.boot_error}`);
      if (Date.now() - tR > READY_TIMEOUT_MS) throw new Error('timeout waiting for runtimeReady');
      await sleep(1500);
    }
    log(`runtimeReady (active→ready ${((Date.now() - tR) / 1000).toFixed(1)}s)\n`);

    // 4. exec INSIDE the real sandbox. Run via plain `sh -c` (the toolbox
    // default) with NO HOME override — proving the repo-local credential helper
    // works regardless of the invoking shell's HOME (default is /root).
    const sandbox = await getDaytona().get(externalId);
    const sh = async (label: string, cmd: string, timeout = 60) => {
      const res = await sandbox.process.executeCommand(cmd, '/workspace', undefined, timeout);
      const out = (res.result ?? (res as any).artifacts?.stdout ?? '').toString();
      console.log(`\x1b[2m  $ ${label}  (exit ${res.exitCode}, HOME-default)\x1b[0m\n${out.split('\n').map((l) => '    ' + l).join('\n')}`);
      return { exit: res.exitCode, out };
    };

    const ver = await sh('which kortix && kortix --version', 'command -v kortix && kortix --version');
    ver.exit === 0 && /Kortix CLI/.test(ver.out) ? ok('kortix CLI installed on PATH inside the live sandbox') : bad('kortix CLI not found in sandbox');

    const env = await sh('token env', 'printf "CLI="; printenv KORTIX_CLI_TOKEN | cut -c1-11; printf "API="; printenv KORTIX_API_URL; printf "PROJ="; printenv KORTIX_PROJECT_ID; printf "BR="; printenv KORTIX_BRANCH_NAME');
    /CLI=kortix_pat_/.test(env.out) ? ok('KORTIX_CLI_TOKEN (project PAT) is injected into the sandbox env') : bad('KORTIX_CLI_TOKEN missing/!pat in sandbox env');

    const commit = await sh('commit a change', `printf 'live e2e %s\\n' "$(date -u +%FT%TZ)" > E2E_REALTEST.md && git add E2E_REALTEST.md && git commit -m "e2e: live sandbox CLI test" >/dev/null 2>&1 && git rev-parse --short HEAD`);
    commit.exit === 0 ? ok(`committed on session branch (${commit.out.trim().split('\n').pop()})`) : bad('commit failed');

    const push = await sh('git push origin HEAD', 'git push origin HEAD 2>&1', 90);
    push.exit === 0 && /\bHEAD ->|up-to-date/.test(push.out)
      ? ok('git push origin HEAD succeeded with default HOME (repo-local credential helper)')
      : bad('git push failed');

    const crOpen = await sh('kortix cr open', `kortix cr open --title "E2E live sandbox CLI" --description "Proves kortix CLI + injected token + git push inside a real Daytona sandbox." 2>&1`, 60);
    /Opened CR #\d+/.test(crOpen.out) ? ok('kortix cr open succeeded from inside the sandbox') : bad('kortix cr open failed');

    const crLs = await sh('kortix cr ls', 'kortix cr ls 2>&1', 45);
    /E2E live sandbox CLI/.test(crLs.out) ? ok('kortix cr ls shows the CR') : bad('kortix cr ls missing the CR');

    // 5. confirm from the host: CR exists + has a real diff (push landed)
    console.log('');
    const crs = await api('GET', `/projects/${projectId}/change-requests?status=open`, token);
    const cr = (crs.json?.change_requests ?? []).find((c: any) => c.title === 'E2E live sandbox CLI');
    cr ? ok(`API confirms CR #${cr.number} (${cr.cr_id})`) : bad('API does not list the CR');
    if (cr) {
      // give the API a moment to resolve live branch tips post-push
      let diff: any = null;
      for (let i = 0; i < 8; i++) {
        const d = await api('GET', `/projects/${projectId}/change-requests/${cr.cr_id}/diff`, token);
        if (d.status === 200 && (d.json?.files_changed ?? 0) > 0) { diff = d.json; break; }
        await sleep(1500);
      }
      diff && diff.files_changed > 0
        ? ok(`CR diff is non-empty: ${diff.files_changed} file(s), +${diff.additions}/-${diff.deletions} — the pushed commit reached the remote`)
        : bad('CR diff is empty — push did not reach the remote (the original failure)');
    }
  } finally {
    if (!process.env.KEEP) {
      if (sessionId) await api('DELETE', `/projects/${projectId}/sessions/${sessionId}`, token).catch(() => null);
      await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => undefined);
      log('cleaned up session + PAT (CR left for inspection)');
    }
  }

  console.log(`\n=== ${fail === 0 ? '\x1b[32mALL PASS' : '\x1b[31mFAILED'}\x1b[0m: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\nFAILED: ${e?.message || e}\n`); process.exit(1); });

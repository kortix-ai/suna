#!/usr/bin/env bun
/**
 * Compatibility gate for the S3 config provider, on a REAL S3-booted session:
 *
 *   boot (prefer-s3, provider s3) → write a file in the box → commit + authenticated push
 *   → read back through the API mirror (branch tip + file content)
 *   → pull/refresh (session reload) → Kortix change request → merge → base moved
 *   → an UNCOMMITTED edit survives stop/resume (warm adoption, no S3 attempt on resume)
 *   → another account's token cannot obtain this project's descriptor.
 *
 * Everything goes through the HTTP API and the sandbox proxy, exactly as the
 * dashboard and CLI do. Exit code 0 only when every step held.
 *
 *   bun run scripts/project-snapshot-compat.ts --api http://localhost:13608/v1 --jwt <jwt> \
 *     --project <id> --other-jwt <jwt-of-another-account> [--provider daytona]
 */
import { execFileSync } from 'node:child_process';

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: Array<{ step: string; ok: boolean; detail?: string }> = [];
function check(step: string, ok: boolean, detail?: string): void {
  checks.push({ step, ok, detail });
  console.error(`${ok ? '✓' : '✗'} ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${step}${detail ? ` — ${detail}` : ''}`);
}

async function call<T = any>(base: string, token: string, path: string, init: RequestInit = {}, json = true): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(json ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
}

const api = need('api');
const jwt = need('jwt');
const projectId = need('project');
const otherJwt = need('other-jwt');
const provider = arg('provider', 'daytona');

async function waitReady(sessionId: string): Promise<{ externalId: string; runtime: string }> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const s = await call(api, jwt, `/projects/${projectId}/sessions/${sessionId}/start`, { method: 'POST' });
    if (s.body?.stage === 'ready' && s.body.sandbox?.external_id) {
      const runtime = (s.body.runtime_url as string | undefined)?.replace(/^\/v1/, '') ?? `/p/${s.body.sandbox.external_id}/8000`;
      // Wait for the daemon's own readiness, not just the control plane's.
      while (Date.now() < deadline) {
        const h = await call(api, jwt, `${runtime}/kortix/health`);
        if (h.status === 200 && h.body?.runtimeReady === true) return { externalId: s.body.sandbox.external_id, runtime };
        await sleep(500);
      }
    }
    if (s.body?.stage === 'failed' && s.body?.retriable === false) throw new Error(`start failed: ${JSON.stringify(s.body.failure ?? s.body).slice(0, 300)}`);
    await sleep(500);
  }
  throw new Error('session never became ready');
}

async function upload(runtime: string, dir: string, name: string, content: string): Promise<void> {
  const form = new FormData();
  form.set('path', dir);
  form.set('filename', name);
  form.set('file', new File([content], name, { type: 'text/plain' }));
  const res = await fetch(`${api}${runtime}/file/upload`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: form });
  const text = await res.text();
  check(`upload ${dir}/${name} into the box`, res.status === 200, `${res.status} ${text.slice(0, 120)}`);
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  // Force the S3 path for this gate.
  execFileSync('psql', [DB_URL, '-At', '-c', `update kortix.projects set metadata = coalesce(metadata,'{}'::jsonb) || '{"project_snapshot_mode":"prefer-s3"}'::jsonb where project_id = '${projectId}'`]);

  const created = await call(api, jwt, `/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify(provider ? { provider } : {}) });
  check('create session (201)', created.status === 201, `${created.status}`);
  const sessionId: string = created.body.session_id ?? created.body.id;
  try {
    const { runtime } = await waitReady(sessionId);
    const health = await call(api, jwt, `${runtime}/kortix/health`);
    const cp = health.body?.config_provider ?? {};
    check('session booted from S3 (config_provider.provider = s3, sha matches)', cp.provider === 's3' && cp.sha_matches === true && cp.fallback === false, JSON.stringify({ provider: cp.provider, sha: cp.actual_sha, timings: cp.timings }));
    check('daemon reports the session branch checked out', health.body.branch === sessionId, `branch=${health.body.branch}`);

    // edit → commit → authenticated push (the box's credential helper + proxy)
    const fileName = `from-s3-session-${stamp}.txt`;
    const content = `written inside an S3-booted session at ${new Date().toISOString()}\n`;
    await upload(runtime, 'compat', fileName, content);
    const raw = await call(api, jwt, `${runtime}/file/raw?path=compat/${fileName}`, {}, false);
    check('file readable in the box', raw.status === 200 && raw.text === content, `${raw.status}`);
    const pushed = await call(api, jwt, `${runtime}/kortix/git/commit-push`, { method: 'POST', body: JSON.stringify({ message: `compat: ${fileName}` }) });
    check('commit + authenticated push from the box', pushed.status === 200 && pushed.body?.committed === true && pushed.body?.pushed === true, `${pushed.status} ${JSON.stringify(pushed.body).slice(0, 160)}`);
    const headSha: string = pushed.body.headSha;

    // read-back through the API's mirror
    let tipMatches = false;
    for (let i = 0; i < 20 && !tipMatches; i += 1) {
      const branches = await call(api, jwt, `/projects/${projectId}/branches`);
      const mine = (branches.body?.branches ?? branches.body ?? []).find?.((b: any) => b.name === sessionId);
      tipMatches = mine?.tip === headSha;
      if (!tipMatches) await sleep(1500);
    }
    check('API sees the pushed session branch at the pushed commit', tipMatches, headSha);
    // The content read goes through the API's bare mirror, which refreshes on
    // its own interval (KORTIX_GIT_REFRESH_INTERVAL_MS, 60 s) — poll past it.
    let readBack = await call(api, jwt, `/projects/${projectId}/files/content?path=compat/${fileName}&ref=${sessionId}`);
    for (let i = 0; i < 40 && readBack.status !== 200; i += 1) {
      await sleep(3000);
      readBack = await call(api, jwt, `/projects/${projectId}/files/content?path=compat/${fileName}&ref=${sessionId}`);
    }
    check('file content read back from the API at the session branch', readBack.status === 200 && JSON.stringify(readBack.body).includes(fileName.slice(0, 8)), `${readBack.status} ${readBack.text.slice(0, 100)}`);

    // pull / refresh (the reload the dashboard offers)
    const reload = await call(api, jwt, `/projects/${projectId}/sessions/${sessionId}/reload`, { method: 'POST', body: JSON.stringify({ refresh_repo: true }) });
    check('session reload (refresh repo) succeeds', reload.status === 200, `${reload.status} ${reload.text.slice(0, 120)}`);

    // Kortix change request → merge (not a GitHub PR)
    const cr = await call(api, jwt, `/projects/${projectId}/change-requests`, {
      method: 'POST',
      body: JSON.stringify({ title: `compat ${stamp}`, head_ref: sessionId, base_ref: 'main', session_id: sessionId }),
    });
    check('change request created', cr.status === 201, `${cr.status} ${cr.text.slice(0, 120)}`);
    const crId: string = cr.body.id ?? cr.body.cr_id ?? cr.body.change_request?.id;
    const merged = await call(api, jwt, `/projects/${projectId}/change-requests/${crId}/merge`, { method: 'POST', body: JSON.stringify({}) });
    check('change request merged into main', merged.status === 200 && typeof merged.body?.merge?.base_sha_after === 'string', `${merged.status} ${merged.text.slice(0, 160)}`);
    const baseAfter: string = merged.body.merge.base_sha_after;
    const onMain = await call(api, jwt, `/projects/${projectId}/files/content?path=compat/${fileName}&ref=main`);
    check('merged file is on main', onMain.status === 200, `${onMain.status}`);
    let queued = '';
    for (let i = 0; i < 20 && !queued; i += 1) {
      queued = execFileSync('psql', [DB_URL, '-At', '-c', `select status from kortix.project_snapshot_archives where project_id='${projectId}' and commit_sha='${baseAfter}'`], { encoding: 'utf8' }).trim();
      if (!queued) await sleep(1000);
    }
    check('merge enqueued a snapshot for the new base tip', ['queued', 'building', 'ready'].includes(queued), `${baseAfter} → ${queued || 'absent'}`);

    // an UNCOMMITTED local edit survives stop → resume, and resume never re-acquires
    const scratch = `uncommitted-${stamp}.txt`;
    await upload(runtime, 'compat', scratch, 'not committed\n');
    const stopped = await call(api, jwt, `/projects/${projectId}/sessions/${sessionId}/stop`, { method: 'POST', body: JSON.stringify({}) });
    check('session stopped', stopped.status === 200 || stopped.status === 202, `${stopped.status} ${stopped.text.slice(0, 100)}`);
    await sleep(3000);
    const resumed = await waitReady(sessionId);
    const health2 = await call(api, jwt, `${resumed.runtime}/kortix/health`);
    const cp2 = health2.body?.config_provider ?? {};
    check('resume adopts the existing workspace (no S3 attempt, provider git/warm)', cp2.s3_attempted === false && cp2.provider === 'git', JSON.stringify({ provider: cp2.provider, s3_attempted: cp2.s3_attempted, timings: cp2.timings }));
    const rawScratch = await call(api, jwt, `${resumed.runtime}/file/raw?path=compat/${scratch}`, {}, false);
    check('uncommitted edit survived stop/resume', rawScratch.status === 200 && rawScratch.text === 'not committed\n', `${rawScratch.status}`);
    check('resumed session still on its branch with the pushed commit', health2.body.branch === sessionId && health2.body.commit_sha === headSha, `${health2.body.branch}@${health2.body.commit_sha}`);

    // authorization: another account cannot obtain this project's descriptor
    const otherPat = await call(api, otherJwt, '/accounts/tokens', { method: 'POST', body: JSON.stringify({ name: `compat-other-${stamp}` }) });
    check('other account minted its own PAT', otherPat.status === 201, `${otherPat.status}`);
    const shaOnMain = execFileSync('psql', [DB_URL, '-At', '-c', `select commit_sha from kortix.project_snapshot_archives where project_id='${projectId}' and status='ready' order by ready_at desc limit 1`], { encoding: 'utf8' }).trim();
    const denied = await call(api, otherPat.body.secret_key, `/git/${projectId}.git/project-snapshot?sha=${shaOnMain}`);
    check('descriptor refused for another account (no URL leaked)', [401, 403, 404].includes(denied.status) && !denied.text.includes('X-Amz-'), `${denied.status}`);
    const own = await call(api, jwt, `/git/${projectId}.git/project-snapshot?sha=${shaOnMain}`);
    check('owner JWT is not a git-proxy credential either (401), only sandbox/PAT tokens are', own.status === 401, `${own.status}`);
  } finally {
    await call(api, jwt, `/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
}

try {
  await main();
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), checks }, null, 2));
  process.exit(1);
}

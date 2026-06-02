/**
 * Full-stack boot benchmark.
 *
 * Drives the REAL flow against a running API + Daytona and prints a phase
 * breakdown for each session boot:
 *
 *   session-create (HTTP)          API round-trip to register the session
 *   create → active                Daytona create + snapshot resolve/build
 *     └─ row+tokens / image-* / provider-create   (from ProvisionTimeline)
 *   active → runtimeReady          in-box git clone + opencode boot
 *
 * Usage (from apps/api, with the live tunnel URL):
 *   KORTIX_URL=<tunnel> BACKEND_URL=http://localhost:8008 \
 *     bun run scripts/bench-boot.ts
 *
 * Env:
 *   BACKEND_URL        default http://localhost:8008
 *   BENCH_PROJECT_ID   project to boot. If unset and BENCH_CREATE=1, a fresh
 *                      project is provisioned first (and its create time logged).
 *   BENCH_CREATE=1     provision a new project (Freestyle + seed starter) first
 *   BENCH_ITERS        number of boots to run (default 2: 1 cold-ish + 1 warm)
 *   READY_TIMEOUT_MS   default 300000 (5m)
 *   KEEP=1             don't delete sessions / archive the created project
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  accountMembers,
  accountTokens,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 300_000);
const ITERS = Number(process.env.BENCH_ITERS || 2);
const PAT_NAME = 'bench-boot';

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m: string) => console.log(`[${el()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface BootResult {
  iter: number;
  httpMs: number;
  createToActiveMs: number;
  activeToReadyMs: number;
  totalMs: number;
  imageCached: boolean;
  marks: Array<{ label: string; atMs: number; deltaMs: number }>;
  inboxTimeline: Array<{ label: string; atMs: number }>;
}

async function bootOnce(projectId: string, token: string, iter: number): Promise<BootResult> {
  const tHttp = Date.now();
  const sess = await api('POST', `/projects/${projectId}/sessions`, token, {});
  if (sess.status < 200 || sess.status >= 300) {
    throw new Error(`session create failed: ${sess.status} ${JSON.stringify(sess.json)}`);
  }
  const sessionId = sess.json?.session_id ?? sess.json?.id ?? '';
  const httpMs = Date.now() - tHttp;
  log(`  iter ${iter}: session ${sessionId.slice(0, 8)} created (HTTP ${httpMs}ms)`);

  const tCreate = Date.now();
  let activeAt = 0;
  let marks: Array<{ label: string; atMs: number; deltaMs: number }> = [];
  let externalId = '';
  for (;;) {
    const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).limit(1);
    const md = (row?.metadata ?? {}) as Record<string, any>;
    if (row?.status === 'error') {
      throw new Error(`provision errored: ${JSON.stringify(md.errorMessage ?? md.lastProvisioningError ?? md)}`);
    }
    if (row?.status === 'active' && row.externalId) {
      externalId = row.externalId;
      activeAt = Date.now();
      marks = (md.provisionTimeline?.marks ?? []) as typeof marks;
      break;
    }
    if (Date.now() - tCreate > READY_TIMEOUT_MS) throw new Error('timed out waiting for active');
    await sleep(400);
  }
  const createToActiveMs = activeAt - tCreate;
  const imageCached = marks.some((m) => m.label === 'image-cached');

  // Phase 2: active → runtimeReady
  const healthUrl = `${BACKEND}/v1/p/${externalId}/8000/kortix/health`;
  let readyAt = 0;
  let inboxTimeline: Array<{ label: string; atMs: number }> = [];
  for (;;) {
    const r = await fetch(healthUrl, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    const body = r ? await r.json().catch(() => null) : null;
    if (Array.isArray(body?.boot_timeline) && body.boot_timeline.length) inboxTimeline = body.boot_timeline;
    if (body?.runtimeReady === true) { readyAt = Date.now(); break; }
    if (body?.boot_error) throw new Error(`boot_error: ${body.boot_error}`);
    if (Date.now() - activeAt > READY_TIMEOUT_MS) throw new Error('timed out waiting for runtimeReady');
    await sleep(800);
  }
  const activeToReadyMs = readyAt - activeAt;

  // cleanup this session unless KEEP
  if (!process.env.KEEP) {
    await api('DELETE', `/projects/${projectId}/sessions/${sessionId}`, token).catch(() => null);
  }

  return {
    iter,
    httpMs,
    createToActiveMs,
    activeToReadyMs,
    totalMs: httpMs + createToActiveMs + activeToReadyMs,
    imageCached,
    marks,
    inboxTimeline,
  };
}

async function main() {
  console.log(`\n[bench] full-stack boot benchmark  →  ${BACKEND}\n`);
  const health = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`backend not healthy: GET /health → ${health}`);

  let projectId = process.env.BENCH_PROJECT_ID || '';
  let createdProject = false;

  // Resolve the owner account for the chosen project (or first owner if creating).
  let ownerAccountId = '';
  let ownerUserId = '';
  if (projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!p) throw new Error(`project ${projectId} not found`);
    const [m] = await db.select().from(accountMembers)
      .where(and(eq(accountMembers.accountId, p.accountId), eq(accountMembers.accountRole, 'owner'))).limit(1);
    if (!m) throw new Error(`no owner for account ${p.accountId}`);
    ownerAccountId = m.accountId; ownerUserId = m.userId;
    log(`project: ${p.name} (${projectId}) branch=${p.defaultBranch}`);
  } else {
    const owner = (await db.select().from(accountMembers).limit(50)).find((m) => m.accountRole === 'owner');
    if (!owner) throw new Error('no owner account');
    ownerAccountId = owner.accountId; ownerUserId = owner.userId;
  }

  const token = (await createAccountToken({ accountId: ownerAccountId, userId: ownerUserId, name: PAT_NAME })).secretKey;

  try {
    // ── Optional: provision a fresh project ──────────────────────────────────
    if (!projectId && process.env.BENCH_CREATE) {
      const tProv = Date.now();
      const name = `bench-${Date.now().toString(36)}`;
      const prov = await api('POST', '/projects/provision', token, {
        account_id: ownerAccountId, name, seed_starter: true,
      });
      if (prov.status < 200 || prov.status >= 300) {
        throw new Error(`provision failed: ${prov.status} ${JSON.stringify(prov.json)}`);
      }
      projectId = prov.json?.project_id;
      createdProject = true;
      console.log(`\n[bench] PROJECT CREATE: ${((Date.now() - tProv) / 1000).toFixed(1)}s  → ${projectId} (${name})\n`);
    }
    if (!projectId) throw new Error('set BENCH_PROJECT_ID or BENCH_CREATE=1');

    // ── Boot N sessions ───────────────────────────────────────────────────────
    const results: BootResult[] = [];
    for (let i = 1; i <= ITERS; i++) {
      const r = await bootOnce(projectId, token, i);
      results.push(r);
      const tl = r.marks.length
        ? '    create→active marks: ' + r.marks.map((m) => `${m.label}=+${m.deltaMs}ms`).join('  ')
        : '';
      log(`  iter ${i} DONE: http=${r.httpMs}ms create→active=${(r.createToActiveMs / 1000).toFixed(1)}s active→ready=${(r.activeToReadyMs / 1000).toFixed(1)}s TOTAL=${(r.totalMs / 1000).toFixed(1)}s ${r.imageCached ? '[cache hit]' : '[BUILT]'}`);
      if (tl) console.log(tl);
      if (r.inboxTimeline.length) {
        // Print in-box marks as deltas between consecutive marks.
        let prev = 0;
        const parts = r.inboxTimeline.map((m) => { const d = m.atMs - prev; prev = m.atMs; return `${m.label}=+${d}ms`; });
        console.log('    in-box (active→ready) marks: ' + parts.join('  '));
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log(`\n[bench] ─── BOOT TIMING SUMMARY (${BACKEND}) ───`);
    for (const r of results) {
      console.log(`  iter ${r.iter} ${r.imageCached ? '(warm)' : '(cold)'}:  http ${r.httpMs}ms | create→active ${(r.createToActiveMs / 1000).toFixed(1)}s | active→ready ${(r.activeToReadyMs / 1000).toFixed(1)}s | TOTAL ${(r.totalMs / 1000).toFixed(1)}s`);
    }
    const warm = results.filter((r) => r.imageCached);
    if (warm.length) {
      const avg = warm.reduce((s, r) => s + r.totalMs, 0) / warm.length / 1000;
      console.log(`\n  WARM avg total: ${avg.toFixed(1)}s  (n=${warm.length})`);
    }
    console.log('');
  } finally {
    if (createdProject && projectId && !process.env.KEEP) {
      await api('DELETE', `/projects/${projectId}`, token).catch(() => null);
      log(`cleanup: archived created project`);
    }
    await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => undefined);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`\n[bench] FAILED: ${err?.message || err}\n`);
  process.exit(1);
});

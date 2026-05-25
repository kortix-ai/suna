/**
 * Live end-to-end boot-timing test for the sandbox creation flow.
 *
 * Unlike e2e-managed-flow.ts (which only asserts session-create returns 2xx),
 * this drives a REAL session start-to-finish and waits until the in-box agent
 * runtime reports `runtimeReady`, printing a phase breakdown:
 *
 *   create → active   (Daytona create + snapshot resolve/build)
 *   active → ready     (in-box: git clone + opencode boot)
 *
 *     cd apps/api && PROJECT_ID=<uuid> bun run scripts/e2e-boot-timing.ts
 *
 * Env:
 *   BACKEND_URL  default http://localhost:8008
 *   PROJECT_ID   project to boot (default: first owner project with a ready snapshot)
 *   READY_TIMEOUT_MS  default 420000 (7m — covers a cold snapshot rebuild)
 *   KEEP=1       don't delete the session at the end (inspect it manually)
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  accountMembers,
  accountTokens,
  projects,
  projectRuntimeSnapshots,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 420_000);
const PAT_NAME = 'e2e-boot-timing';

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

async function main() {
  console.log(`\n[e2e] sandbox boot timing  →  ${BACKEND}\n`);

  const health = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`backend not healthy: GET /health → ${health}`);

  const owner = (await db.select().from(accountMembers).limit(50)).find((m) => m.accountRole === 'owner');
  if (!owner) throw new Error('no local owner account found');

  // Pick the project: explicit PROJECT_ID, else first owner project that has a
  // ready snapshot (so we exercise a real repo, not a fresh throwaway).
  let projectId = process.env.PROJECT_ID || '';
  if (!projectId) {
    const ready = await db
      .select({ projectId: projectRuntimeSnapshots.projectId })
      .from(projectRuntimeSnapshots)
      .innerJoin(projects, eq(projects.projectId, projectRuntimeSnapshots.projectId))
      .where(and(eq(projectRuntimeSnapshots.status, 'ready'), eq(projects.accountId, owner.accountId)))
      .orderBy(desc(projectRuntimeSnapshots.createdAt))
      .limit(1);
    projectId = ready[0]?.projectId || '';
  }
  if (!projectId) throw new Error('no bootable project found (set PROJECT_ID)');
  const [proj] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  log(`project: ${proj?.name} (${projectId}) repo=${proj?.repoUrl ?? '?'} branch=${proj?.defaultBranch}`);

  const token = (await createAccountToken({ accountId: owner.accountId, userId: owner.userId, name: PAT_NAME })).secretKey;

  let sessionId = '';
  try {
    const tCreate = Date.now();
    const sess = await api('POST', `/projects/${projectId}/sessions`, token, {});
    if (sess.status < 200 || sess.status >= 300) {
      throw new Error(`session create failed: ${sess.status} ${JSON.stringify(sess.json)}`);
    }
    sessionId = sess.json?.session_id ?? sess.json?.id ?? '';
    log(`✓ session created: ${sessionId}`);

    // ── Phase 1: provision → active (Daytona create + snapshot) ──────────────
    let externalId = '';
    let activeAt = 0;
    let lastStage = '';
    for (;;) {
      const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).limit(1);
      const md = (row?.metadata ?? {}) as Record<string, any>;
      const stage = `${row?.status}/${md.initStatus ?? ''}/${md.provisioningStage ?? md.stage ?? ''}`;
      if (stage !== lastStage) { log(`  provision: ${stage}${md.lastMessage ? ` — ${String(md.lastMessage).slice(0, 80)}` : ''}`); lastStage = stage; }
      if (row?.status === 'error') {
        throw new Error(`provision errored: ${JSON.stringify(md.initError ?? md.lastMessage ?? md)}`);
      }
      if (row?.status === 'active' && row.externalId) {
        externalId = row.externalId;
        activeAt = Date.now();
        break;
      }
      if (Date.now() - tCreate > READY_TIMEOUT_MS) throw new Error('timed out waiting for sandbox active');
      await sleep(1000);
    }
    log(`✓ sandbox ACTIVE in ${((activeAt - tCreate) / 1000).toFixed(1)}s  (daytona id ${externalId})`);

    // ── Phase 2: active → runtimeReady (in-box clone + opencode) ─────────────
    const healthUrl = `${BACKEND}/v1/p/${externalId}/8000/kortix/health`;
    let lastHealth = '';
    let readyAt = 0;
    for (;;) {
      const r = await fetch(healthUrl, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      const body = r ? await r.json().catch(() => null) : null;
      if (body) {
        const sig = `${body.status}/oc=${body.opencode}/repo=${body.repo_ready}${body.boot_error ? `/err=${String(body.boot_error).slice(0, 60)}` : ''}`;
        if (sig !== lastHealth) { log(`  health: ${sig}`); lastHealth = sig; }
        if (body.runtimeReady === true) {
          readyAt = Date.now();
          log(`✓ runtimeReady — repo=${body.repo} branch=${body.branch} commit=${String(body.commit_sha).slice(0, 8)} opencode_pid=${body.opencode_pid}`);
          break;
        }
        if (body.boot_error) throw new Error(`boot_error: ${body.boot_error}`);
      }
      if (Date.now() - activeAt > READY_TIMEOUT_MS) throw new Error('timed out waiting for runtimeReady');
      await sleep(1500);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const provisionS = (activeAt - tCreate) / 1000;
    const bootS = (readyAt - activeAt) / 1000;
    const totalS = (readyAt - tCreate) / 1000;
    console.log(`\n[e2e] ─── BOOT TIMING ───`);
    console.log(`  create → active   : ${provisionS.toFixed(1)}s   (daytona create + snapshot resolve/build)`);
    console.log(`  active → ready    : ${bootS.toFixed(1)}s   (in-box git clone + opencode)`);
    console.log(`  TOTAL create→ready: ${totalS.toFixed(1)}s\n`);
  } finally {
    if (sessionId && !process.env.KEEP) {
      const d = await api('DELETE', `/projects/${projectId}/sessions/${sessionId}`, token).catch(() => null);
      log(`cleanup: deleted session (${d?.status ?? 'err'})`);
    } else if (sessionId) {
      log(`KEEP=1 — left session ${sessionId} running for inspection`);
    }
    await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => undefined);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`\n[e2e] FAILED: ${err?.message || err}\n`);
  process.exit(1);
});

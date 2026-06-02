/**
 * Deep in-sandbox boot profiler. Boots ONE session, waits until the box is
 * active, then execs into the live Daytona sandbox to attribute the two in-box
 * long poles (git clone + opencode startup) to their real sub-steps.
 *
 *   cd apps/api && KORTIX_URL=<tunnel> BENCH_PROJECT_ID=<uuid> \
 *     bun --env-file=.env run scripts/profile-inbox-boot.ts
 *
 * It prints the daemon boot_timeline marks, then dumps the config surface
 * (skills/plugins/MCP), the opencode binary cold-start, and the repo/clone
 * anatomy from inside the box. Cleans up the session unless KEEP=1.
 */
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import { getDaytona } from '../src/shared/daytona';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const PAT_NAME = 'profile-inbox-boot';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${BACKEND}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function main() {
  const projectId = process.env.BENCH_PROJECT_ID;
  if (!projectId) throw new Error('set BENCH_PROJECT_ID');
  const [p] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!p) throw new Error(`project ${projectId} not found`);
  const members = await db.select().from(accountMembers).where(eq(accountMembers.accountId, p.accountId)).limit(50);
  const owner = members.find((m) => m.accountRole === 'owner') ?? members[0];
  if (!owner) throw new Error('no member for project account');
  const token = (await createAccountToken({ accountId: p.accountId, userId: owner.userId, name: PAT_NAME })).secretKey;

  let sessionId = '';
  try {
    console.log(`\n[profile] booting a session on ${p.name} (${projectId})…`);
    const tCreate = Date.now();
    const sess = await api('POST', `/projects/${projectId}/sessions`, token, {});
    if (sess.status >= 300) throw new Error(`create failed: ${sess.status} ${JSON.stringify(sess.json)}`);
    sessionId = sess.json?.session_id ?? sess.json?.id;
    console.log(`[profile] session ${sessionId} (HTTP ${Date.now() - tCreate}ms). waiting for active…`);

    let externalId = '';
    for (;;) {
      const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).limit(1);
      if (row?.status === 'error') throw new Error(`provision errored: ${JSON.stringify((row.metadata as any)?.errorMessage)}`);
      if (row?.status === 'active' && row.externalId) { externalId = row.externalId; break; }
      if (Date.now() - tCreate > 120_000) throw new Error('timed out waiting for active');
      await sleep(400);
    }
    console.log(`[profile] active. daytona sandbox = ${externalId}. waiting for runtimeReady…`);

    let bootTimeline: any[] = [];
    const tReadyStart = Date.now();
    for (;;) {
      const r = await fetch(`${BACKEND}/v1/p/${externalId}/8000/kortix/health`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      const b = r ? await r.json().catch(() => null) : null;
      if (Array.isArray(b?.boot_timeline)) bootTimeline = b.boot_timeline;
      if (b?.runtimeReady === true) break;
      if (Date.now() - tReadyStart > 120_000) { console.log('[profile] runtimeReady timed out; profiling anyway'); break; }
      await sleep(500);
    }
    console.log(`\n[profile] daemon boot_timeline (ms since daemon start):`);
    let prev = 0;
    for (const m of bootTimeline) { console.log(`    ${String(m.label).padEnd(26)} @${m.atMs}ms   (+${m.atMs - prev}ms)`); prev = m.atMs; }

    const sandbox = await getDaytona().get(externalId);
    const FINDPID = `PID=$(for d in /proc/[0-9]*; do if tr '\\0' ' ' < $d/cmdline 2>/dev/null | grep -q 'opencode.*serve'; then echo \${d#/proc/}; break; fi; done)`;
    const sh = async (label: string, command: string, timeoutSec = 60) => {
      const t = Date.now();
      const res = await sandbox.process.executeCommand(command, '/', undefined, timeoutSec).catch((e: any) => ({ result: `EXEC ERROR: ${e?.message}` } as any));
      console.log(`\n──── ${label}  (${((Date.now() - t) / 1000).toFixed(1)}s wall) ────`);
      console.log((res as any).result ?? '');
    };

    await sh('config surface', `
      cd /; ${FINDPID}; echo "opencode pid=$PID";
      CFG=$(tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | sed -n 's/^OPENCODE_CONFIG_DIR=//p');
      echo "config dir = $CFG";
      echo "skills:   $(find $CFG/skills -name SKILL.md 2>/dev/null | wc -l)";
      echo "plugins:  $(find $CFG/plugins $CFG/pty -name '*.ts' 2>/dev/null | wc -l)";
      echo "node_modules: $(du -sh $CFG/node_modules 2>/dev/null | cut -f1) ($(ls $CFG/node_modules 2>/dev/null | wc -l) pkgs)";
    `);

    await sh('binary cold-start (opencode --version x3)', `
      cd /; for i in 1 2 3; do S=$(date +%s.%N); /usr/local/bin/opencode --version >/dev/null 2>&1; E=$(date +%s.%N); echo "  run $i: $(awk "BEGIN{print $E-$S}")s"; done
    `);

    await sh('repo size + clone anatomy', `
      cd /; WS=/workspace;
      echo "workspace du: $(du -sh $WS 2>/dev/null | cut -f1)";
      echo ".git du:      $(du -sh $WS/.git 2>/dev/null | cut -f1)";
      git -C $WS count-objects -vH 2>/dev/null | grep -E 'size-pack|in-pack';
      echo "remote origin: $(git -C $WS remote get-url origin 2>/dev/null)";
    `);
  } finally {
    if (!process.env.KEEP && sessionId) {
      console.log(`\n[profile] cleanup: deleting session ${sessionId}`);
      await api('DELETE', `/projects/${projectId}/sessions/${sessionId}`, token).catch(() => {});
    } else if (sessionId) {
      console.log(`\n[profile] KEEP=1 — session ${sessionId} left running`);
    }
    await db.delete(accountTokens).where(eq(accountTokens.name, PAT_NAME)).catch(() => {});
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n[profile] FAILED: ${e?.message || e}\n`); process.exit(1); });

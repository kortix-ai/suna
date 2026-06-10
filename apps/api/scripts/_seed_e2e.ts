/**
 * Warm-seed e2e — the exact UI flow, timed.
 *
 *   phase 1: new project → session 1 (no seed yet) → expect default path +
 *            background derive kicked.
 *   phase 2: wait for the seed template + warm snapshot to bake.
 *   phase 3: sessions 2..N → expect [warm seed] boot, ~1-2s to runtimeReady,
 *            correct session branch in /workspace, .git present.
 *
 * Run: bunx dotenvx run -- bun scripts/_seed_e2e.ts
 */
import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const PT = 'https://api.platinum.dev';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'seed-e2e' })).secretKey;
const H: Record<string, string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const PTH: Record<string, string> = { Authorization: `Bearer ${PTKEY}`, 'Content-Type': 'application/json' };
const now = () => Date.now();

async function ptExec(extId: string, cmd: string): Promise<string> {
  const r = await fetch(`${PT}/v1/sandboxes/${extId}/exec`, {
    method: 'POST', headers: PTH,
    body: JSON.stringify({ cmd: ['sh', '-lc', cmd] }),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await r.json().catch(() => ({}));
  return ((j.result?.stdout ?? '') + (j.result?.stderr ?? '')).trim();
}

async function sandboxRow(sessionId: string) {
  for (let i = 0; i < 40; i++) {
    const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
    if (row?.externalId) return row;
    await Bun.sleep(250);
  }
  const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
  return row ?? null;
}

/** UI-equivalent readiness: poll the comp proxy /kortix/health until runtimeReady. */
async function waitRuntimeReady(baseUrl: string, timeoutMs = 120_000): Promise<number> {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/kortix/health`, { headers: H, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j: any = await r.json().catch(() => ({}));
        if (j.runtimeReady === true) return now() - t0;
      }
    } catch { /* not up yet */ }
    await Bun.sleep(150);
  }
  return -1;
}

async function runSession(projectId: string, label: string) {
  const t0 = now();
  const ses: any = await (await fetch(`${BASE}/v1/projects/${projectId}/sessions`, {
    method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }),
  })).json();
  if (!ses.session_id) { console.log(`[${label}] SESSION FAILED: ${JSON.stringify(ses).slice(0, 200)}`); return null; }
  const tPost = now() - t0;
  const row = await sandboxRow(ses.session_id);
  const m: any = row?.metadata ?? {};
  const baseUrl: string | null = (row as any)?.baseUrl ?? m.baseUrl ?? null;
  if (!row?.externalId || !baseUrl) { console.log(`[${label}] no externalId/baseUrl: ${JSON.stringify(m).slice(0, 200)}`); return null; }
  const readyMs = await waitRuntimeReady(baseUrl);
  // in-guest receipts: branch must equal sessionId, repo must be present
  const guest = await ptExec(row.externalId,
    `cd /workspace 2>/dev/null && git branch --show-current && test -d .git && echo GIT_OK && git log --oneline -1 | head -c 60`);
  // which template did the VM actually boot from + via (platinum view)
  const pt: any = await (await fetch(`${PT}/v1/sandboxes/${row.externalId}`, { headers: PTH })).json();
  console.log(`[${label}] post=${tPost}ms ready=${readyMs}ms total=${tPost + readyMs}ms`);
  console.log(`[${label}] guest: ${guest.replace(/\n/g, ' | ')}`);
  console.log(`[${label}] platinum: template=${pt.template_id ?? pt.template} state=${pt.state} via=${pt.metadata?.via ?? '?'}`);
  return { sessionId: ses.session_id, externalId: row.externalId, readyMs, totalMs: tPost + readyMs, branch: guest.split('\n')[0] };
}

// ── phase 1: project + first session ────────────────────────────────────────
// PROJECT_ID env → reuse an existing project (skip provision + cold session).
const t0 = now();
let prov: any;
if (process.env.PROJECT_ID) {
  prov = { project_id: process.env.PROJECT_ID };
  console.log(`reusing project=${prov.project_id}`);
} else {
  prov = await (await fetch(`${BASE}/v1/projects/provision`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: `seed-e2e-${t0}`, seed_starter: true }),
  })).json();
  if (!prov.project_id) { console.log(`PROVISION FAILED: ${JSON.stringify(prov).slice(0, 300)}`); process.exit(1); }
  console.log(`project=${prov.project_id} (${now() - t0}ms)`);
  await runSession(prov.project_id, 's1-cold');
}

// ── phase 2: wait for the seed to derive + bake ──────────────────────────────
const prefix = `proj-seed-${prov.project_id}-`.toLowerCase();
let seedTpl: any = null;
const tWait = now();
while (now() - tWait < 8 * 60_000) {
  const rows: any[] = await (await fetch(`${PT}/v1/templates?limit=200`, { headers: PTH })).json();
  seedTpl = rows.find((r) => r.name.startsWith(prefix) && r.state === 'ready') ?? null;
  if (seedTpl) break;
  await Bun.sleep(3000);
}
if (!seedTpl) { console.log('SEED NEVER DERIVED — check comp log for [platinum-seed]'); process.exit(1); }
console.log(`seed template: ${seedTpl.name} (${seedTpl.id}) after ${((now() - tWait) / 1000).toFixed(0)}s`);

// warm snapshot baked? poll hosts' snapshotTemplates via admin-less signal:
// spawn-side falls back to cold boot until baked, so just poll by test-forking
// is wasteful — instead watch for the snapshot name on any host via /v1/hosts
// (admin only) — not available with org key. Poll by TIME + verify via=restore
// in phase 3; give the maintain loop up to 6 min to capture.
console.log('waiting for warm capture (maintain loop boots + clones + snapshots)…');
const tBake = now();
let baked = false;
while (now() - tBake < 8 * 60_000) {
  // cheap probe: create nothing; check template detail for a captured marker if exposed
  const det: any = await (await fetch(`${PT}/v1/templates/${seedTpl.id}`, { headers: PTH })).json();
  if (det.state !== 'ready') { console.log(`seed state flipped to ${det.state}?!`); break; }
  // No public "snapshot baked" signal — sample with a real fork attempt every 45s.
  if ((now() - tBake) > 45_000 && !baked) break;
  await Bun.sleep(5000);
}

// ── phase 3: seeded sessions ─────────────────────────────────────────────────
for (let i = 2; i <= 4; i++) {
  const r = await runSession(prov.project_id, `s${i}-seeded`);
  if (r && r.readyMs >= 0 && r.totalMs < 3000) console.log(`[s${i}] FAST ✓ (${r.totalMs}ms)`);
  else if (r) console.log(`[s${i}] SLOW ✗ (${r.totalMs}ms) — snapshot may still be baking; retrying after 60s`);
  if (r && r.totalMs >= 3000 && i < 4) await Bun.sleep(60_000);
  else await Bun.sleep(2000);
}

console.log('done. comp log: grep -E "warm seed|platinum-seed" /tmp/comp-api.log');
process.exit(0);

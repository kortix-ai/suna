import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const N = Number(process.env.N ?? 3);
const PROVIDERS = (process.env.PROVIDERS ?? 'platinum,daytona').split(',');
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'compare' })).secretKey;
const H: Record<string,string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const now = () => Date.now();
const s = (ms: number) => (ms / 1000).toFixed(2);

async function provision(name: string): Promise<string|null> {
  const r = await fetch(`${BASE}/v1/projects/provision`, { method:'POST', headers:H, body: JSON.stringify({ name, seed_starter:true, account_id: ACC }) });
  if (!r.ok) { console.log(`  provision FAIL ${r.status}: ${(await r.text()).slice(0,120)}`); return null; }
  return (await r.json() as any).project_id;
}

async function row(sessionId: string) {
  const [x] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
  return x as any;
}

// Poll the proxy /kortix/health until runtimeReady=true (uniform across providers)
let lastHealth = '';
async function waitRuntimeReady(baseUrl: string, deadlineMs: number): Promise<boolean> {
  const end = now() + deadlineMs;
  lastHealth = '';
  while (now() < end) {
    try {
      const r = await fetch(`${baseUrl}/kortix/health`, { headers: H, signal: AbortSignal.timeout(8000) });
      const body = await r.text(); lastHealth = `${r.status}:${body.slice(0,140)}`;
      if (r.ok) { let j: any = {}; try { j = JSON.parse(body); } catch {} if (j?.runtimeReady === true) return true; }
    } catch (e: any) { lastHealth = `ERR ${e?.name||e}`; }
    await Bun.sleep(400);
  }
  return false;
}

const summary: Record<string, any> = {};
for (const prov of PROVIDERS) {
  console.log(`\n######## ${prov.toUpperCase()} ########`);
  const tP = now();
  const pid = await provision(`cmp-${prov}-${tP}`);
  const provisionMs = now() - tP;
  if (!pid) { summary[prov] = { error: 'provision failed' }; continue; }
  console.log(`  project provisioned in ${s(provisionMs)}s (managed-git, one-time)`);
  const runs: any[] = [];
  for (let n = 1; n <= N; n++) {
    const t0 = now();
    const sr = await fetch(`${BASE}/v1/projects/${pid}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ provider: prov, branch_already_created:false }) });
    const sj: any = await sr.json();
    if (!sr.ok || !sj.session_id) { console.log(`  [#${n}] session FAIL ${sr.status}: ${JSON.stringify(sj).slice(0,140)}`); continue; }
    // wait for running
    let r0: any = null; const tRunEnd = now() + 90000;
    while (now() < tRunEnd) { r0 = await row(sj.session_id); if (r0?.externalId && r0?.baseUrl && (r0?.status === 'active' || r0?.status === 'running')) break; await Bun.sleep(300); }
    const runMs = now() - t0;
    const running = !!(r0?.externalId && r0?.baseUrl && (r0?.status === 'active' || r0?.status === 'running'));
    let readyMs = -1;
    if (running && r0?.baseUrl) { const rdy = await waitRuntimeReady(r0.baseUrl, 90000); readyMs = rdy ? now() - t0 : -1; }
    // proxy round-trip
    let rtt = -1; if (r0?.baseUrl) { const tr = now(); try { await fetch(`${r0.baseUrl}/kortix/health`, { headers:H, signal: AbortSignal.timeout(8000) }); rtt = now()-tr; } catch {} }
    runs.push({ runMs, readyMs, rtt, ext: r0?.externalId });
    console.log(`  [#${n}] create→running=${s(runMs)}s  create→runtimeReady=${readyMs<0?'TIMEOUT':s(readyMs)+'s'}  proxyRTT=${rtt<0?'ERR':rtt+'ms'}  ${r0?.externalId??''}`);
    if (readyMs < 0 && running) console.log(`        ↳ last health: ${lastHealth}`);
  }
  const ok = runs.filter(r => r.readyMs > 0);
  const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a,b)=>a+b,0)/xs.length) : -1;
  summary[prov] = {
    provisionMs,
    runs: runs.length,
    ok: ok.length,
    avgRunningMs: avg(runs.filter(r=>r.runMs>0).map(r=>r.runMs)),
    avgReadyMs: avg(ok.map(r=>r.readyMs)),
    minReadyMs: ok.length ? Math.min(...ok.map(r=>r.readyMs)) : -1,
    maxReadyMs: ok.length ? Math.max(...ok.map(r=>r.readyMs)) : -1,
    avgRttMs: avg(runs.filter(r=>r.rtt>0).map(r=>r.rtt)),
  };
}

console.log('\n==================== COMPARISON ====================');
console.log(JSON.stringify(summary, null, 2));
process.exit(0);

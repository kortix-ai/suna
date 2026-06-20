import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'e2e4' })).secretKey;
const H: Record<string,string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const now = () => Date.now();
const RUNS = Number(process.env.RUNS ?? 4);

async function ptExec(extId: string){
  const r = await fetch(`https://api.platinum.dev/v1/sandboxes/${extId}/exec`, {
    method:'POST', headers:{ Authorization:`Bearer ${PTKEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ cmd:['sh','-lc','curl -s -m3 -o /dev/null -w oc4096=%{http_code} http://127.0.0.1:4096/; echo; curl -s -m3 http://127.0.0.1:8000/kortix/health|head -c 160'] }),
    signal: AbortSignal.timeout(20000),
  });
  const j:any = await r.json().catch(()=>({}));
  return ((j.result?.stdout??'')+(j.result?.stderr??'')).replace(/\n/g,' ').trim().slice(0,200);
}

console.log(`######## comp full-path multi-run (${RUNS}x) ########`);
for (let n=1; n<=RUNS; n++){
  const t0 = now();
  const prov:any = await (await fetch(`${BASE}/v1/projects/provision`, { method:'POST', headers:H, body: JSON.stringify({ name:`e2e4-${t0}-${n}`, seed_starter:true }) })).json();
  const ses:any = await (await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ branch_already_created:false }) })).json();
  const provSesS = ((now()-t0)/1000).toFixed(2);
  if (!ses.session_id){ console.log(`[#${n}] SESSION FAILED: ${JSON.stringify(ses).slice(0,160)}`); continue; }

  // sandbox row
  await Bun.sleep(300);
  const [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1);
  const m:any = row?.metadata ?? {};
  const tpl = m.template ?? '?';
  const v7 = String(tpl).includes('04d42c7749e7') ? 'V7✓' : `${tpl}`;

  // opencode + daemon readiness inside the guest
  const probe = row?.externalId ? await ptExec(row.externalId) : 'no-extId';

  // full proxy chain (FE -> comp /v1/p -> edge -> guest daemon)
  let proxy = 'n/a';
  if (m.baseUrl){
    const s = now();
    try { const r = await fetch(`${m.baseUrl}/kortix/health`, { headers:H, signal: AbortSignal.timeout(15000) });
      proxy = `${r.status} (${((now()-s)/1000).toFixed(2)}s)`; }
    catch(e:any){ proxy = `ERR ${e?.name||e}`; }
  }
  console.log(`[#${n}] ${provSesS}s tmpl=${v7} extId=${row?.externalId} :: ${probe} :: proxy/kortix/health=${proxy}`);
}
process.exit(0);

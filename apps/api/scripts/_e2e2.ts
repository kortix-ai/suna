import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'e2e2' })).secretKey;
const H: Record<string,string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const now = () => Date.now();

const t0 = now();
const prov: any = await (await fetch(`${BASE}/v1/projects/provision`, { method:'POST', headers:H, body: JSON.stringify({ name:`e2e2-${t0}`, seed_starter:true }) })).json();
console.log('provision:', prov.project_id, 'seeded', prov.seeded);
const tSes = now();
const ses: any = await (await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ branch_already_created:false }) })).json();
console.log('session:', ses.session_id, `(provision+session ${((now()-t0)/1000).toFixed(2)}s)`);

// Poll the FE's sandbox endpoint until it reports running
let sb: any = null; const tSb = now();
for (let i=0;i<60;i++){
  const r = await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions/${ses.session_id}/sandbox`, { headers:H });
  if (r.ok){ sb = await r.json(); if (sb?.status==='running' || sb?.state==='running' || sb?.external_id) break; }
  await Bun.sleep(500);
}
console.log('sandbox(FE):', JSON.stringify(sb).slice(0,200), `(ready in ${((now()-tSb)/1000).toFixed(2)}s)`);

// Look up the DB row → external id + template + provider
const extId = sb?.external_id ?? sb?.sandbox?.external_id;
if (extId){
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.externalId, extId)).limit(1);
  console.log('DB row: provider=', row?.provider, 'meta.template=', (row?.metadata as any)?.template, 'status=', row?.status);
}

// Hit the agent THROUGH the proxy (the path that 504/503'd before): /global/events + a health
async function timed(path: string){
  const s = now();
  try { const r = await fetch(`${BASE}${path}`, { headers:H, signal: AbortSignal.timeout(15000) });
    console.log(`  ${path} -> ${r.status} (${((now()-s)/1000).toFixed(2)}s)`); return r.status; }
  catch(e:any){ console.log(`  ${path} -> ERR ${e?.name||e} (${((now()-s)/1000).toFixed(2)}s)`); return 0; }
}
console.log('proxy probes:');
await timed(`/v1/projects/${prov.project_id}/sessions/${ses.session_id}/agent/health`);
await timed(`/v1/projects/${prov.project_id}/sessions/${ses.session_id}/global/events`);

process.exit(0);

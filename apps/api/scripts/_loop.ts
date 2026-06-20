import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const N = Number(process.env.N ?? 6);
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'loop' })).secretKey;
const H: Record<string,string> = { Authorization:`Bearer ${tok}`, 'Content-Type':'application/json' };
const now = () => Date.now();
const s = (ms:number) => (ms/1000).toFixed(1);

async function proxy(baseUrl:string, path:string, init?:RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...H, ...(init?.headers||{}) }, signal: AbortSignal.timeout(20000) });
}

let pass=0;
console.log(`######## REAL-USER LOOP (${N} spawns) ########`);
for (let n=1;n<=N;n++){
  const t0=now();
  const prov:any = await (await fetch(`${BASE}/v1/projects/provision`,{method:'POST',headers:H,body:JSON.stringify({name:`loop-${t0}-${n}`,seed_starter:true,account_id:ACC})})).json();
  if(!prov.project_id){ console.log(`[#${n}] PROVISION FAIL`); continue; }
  const tSes=now();
  const ses:any = await (await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`,{method:'POST',headers:H,body:JSON.stringify({provider:'platinum',branch_already_created:false})})).json();
  const spawnMs = now()-tSes;           // session-create now blocks until runtimeReady
  if(!ses.session_id){ console.log(`[#${n}] SESSION FAIL ${JSON.stringify(ses).slice(0,120)}`); continue; }
  // async provisioning: poll the row until baseUrl + active (provider create()
  // with the readiness gate has completed) — this IS the spawn-to-ready time.
  let row:any=null; const end=now()+100000;
  while(now()<end){ const [r]:any=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1); if((r as any)?.baseUrl && ((r as any)?.status==='active'||(r as any)?.status==='running')){ row=r; break; } await new Promise(res=>setTimeout(res,500)); }
  const spawnReadyMs = now()-tSes;
  const baseUrl=(row as any)?.baseUrl, ext=(row as any)?.externalId;
  if(!baseUrl){ console.log(`[#${n}] TIMEOUT no baseUrl in 100s`); continue; }
  // verify the FE-facing calls that were 503ing: health(runtimeReady), session list, command
  let health='?', sess='?', cmd='?', rr=false;
  try{ const r=await proxy(baseUrl,'/kortix/health'); const j:any=await r.json().catch(()=>({})); rr=j?.runtimeReady===true; health=`${r.status}/rr=${rr}`; }catch(e:any){ health=`ERR ${e?.name}`; }
  try{ const r=await proxy(baseUrl,'/session?limit=10'); sess=String(r.status); }catch(e:any){ sess=`ERR ${e?.name}`; }
  try{ const r=await proxy(baseUrl,'/command'); cmd=String(r.status); }catch(e:any){ cmd=`ERR ${e?.name}`; }
  const ok = rr && sess==='200';
  if(ok) pass++;
  console.log(`[#${n}] spawn→ready=${s(spawnReadyMs)}s  health=${health}  /session=${sess}  /command=${cmd}  ${ok?'✅ READY+SERVING':'❌'}  ${ext}`);
}
console.log(`\nRESULT: ${pass}/${N} spawns ready+serving on first connect (no 503)`);
process.exit(0);

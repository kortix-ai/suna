import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const PTKEY = readFileSync('/tmp/ptkey','utf8').trim();
const N = Number(process.env.N ?? 4);
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'platready' })).secretKey;
const H: Record<string,string> = { Authorization:`Bearer ${tok}`, 'Content-Type':'application/json' };
const now = () => Date.now();

// readiness INSIDE the guest — no dev tunnel in the path
async function guestReady(ext: string): Promise<{ready:boolean, body:string}> {
  const r = await fetch(`https://api.platinum.dev/v1/sandboxes/${ext}/exec`, {
    method:'POST', headers:{ Authorization:`Bearer ${PTKEY}`,'Content-Type':'application/json' },
    body: JSON.stringify({ cmd:['sh','-lc','curl -s -m3 http://127.0.0.1:8000/kortix/health'] }),
    signal: AbortSignal.timeout(20000),
  });
  const j:any = await r.json().catch(()=>({}));
  const out = (j.result?.stdout??'')+(j.result?.stderr??'');
  let parsed:any={}; try{parsed=JSON.parse(out);}catch{}
  return { ready: parsed?.runtimeReady===true, body: out.slice(0,120) };
}

const prov:any = await (await fetch(`${BASE}/v1/projects/provision`, { method:'POST', headers:H, body: JSON.stringify({ name:`pr-${now()}`, seed_starter:true, account_id:ACC }) })).json();
console.log('project', prov.project_id);
const runs:number[]=[];
for (let n=1;n<=N;n++){
  const t0 = now();
  const ses:any = await (await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ provider:'platinum', branch_already_created:false }) })).json();
  if(!ses.session_id){ console.log(`[#${n}] session FAIL`); continue; }
  let ext=''; for(let i=0;i<80;i++){ const [r]=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId,ses.session_id)).limit(1); if((r as any)?.externalId){ext=(r as any).externalId;break;} await Bun.sleep(200); }
  if(!ext){ console.log(`[#${n}] no ext`); continue; }
  let readyMs=-1, last='';
  const end=now()+180000;
  while(now()<end){ const g=await guestReady(ext); last=g.body; if(g.ready){ readyMs=now()-t0; break; } await Bun.sleep(700); }
  if(readyMs>0) runs.push(readyMs);
  console.log(`[#${n}] create→runtimeReady (in-guest) = ${readyMs<0?'TIMEOUT '+last:(readyMs/1000).toFixed(2)+'s'}  ${ext}`);
  await fetch(`https://api.platinum.dev/v1/sandboxes/${ext}`, { method:'DELETE', headers:{ Authorization:`Bearer ${PTKEY}` } }).catch(()=>{});
}
if(runs.length){ const avg=Math.round(runs.reduce((a,b)=>a+b,0)/runs.length); console.log(`\nPLATINUM in-guest create→ready: avg ${(avg/1000).toFixed(2)}s  min ${(Math.min(...runs)/1000).toFixed(2)}s  max ${(Math.max(...runs)/1000).toFixed(2)}s  (${runs.length}/${N})`); }
process.exit(0);

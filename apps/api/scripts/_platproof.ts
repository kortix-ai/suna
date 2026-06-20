// Real kortix-flow spawn measurement against prod Platinum.
// create session (provider=platinum) → poll sessionSandboxes.externalId →
// in-guest health poll via platinum exec → report ms. Cleans up each sandbox.
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

const PROJECT = process.env.PROJECT ?? 'b90a22c6-8e7c-4e02-adb9-2877227093f0';
const BASE = 'http://localhost:8008';
const PTKEY = readFileSync('/tmp/ptkey','utf8').trim();
const TOK = readFileSync('/tmp/kortix-tok.txt','utf8').trim();
const N = Number(process.env.N ?? 4);
const H: Record<string,string> = { Authorization:`Bearer ${TOK}`, 'Content-Type':'application/json' };
const now = () => Date.now();

async function guestReady(ext: string): Promise<{ready:boolean, body:string}> {
  try {
    const r = await fetch(`https://api.platinum.dev/v1/sandboxes/${ext}/exec`, {
      method:'POST', headers:{ Authorization:`Bearer ${PTKEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({ cmd:['sh','-lc','curl -s -m3 http://127.0.0.1:8000/kortix/health'] }),
      signal: AbortSignal.timeout(20000),
    });
    const j:any = await r.json().catch(()=>({}));
    const out = (j.result?.stdout??'')+(j.result?.stderr??'')+(j.error??'');
    let parsed:any={}; try{parsed=JSON.parse(j.result?.stdout??'');}catch{}
    return { ready: parsed?.runtimeReady===true, body: out.slice(0,150) };
  } catch (e:any) { return { ready:false, body:String(e?.message??e).slice(0,100) }; }
}

const runs:number[]=[]; const fails:string[]=[];
for (let n=1;n<=N;n++){
  const t0 = now();
  const ses:any = await (await fetch(`${BASE}/v1/projects/${PROJECT}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ provider:'platinum', branch_already_created:false }) })).json();
  if(!ses.session_id){ console.log(`[#${n}] session FAIL: ${JSON.stringify(ses).slice(0,200)}`); fails.push('session'); continue; }
  let ext='';
  for(let i=0;i<150;i++){ const [r]=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId,ses.session_id)).limit(1); if((r as any)?.externalId){ext=(r as any).externalId;break;} await Bun.sleep(200); }
  if(!ext){ console.log(`[#${n}] no externalId after 30s`); fails.push('no-ext'); continue; }
  let readyMs=-1, last='';
  const end=now()+180000;
  while(now()<end){ const g=await guestReady(ext); last=g.body; if(g.ready){ readyMs=now()-t0; break; } await Bun.sleep(700); }
  if(readyMs>0) runs.push(readyMs); else fails.push('timeout:'+last);
  console.log(`[#${n}] create→runtimeReady = ${readyMs<0?'TIMEOUT '+last:(readyMs/1000).toFixed(2)+'s'}  ${ext}`);
  await fetch(`https://api.platinum.dev/v1/sandboxes/${ext}`, { method:'DELETE', headers:{ Authorization:`Bearer ${PTKEY}` } }).catch(()=>{});
  await Bun.sleep(1500);
}
if(runs.length){
  const s=[...runs].sort((a,b)=>a-b);
  const pct=(p:number)=>s[Math.min(s.length-1,Math.floor(p*s.length))];
  console.log(`\nRESULT n=${runs.length}/${N} p50=${(pct(0.5)/1000).toFixed(2)}s p90=${(pct(0.9)/1000).toFixed(2)}s min=${(s[0]/1000).toFixed(2)}s max=${(s[s.length-1]/1000).toFixed(2)}s fails=${fails.length}`);
}
if(fails.length) console.log('FAILS:', fails.join(' | '));
process.exit(0);

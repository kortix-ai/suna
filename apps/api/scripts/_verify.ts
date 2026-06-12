import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

const ACC='fbea71d0-9655-4ab4-aca5-1b68e1ae7f71'; const BASE='http://localhost:8008';
const tok=(await createAccountToken({accountId:ACC,userId:ACC,name:'verify'})).secretKey;
const H:Record<string,string>={Authorization:`Bearer ${tok}`,'Content-Type':'application/json'};
const now=()=>Date.now(); const s=(ms:number)=>(ms/1000).toFixed(1);
async function px(b:string,p:string,init?:RequestInit){ return fetch(`${b}${p}`,{...init,headers:{...H,...(init?.headers||{})},signal:AbortSignal.timeout(30000)}); }

const t0=now();
const prov:any=await(await fetch(`${BASE}/v1/projects/provision`,{method:'POST',headers:H,body:JSON.stringify({name:`verify-${t0}`,seed_starter:true,account_id:ACC})})).json();
const ses:any=await(await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`,{method:'POST',headers:H,body:JSON.stringify({provider:'platinum',branch_already_created:false})})).json();
let row:any=null; const end=now()+120000;
while(now()<end){ const [r]:any=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId,ses.session_id)).limit(1); if((r as any)?.baseUrl&&((r as any)?.status==='active'||(r as any)?.status==='running')){row=r;break;} await new Promise(z=>setTimeout(z,500)); }
if(!row?.baseUrl){ console.log(`SPAWN TIMEOUT (no ready sandbox in 120s)`); process.exit(0); }
const b=row.baseUrl, ext=row.externalId;
console.log(`spawn→ready=${s(now()-t0)}s  ${ext}`);

// patient verify opencode is up + has a model + responds
async function patient(p:string, init?:RequestInit, tries=8){ for(let i=0;i<tries;i++){ try{ const r=await px(b,p,init); if(r.ok) return r; }catch{} await new Promise(z=>setTimeout(z,1500)); } return null; }
const h=await patient('/kortix/health'); console.log('health:', h? (await h.json()).runtimeReady : 'UNREACHABLE');
const prov2=await patient('/provider');
if(prov2){ const pj:any=await prov2.json().catch(()=>({})); const def=pj?.default ?? Object.keys(pj?.providers??pj??{})[0]; console.log('opencode /provider OK — default model area:', JSON.stringify(def).slice(0,120)); }
else console.log('opencode /provider UNREACHABLE');

// create an opencode session + send a prompt
const sc=await patient('/session',{method:'POST',body:JSON.stringify({})});
if(sc){ const sj:any=await sc.json().catch(()=>({})); const ocSid=sj?.id; console.log('opencode session:', ocSid);
  if(ocSid){
    const pr=await px(b,`/session/${ocSid}/prompt_async`,{method:'POST',body:JSON.stringify({parts:[{type:'text',text:'Reply with exactly: OK'}]})}).catch((e:any)=>({ok:false,status:String(e?.name)} as any));
    console.log('prompt_async ->', (pr as any).status, (pr as any).ok?'(accepted)':'');
    // poll messages for an assistant reply
    let replied=false;
    for(let i=0;i<20;i++){ const m=await px(b,`/session/${ocSid}/message`).catch(()=>null); if(m?.ok){ const arr:any=await m.json().catch(()=>[]); const a=(Array.isArray(arr)?arr:arr?.messages??[]).find((x:any)=>x?.role==='assistant'||x?.info?.role==='assistant'); if(a){replied=true;break;} } await new Promise(z=>setTimeout(z,2000)); }
    console.log(replied?'✅ opencode RESPONDED (assistant message present)':'⚠️ no assistant reply within 40s (LLM/model may need config)');
  }
} else console.log('opencode session create UNREACHABLE');
process.exit(0);

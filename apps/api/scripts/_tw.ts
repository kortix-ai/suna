import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sql } from 'drizzle-orm';
const ACC='fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const tok=(await createAccountToken({accountId:ACC,userId:ACC,name:'tw-e2e2'})).secretKey;
const H={Authorization:`Bearer ${tok}`,'Content-Type':'application/json'};
const prov=await (await fetch('http://localhost:8008/v1/projects/provision',{method:'POST',headers:H,body:JSON.stringify({name:'tw2',seed_starter:true})})).json() as any;
const t0=Date.now();
const ses=await (await fetch(`http://localhost:8008/v1/projects/${prov.project_id}/sessions`,{method:'POST',headers:H,body:JSON.stringify({branch_already_created:false})})).json() as any;
const SID=ses.session_id; let ext='';
for(let i=0;i<80;i++){
  if(!ext){const r:any=await db.execute(sql`SELECT external_id FROM kortix.session_sandboxes WHERE sandbox_id=${SID}`);ext=(r.rows??r)[0]?.external_id||'';}
  if(ext){try{const resp=await fetch(`http://localhost:8008/v1/p/${ext}/8000/kortix/health`,{headers:{Authorization:`Bearer ${tok}`}});
    if(resp.ok){const h=await resp.json() as any; console.log(`  ${Date.now()-t0}ms ready=${h.runtimeReady} repo=${h.repo_ready}`); if(h.runtimeReady){console.log(`>>> READY at ${Date.now()-t0}ms`);process.exit(0);}} else console.log(`  ${Date.now()-t0}ms http=${resp.status}`);}catch{}}
  await new Promise(r=>setTimeout(r,1500));
}
console.log('TIMEOUT'); process.exit(1);

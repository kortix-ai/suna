import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
const ACC='fbea71d0-9655-4ab4-aca5-1b68e1ae7f71'; const BASE='http://localhost:8008';
const tok=(await createAccountToken({accountId:ACC,userId:ACC,name:'mk3'})).secretKey;
const H:Record<string,string>={Authorization:`Bearer ${tok}`,'Content-Type':'application/json'};
const prov:any=await(await fetch(`${BASE}/v1/projects/provision`,{method:'POST',headers:H,body:JSON.stringify({name:`mk3-${Date.now()}`,seed_starter:true,account_id:ACC})})).json();
const exts:string[]=[];
for(let n=1;n<=3;n++){
  const ses:any=await(await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`,{method:'POST',headers:H,body:JSON.stringify({provider:'platinum',branch_already_created:false})})).json();
  let ext=''; for(let i=0;i<60;i++){const[r]=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId,ses.session_id)).limit(1); if((r as any)?.externalId){ext=(r as any).externalId;break;} await Bun.sleep(200);}
  exts.push(ext);
}
console.log('EXTS='+exts.join(','));
process.exit(0);

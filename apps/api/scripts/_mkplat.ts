import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const BASE = 'http://localhost:8008';
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'mkplat' })).secretKey;
const H: Record<string,string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const prov: any = await (await fetch(`${BASE}/v1/projects/provision`, { method:'POST', headers:H, body: JSON.stringify({ name:`plat-dbg-${Date.now()}`, seed_starter:true, account_id: ACC }) })).json();
const ses: any = await (await fetch(`${BASE}/v1/projects/${prov.project_id}/sessions`, { method:'POST', headers:H, body: JSON.stringify({ provider:'platinum', branch_already_created:false }) })).json();
let ext = '';
for (let i=0;i<60;i++){ const [r]=await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1); if((r as any)?.externalId){ext=(r as any).externalId;break;} await Bun.sleep(300); }
console.log(`PID=${prov.project_id} SID=${ses.session_id} EXT=${ext}`);
process.exit(0);

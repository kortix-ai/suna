import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { createAccountToken } from '../src/repositories/account-tokens';
const live = await db.select().from(projects).where(eq((projects as any).status, 'active'));
for (const p of live as any[]) {
  console.log('active:', p.projectId.slice(0, 8), p.name, 'acc', p.accountId.slice(0, 8));
  const tok = (await createAccountToken({ accountId: p.accountId, userId: p.accountId, name: 'purge2' })).secretKey;
  const r = await fetch(`http://localhost:8008/v1/projects/${p.projectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  console.log('  ->', r.status, (await r.text()).slice(0, 120));
}
process.exit(0);

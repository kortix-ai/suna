import { db } from '../src/shared/db';
import { projects, sessionSandboxes } from '@kortix/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import { readFileSync } from 'fs';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const DRY = process.env.DRY === '1';

const rows = await db.select().from(projects);
console.log(`projects: ${rows.length}`);
const byAcc = new Map<string, any[]>();
for (const p of rows) {
  const acc = (p as any).accountId;
  if (!byAcc.has(acc)) byAcc.set(acc, []);
  byAcc.get(acc)!.push(p);
}
for (const [acc, ps] of byAcc) console.log(`  account ${acc.slice(0, 8)}: ${ps.length} projects`);
if (DRY) process.exit(0);

for (const [acc, ps] of byAcc) {
  const tok = (await createAccountToken({ accountId: acc, userId: acc, name: 'purge' })).secretKey;
  for (const p of ps) {
    const r = await fetch(`http://localhost:8008/v1/projects/${(p as any).projectId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
    });
    console.log(`DELETE project ${(p as any).projectId.slice(0, 8)} (${(p as any).name ?? ''}) -> ${r.status}`);
  }
}
// orphan session sandboxes with live platinum VMs
const sbx = await db.select().from(sessionSandboxes);
let killed = 0;
for (const s of sbx) {
  if (!s.externalId) continue;
  const r = await fetch(`https://api.platinum.dev/v1/sandboxes/${s.externalId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${PTKEY}` },
  });
  if (r.status === 200) killed++;
}
console.log(`platinum sandbox deletes (incl already-gone 404s skipped): ${killed}`);
process.exit(0);

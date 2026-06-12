import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const PID = process.env.PID ?? '6ad48932-59dd-40cd-a8c7-9c58988b36cd';
const rows = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.projectId, PID));
for (const r of rows) {
  if (!r.externalId) continue;
  const res = await fetch(`https://api.platinum.dev/v1/sandboxes/${r.externalId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${PTKEY}` },
  });
  console.log(`${r.externalId} -> ${res.status}`);
  await db.update(sessionSandboxes).set({ status: 'stopped' }).where(eq(sessionSandboxes.sandboxId, r.sandboxId));
}
process.exit(0);

import { db } from '../src/shared/db';
import { projects, sessionSandboxes } from '@kortix/db';
import { and, eq, like, inArray } from 'drizzle-orm';
import { readFileSync } from 'fs';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();

// My test projects are all named e2e* (e2e-final, e2e2-*, e2e4-*). Only those.
import { or } from 'drizzle-orm';
const projs = await db.select().from(projects).where(and(eq(projects.accountId, ACC),
  or(like(projects.name, 'e2e%'), like(projects.name, 'cmp-%'), like(projects.name, 'provtest%'), like(projects.name, 'plat-dbg%'), like(projects.name, 'loop-%'), like(projects.name, 'pr-%'), like(projects.name, 'mk3-%'), like(projects.name, 'verify-%'))));
const pids = projs.map(p => p.projectId);
console.log(`test projects (e2e*): ${pids.length}`);
if (!pids.length) process.exit(0);

const sbx = await db.select().from(sessionSandboxes).where(inArray(sessionSandboxes.projectId, pids));
const extIds = [...new Set(sbx.map(s => s.externalId).filter(Boolean))] as string[];
console.log(`sandboxes=${extIds.length}`);

let ok = 0, fail = 0;
await Promise.all(extIds.map(async (id) => {
  try {
    const r = await fetch(`https://api.platinum.dev/v1/sandboxes/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${PTKEY}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok || r.status===404) ok++; else fail++;
  } catch { fail++; }
}));
console.log(`deleted ok=${ok} fail=${fail}`);
process.exit(0);

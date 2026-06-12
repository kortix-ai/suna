import { db } from '../src/shared/db';
import { sandboxTemplates, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { refreshTemplateState } from '../src/snapshots/templates';
import { ensureSandboxImage } from '../src/snapshots/builder';
import { readFileSync } from 'fs';

const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const PT = 'https://api.platinum.dev';
const PTH = { Authorization: `Bearer ${PTKEY}` };

// 1. delete stale platinum templates (parent + seed captured with stale binary)
for (const name of ['kortix-default-66e4b0a77f9a', 'proj-seed-a216e2e6-4ab4-4eff-9a7a-12fa131a4265-ea47e5f50413-66e4b0a77f9a']) {
  const rows: any[] = await (await fetch(`${PT}/v1/templates?name=${name}`, { headers: PTH })).json();
  if (!rows[0]) { console.log(`${name}: gone`); continue; }
  const r = await fetch(`${PT}/v1/templates/${rows[0].id}`, { method: 'DELETE', headers: PTH });
  console.log(`${name}: DELETE -> ${r.status} ${(await r.text()).slice(0, 120)}`);
}

// 2. flip the comp cache row for the shared default template on platinum
const [row] = await db.select().from(sandboxTemplates)
  .where(and(eq(sandboxTemplates.isShared, true), eq(sandboxTemplates.provider, 'platinum')));
if (!row) { console.log('no shared platinum template row'); process.exit(1); }
const refreshed = await refreshTemplateState(row.templateId);
console.log(`row ${row.templateId} providerState -> ${refreshed?.providerState}`);

// 3. rebuild with the fresh binary
const PID = 'a216e2e6-4ab4-4eff-9a7a-12fa131a4265';
const [p] = await db.select().from(projects).where(eq(projects.projectId, PID)).limit(1);
const gitProject = { projectId: p.projectId, repoUrl: p.repoUrl, defaultBranch: p.defaultBranch ?? 'main', manifestPath: (p as any).manifestPath ?? null, gitAuthToken: null } as any;
const t0 = Date.now();
const r = await ensureSandboxImage(gitProject, { source: 'manual', provider: 'platinum' });
console.log('RESULT', JSON.stringify({ ...r, ms: Date.now() - t0 }));
process.exit(0);

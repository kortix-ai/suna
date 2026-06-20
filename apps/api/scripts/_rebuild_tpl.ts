import { ensureSandboxImage } from '../src/snapshots/builder';
import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

const PID = '6ad48932-59dd-40cd-a8c7-9c58988b36cd';
const [p] = await db.select().from(projects).where(eq(projects.projectId, PID)).limit(1);
if (!p) { console.log('no project'); process.exit(1); }
const gitProject = { projectId: p.projectId, repoUrl: p.repoUrl, defaultBranch: p.defaultBranch ?? 'main', manifestPath: (p as any).manifestPath ?? null, gitAuthToken: null } as any;
const t0 = Date.now();
const r = await ensureSandboxImage(gitProject, { source: 'manual', provider: 'platinum' });
console.log('RESULT', JSON.stringify({ ...r, ms: Date.now() - t0 }));
process.exit(0);

import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { ensureSandboxImage } from '../src/snapshots/builder';

const [p] = await db.select().from(projects).limit(1);
if (!p) { console.log('NO_PROJECT'); process.exit(1); }
console.log('[build] platinum=', process.env.PLATINUM_API_URL, ' project=', p.projectId);
const t0 = Date.now();
const r = await ensureSandboxImage(
  { projectId: p.projectId, repoUrl: p.repoUrl, defaultBranch: (p as any).defaultBranch ?? 'main', manifestPath: (p as any).manifestPath ?? null, gitAuthToken: null } as any,
  { source: 'manual', provider: 'platinum' },
);
console.log('[build] RESULT', JSON.stringify({ ...r, ms: Date.now() - t0 }));
process.exit(0);

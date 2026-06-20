// Clean rebuild of the SHARED platinum default kortix template, with the
// correct sandbox-callback KORTIX_URL so the STATEFUL CAPTURE (opencode warm →
// pin root session) can complete. The earlier build failed "capture cmd never
// exited 0 within 300s" because it ran with KORTIX_URL=localhost:8008 (a fr-par
// sandbox can't reach the dev box). Reset comp's stale trust-the-row first.
import { ensureSandboxImage, DEFAULT_SANDBOX_SLUG } from '../src/snapshots/builder';
import { refreshTemplateState } from '../src/snapshots/templates';
import { db } from '../src/shared/db';
import { sandboxTemplates } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

console.log('[rebuild2] KORTIX_URL =', process.env.KORTIX_URL);
if (!process.env.KORTIX_URL || process.env.KORTIX_URL.includes('localhost')) {
  console.error('[rebuild2] REFUSING: KORTIX_URL must be the public tunnel (sandbox callback) — got', process.env.KORTIX_URL);
  process.exit(2);
}

const [row] = await db.select().from(sandboxTemplates)
  .where(and(eq(sandboxTemplates.isShared, true), eq(sandboxTemplates.provider, 'platinum')));
console.log('[rebuild2] shared platinum row:', row?.templateId, row?.providerSnapshotName, '->', row?.providerState);
if (row) {
  const r = await refreshTemplateState(row.templateId);
  console.log('[rebuild2] refreshed providerState ->', r?.providerState);
}

const PLATFORM_PROJECT_SHELL = { projectId: '', repoUrl: '', defaultBranch: '', manifestPath: '' } as any;
const t0 = Date.now();
console.log('[rebuild2] building inline on platinum (capture will warm opencode)…');
const res = await ensureSandboxImage(PLATFORM_PROJECT_SHELL, {
  slug: DEFAULT_SANDBOX_SLUG, source: 'manual', provider: 'platinum',
});
console.log('RESULT', JSON.stringify({ ...res, ms: Date.now() - t0 }));
process.exit(0);

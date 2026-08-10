import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
for (const id of ['d936e487', '86c54caa']) {
  const rows = await db.select().from(projects).where(eq((projects as any).status, 'active'));
  for (const p of rows as any[]) {
    if (p.workspaceId.startsWith(id)) {
      await db.update(projects).set({ status: 'archived' } as any).where(eq((projects as any).workspaceId, p.workspaceId));
      console.log('archived', p.workspaceId.slice(0, 8));
    }
  }
}
process.exit(0);

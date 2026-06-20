import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { desc } from 'drizzle-orm';

const rows = await db.select().from(sessionSandboxes).orderBy(desc(sessionSandboxes.createdAt)).limit(3);
for (const r of rows) {
  const m: any = r.metadata ?? {};
  console.log(JSON.stringify({
    session: r.sessionId, extId: r.externalId, provider: r.provider,
    status: r.status, template: m.template, baseUrl: (r as any).baseUrl ?? m.baseUrl,
    created: r.createdAt,
  }));
}
process.exit(0);

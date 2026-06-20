import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { desc } from 'drizzle-orm';
const rows = await db.select().from(sessionSandboxes).orderBy(desc(sessionSandboxes.createdAt)).limit(1);
console.log('EXTID=' + rows[0].externalId);
process.exit(0);

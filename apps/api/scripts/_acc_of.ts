import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
const [p] = await db.select().from(projects).where(eq(projects.projectId, process.env.PID!)).limit(1);
console.log('ACC=' + (p as any)?.accountId);
process.exit(0);

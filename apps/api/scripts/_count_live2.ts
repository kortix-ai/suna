import { db } from '../src/shared/db';
import { projects } from '@kortix/db';
import { sql } from 'drizzle-orm';
const r = await db.select({ s: (projects as any).status, n: sql<number>`count(*)` }).from(projects).groupBy((projects as any).status);
console.log('STATUS', JSON.stringify(r));
process.exit(0);

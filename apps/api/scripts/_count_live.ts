import { db } from '../src/shared/db';
import { sql } from 'drizzle-orm';
const cols: any = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='projects'`);
const names = (Array.isArray(cols) ? cols : cols.rows ?? []).map((c: any) => c.column_name);
console.log('cols:', names.filter((n: string) => /status|delet|archiv/.test(n)).join(','));
for (const probe of ['status', 'deleted_at']) {
  if (!names.includes(probe)) continue;
  const r: any = await db.execute(sql.raw(`SELECT ${probe}::text AS v, count(*) FROM projects GROUP BY 1`));
  console.log(probe, JSON.stringify(Array.isArray(r) ? r : r.rows ?? []));
}
process.exit(0);

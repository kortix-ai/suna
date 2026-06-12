import { db } from '../src/shared/db';
import { accountMembers } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const existing = await db.select().from(accountMembers)
  .where(and(eq(accountMembers.userId, ACC), eq(accountMembers.accountId, ACC)));
console.log('existing membership:', JSON.stringify(existing));
if (!existing.length) {
  await db.insert(accountMembers).values({ userId: ACC, accountId: ACC, accountRole: 'owner' as any });
  console.log('INSERTED owner membership');
} else if (existing[0].accountRole !== 'owner') {
  await db.update(accountMembers).set({ accountRole: 'owner' as any })
    .where(and(eq(accountMembers.userId, ACC), eq(accountMembers.accountId, ACC)));
  console.log('UPDATED to owner');
} else {
  console.log('already owner — 403 is something else');
}
process.exit(0);

import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
const [r] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, process.env.SID!));
console.log('EXT', (r as any)?.externalId, 'created', (r as any)?.createdAt, 'meta', JSON.stringify((r as any)?.metadata ?? {}).slice(0, 200));
process.exit(0);

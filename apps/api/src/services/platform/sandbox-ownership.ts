import { createHash, randomUUID } from 'node:crypto';
import { platformSettings, type Database } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../../lib/config';
import { currentInstanceId } from '../sessions/instance-scope';

const OWNER_KEY = 'sandbox_owner_id';

/** A shared provider credential or environment name does not establish ownership. */
export async function sandboxDatabaseOwner(database: Database): Promise<string> {
  const read = async () => {
    const [row] = await database.select({ value: platformSettings.value })
      .from(platformSettings).where(eq(platformSettings.key, OWNER_KEY));
    return row;
  };
  let row = await read();
  if (!row) {
    await database.insert(platformSettings).values({ key: OWNER_KEY, value: randomUUID() })
      .onConflictDoNothing({ target: platformSettings.key });
    row = await read();
  }
  if (typeof row?.value !== 'string' || !/^[0-9a-f-]{36}$/.test(row.value)) {
    throw new Error('Invalid sandbox_owner_id; refusing provider ownership');
  }
  return row.value;
}

/**
 * Change the managed marker itself: older reapers accept only "true" and must
 * not select these boxes. Unknown ownership fails closed, including DB errors.
 * Preserve sandbox_owner_id on deployment; reset it when cloning a database
 * for an independent installation, before enabling workers or creating boxes.
 */
export async function sandboxOwnershipMarker(database?: Database): Promise<string> {
  const owner = await sandboxDatabaseOwner(database ?? (await import('../../lib/db')).db);
  return `v2-${createHash('sha256').update(JSON.stringify([
    owner, config.INTERNAL_KORTIX_ENV, currentInstanceId() ?? null,
  ])).digest('hex')}`;
}

import { randomUUID } from 'node:crypto';
import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { deliverSalesEvent, SALES_MAX_ATTEMPTS, salesRetryDelay } from './sales-delivery';

/** Claims commit before HTTP. A crash leaves a lease that another worker reclaims. */
export async function processSalesOutbox(database: Database = db): Promise<void> {
  if (!config.SIGNUP_WEBHOOK_URL || !config.SIGNUP_WEBHOOK_SECRET) return;
  const token = randomUUID();
  const rows = await database.execute<{ event_id: string; payload: Record<string, unknown>; attempts: number }>(sql`
    UPDATE kortix.sales_event_outbox SET lease_token = ${token}::uuid,
      available_at = now() + interval '5 minutes', attempts = attempts + 1
    WHERE event_id IN (
      SELECT event_id FROM kortix.sales_event_outbox
      WHERE delivered_at IS NULL AND dead_letter_at IS NULL AND available_at <= now()
      ORDER BY available_at LIMIT 25 FOR UPDATE SKIP LOCKED
    ) RETURNING event_id, payload, attempts
  `);
  for (const row of rows) {
    const error = await deliverSalesEvent(row.payload, config.SIGNUP_WEBHOOK_URL, config.SIGNUP_WEBHOOK_SECRET);
    await database.execute(sql`
      UPDATE kortix.sales_event_outbox SET
        delivered_at = CASE WHEN ${error}::text IS NULL THEN now() ELSE NULL END,
        dead_letter_at = CASE WHEN ${error}::text IS NOT NULL AND ${row.attempts} >= ${SALES_MAX_ATTEMPTS} THEN now() ELSE NULL END,
        available_at = now() + ${salesRetryDelay(row.attempts)} * interval '1 millisecond',
        lease_token = NULL, last_error = ${error}
      WHERE event_id = ${row.event_id} AND lease_token = ${token}::uuid
    `);
  }
}

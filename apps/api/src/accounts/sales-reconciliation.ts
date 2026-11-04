import { timingSafeEqual } from 'node:crypto';
import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { enrichSalesEvent } from './sales-event';
import { enrichSalesCustomer } from './sales-customer-lookup';

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?))?$/.test(value)) return false;
  const offset = value.slice(10).match(/[+-](\d{2})(?::?(\d{2}))?$/);
  if (offset && (Number(offset[1]) > 15 || Number(offset[2] ?? 0) > 59)) return false;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(day) && Number.isFinite(Date.parse(value));
}

export function registerSalesReconciliation(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/v1/system/confirmed-signups',
    tags: ['system'],
    summary: 'Confirmed signups for sales reconciliation',
    description:
      'Signups confirmed in `[from, to)`, 100 per page, ordered by confirmation time then user id. ' +
      'Bearer `SALES_RECONCILIATION_TOKEN` (not a user token). Reuse `upper_watermark` as `to` and pass `next_cursor` until it is null. See `src/accounts/SALES-EVENTS.md`.',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        from: z.string().describe('ISO timestamp, inclusive'),
        to: z.string().optional().describe('ISO timestamp, exclusive; default now'),
        cursor: z.string().optional().describe('next_cursor of the previous page'),
      }),
    },
    responses: {
      200: { description: 'A page of signup events, the upper watermark and the next cursor' },
      400: { description: 'Invalid time range or cursor' },
      401: { description: 'Missing or wrong reconciliation token' },
    },
  });
  app.get('/v1/system/confirmed-signups', async (c) => {
    const expected = config.SALES_RECONCILIATION_TOKEN;
    const received = c.req.header('authorization') ?? '';
    const bearer = `Bearer ${expected}`;
    if (!expected || Buffer.byteLength(received) !== Buffer.byteLength(bearer) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(bearer))) return c.json({ error: 'Unauthorized' }, 401);
    const from = c.req.query('from');
    const upper = c.req.query('to') ?? new Date().toISOString();
    if (!isTimestamp(from) || !isTimestamp(upper) || Date.parse(from) > Date.parse(upper)) {
      return c.json({ error: 'Invalid time range' }, 400);
    }
    let afterTime = from;
    let afterId = '00000000-0000-0000-0000-000000000000';
    const cursor = c.req.query('cursor');
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!parsed || typeof parsed !== 'object' || parsed.from !== from || parsed.to !== upper || !isTimestamp(parsed.time) ||
          !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parsed.id)) throw new Error('cursor');
        afterTime = parsed.time;
        afterId = parsed.id;
      } catch { return c.json({ error: 'Invalid cursor; reuse original from/to watermark' }, 400); }
    }
    const rows = await db.execute<{ id: string; confirmed: string; payload: Record<string, unknown> }>(sql`
      SELECT id::text, email_confirmed_at::text AS confirmed,
        jsonb_build_object('schema_version', 1, 'event_id', 'account.signup:' || id,
          'type', 'account.signup', 'occurred_at', email_confirmed_at,
          'data', jsonb_build_object('user_id', id, 'email', email,
            'name', coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name'),
            'provider', raw_app_meta_data->>'provider', 'source', 'signup',
            'created_at', created_at, 'auth_created_at', created_at,
            'email_confirmed_at', email_confirmed_at, 'email_domain', lower(split_part(email, '@', 2)))) AS payload
      FROM auth.users WHERE email_confirmed_at >= ${from}::timestamptz
        AND email_confirmed_at < ${upper}::timestamptz AND email IS NOT NULL
        AND (email_confirmed_at, id) > (${afterTime}::timestamptz, ${afterId}::uuid)
      ORDER BY email_confirmed_at, id LIMIT 101
    `);
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return c.json({ events: await Promise.all(page.map((row) => enrichSalesCustomer(enrichSalesEvent(row.payload)))), upper_watermark: upper,
      next_cursor: rows.length > 100 && last ? Buffer.from(JSON.stringify({ from, to: upper, time: last.confirmed, id: last.id })).toString('base64url') : null });
  });
}

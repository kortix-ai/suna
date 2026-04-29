import { Hono } from 'hono';
import postgres from 'postgres';
import { db } from '../shared/db';
import { accessRequests } from '@kortix/db';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { config } from '../config';

export const accessControlApp = new Hono();

// Module-level singleton for auth schema queries.
// auth.users lives in the Supabase auth schema — not exposed through the drizzle
// schema — so we need a raw postgres client. Using a singleton avoids opening
// a new TCP connection per check-email call (which exhausts pg connection slots
// under any signup spike).
let _authSql: ReturnType<typeof postgres> | null = null;
function getAuthSql(): ReturnType<typeof postgres> | null {
  if (!config.DATABASE_URL) return null;
  if (!_authSql) {
    _authSql = postgres(config.DATABASE_URL, { max: 2, idle_timeout: 30 });
  }
  return _authSql;
}

async function userExistsInAuth(email: string): Promise<boolean> {
  const sql = getAuthSql();
  if (!sql) return false;
  try {
    const [row] = await sql`
      SELECT 1 FROM auth.users WHERE email = ${email.trim().toLowerCase()} LIMIT 1
    `;
    return !!row;
  } catch {
    return false;
  }
}

// ─── Public endpoints ─────────────────────────────────────────────────────────

accessControlApp.get('/signup-status', (c) => {
  return c.json({ signupsEnabled: areSignupsEnabled() });
});

accessControlApp.post('/check-email', async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email) return c.json({ error: 'email required' }, 400);

  if (canSignUp(email)) {
    return c.json({ allowed: true });
  }

  if (await userExistsInAuth(email)) {
    return c.json({ allowed: true });
  }

  return c.json({ allowed: false });
});

accessControlApp.post('/request-access', async (c) => {
  const body = await c.req.json<{ email: string; company?: string; useCase?: string }>();
  if (!body.email || !body.email.includes('@')) {
    return c.json({ error: 'valid email required' }, 400);
  }

  const normalizedEmail = body.email.trim().toLowerCase();

  // ON CONFLICT DO NOTHING makes duplicate submissions idempotent.
  // The unique constraint on email is added in migration 33.
  await db.insert(accessRequests).values({
    email: normalizedEmail,
    company: body.company || null,
    useCase: body.useCase || null,
  }).onConflictDoNothing();

  return c.json({ success: true, message: 'Access request submitted' });
});

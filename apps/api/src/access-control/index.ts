import { Hono } from 'hono';
import postgres from 'postgres';
import { db } from '../shared/db';
import { accessRequests } from '@kortix/db';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { config } from '../config';

export const accessControlApp = new Hono();

async function userExistsInAuth(email: string): Promise<boolean> {
  if (!config.DATABASE_URL) return false;
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const [row] = await sql`
      SELECT 1 FROM auth.users WHERE email = ${email.trim().toLowerCase()} LIMIT 1
    `;
    return !!row;
  } catch {
    return false;
  } finally {
    await sql.end();
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

  await db.insert(accessRequests).values({
    email: normalizedEmail,
    company: body.company || null,
    useCase: body.useCase || null,
  });

  return c.json({ success: true, message: 'Access request submitted' });
});

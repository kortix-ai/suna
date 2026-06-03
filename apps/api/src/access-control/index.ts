import { Hono } from 'hono';
import postgres from 'postgres';
import { canSignUp } from '../shared/access-control-cache';
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

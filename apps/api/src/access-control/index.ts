import { createRoute, z } from '@hono/zod-openapi';
import postgres from 'postgres';
import { db } from '../shared/db';
import { accessRequests } from '@kortix/db';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { config } from '../config';
import { makeOpenApiApp, json, errors } from '../openapi';

export const accessControlApp = makeOpenApiApp();

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

// ─── Public endpoints (no auth) ───────────────────────────────────────────────

accessControlApp.openapi(
  createRoute({
    method: 'get',
    path: '/signup-status',
    tags: ['access'],
    summary: 'Whether public signups are currently open',
    responses: {
      200: json(z.object({ signupsEnabled: z.boolean() }), 'Signup availability'),
    },
  }),
  (c) => c.json({ signupsEnabled: areSignupsEnabled() }),
);

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/check-email',
    tags: ['access'],
    summary: 'Check whether an email is allowed to sign up',
    request: {
      body: { content: { 'application/json': { schema: z.object({ email: z.string().email() }) } } },
    },
    responses: {
      200: json(z.object({ allowed: z.boolean() }), 'Whether the email may sign up'),
      ...errors(400),
    },
  }),
  async (c) => {
    const { email } = c.req.valid('json');
    if (canSignUp(email)) return c.json({ allowed: true });
    if (await userExistsInAuth(email)) return c.json({ allowed: true });
    return c.json({ allowed: false });
  },
);

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/request-access',
    tags: ['access'],
    summary: 'Submit an early-access / waitlist request',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              company: z.string().optional(),
              useCase: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ success: z.boolean(), message: z.string() }), 'Request submitted'),
      ...errors(400),
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    await db.insert(accessRequests).values({
      email: body.email.trim().toLowerCase(),
      company: body.company || null,
      useCase: body.useCase || null,
    });
    return c.json({ success: true, message: 'Access request submitted' });
  },
);

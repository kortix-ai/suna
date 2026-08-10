import { createRoute, z } from '@hono/zod-openapi';
import { accessRequests } from '@kortix/db';
import postgres from 'postgres';
import { config } from '../config';
import { errors, json, makeOpenApiApp } from '../openapi';
import { getSsoProviderByDomain } from '../repositories/sso';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { db } from '../shared/db';
import { createCheckEmailRateLimitMiddleware } from '../shared/rate-limit';

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

// `mode` drives the unified auth flow: 'signin' when the address already has
// an account, 'signup' when it may register, 'closed' when signups are off and
// the address isn't allowlisted, 'sso' when the domain's org enforces SSO-only
// sign-in (the password/email-code paths must refuse). This is deliberately a
// flow directive, not a raw "exists" boolean — and the per-IP rate limit above
// it is what keeps the endpoint useless for bulk account enumeration
// (`allowed` already implied existence whenever signups were closed, so this
// widens nothing new).
accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/check-email',
    tags: ['access'],
    summary: 'Resolve how an email should proceed through the auth flow',
    middleware: [createCheckEmailRateLimitMiddleware()] as const,
    request: {
      body: {
        content: { 'application/json': { schema: z.object({ email: z.string().email() }) } },
      },
    },
    responses: {
      200: json(
        z.object({ allowed: z.boolean(), mode: z.enum(['signin', 'signup', 'closed', 'sso']) }),
        'Whether the email may sign up, and which auth-flow mode applies',
      ),
      ...errors(400, 429),
    },
  }),
  async (c) => {
    // zod-openapi validates declared JSON bodies. An unsupported content type
    // can still reach the handler without parsed JSON. Reject that input before
    // reading `email`; otherwise `email.trim()` turns malformed public traffic
    // into a 500 response.
    const body = c.req.valid('json') as { email?: unknown } | undefined;
    if (typeof body?.email !== 'string') {
      return c.json({ error: true, message: 'Validation failed', status: 400 }, 400);
    }
    const email = body.email;
    const domain = email.trim().toLowerCase().split('@')[1] || '';
    if (domain) {
      const ssoProvider = await getSsoProviderByDomain(domain).catch(() => null);
      if (ssoProvider?.enforceSso) return c.json({ allowed: true, mode: 'sso' as const });
    }
    if (await userExistsInAuth(email)) return c.json({ allowed: true, mode: 'signin' as const });
    if (canSignUp(email)) return c.json({ allowed: true, mode: 'signup' as const });
    return c.json({ allowed: false, mode: 'closed' as const });
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

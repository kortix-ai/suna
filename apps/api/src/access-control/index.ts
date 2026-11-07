import { createRoute, z } from '@hono/zod-openapi';
import { accessRequests } from '@kortix/db';
import { EffectiveBrandingSchema } from '../accounts/core/app';
import { instanceBranding } from '../accounts/instance-branding';
import { errors, json, makeOpenApiApp } from '../openapi';
import { ssoEnforcedForEmail } from '../repositories/sso';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { db } from '../shared/db';
import { createCheckEmailRateLimitMiddleware } from '../middleware/rate-limit';
import { authEmailState } from '../auth/email-cooldown';

export const accessControlApp = makeOpenApiApp();

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

// The instance branding for signed-out pages (see accounts/instance-branding.ts).
// Public: a product name and logo URLs are what the sign-in page shows anyway.
// `null` on every instance without the enterprise license, the cloud included.
accessControlApp.openapi(
  createRoute({
    method: 'get',
    path: '/branding',
    tags: ['access'],
    summary: 'Instance branding for the sign-in page',
    responses: {
      200: json(
        z.object({ branding: EffectiveBrandingSchema }),
        'The instance branding, or null for default Kortix',
      ),
    },
  }),
  async (c) => c.json({ branding: await instanceBranding() }),
);

// `mode` drives the unified auth flow: 'signin' when the address already has
// an account, 'signup' when it may register, 'closed' when signups are off and
// the address isn't allowlisted, 'sso' when the domain's org enforces SSO-only
// sign-in on a verified domain (the password/email-code paths must refuse; the
// API's headless sign-in routes refuse too). This is deliberately a
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
        z.object({
          allowed: z.boolean(),
          mode: z.enum(['signin', 'signup', 'closed', 'sso']),
          email_retry_after_seconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Present when an auth email went to this address less than a minute ago: seconds until another may be sent.'),
        }),
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
    // SSO-only sign-in applies only to a domain the account proved it controls.
    if (await ssoEnforcedForEmail(email).catch(() => null)) {
      return c.json({ allowed: true, mode: 'sso' as const });
    }
    // Shared pool: a public, rate-limited route must not open a Postgres
    // connection per request.
    const account = await authEmailState(email);
    if (account.exists) {
      // The sign-in form uses the cooldown to answer "already sent" instead of
      // asking GoTrue for another email (auth/email-cooldown.ts).
      return c.json({
        allowed: true,
        mode: 'signin' as const,
        ...(account.retryAfterSeconds ? { email_retry_after_seconds: account.retryAfterSeconds } : {}),
      });
    }
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
    middleware: [createCheckEmailRateLimitMiddleware()] as const,
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
      ...errors(400, 429),
    },
  }),
  async (c) => {
    // Same guard as /check-email: an unsupported content type reaches the
    // handler without parsed JSON, and `email.trim()` would answer 500.
    const body = c.req.valid('json') as { email?: unknown; company?: string; useCase?: string } | undefined;
    if (!body || typeof body.email !== 'string') {
      return c.json({ error: true, message: 'Validation failed', status: 400 }, 400);
    }
    await db.insert(accessRequests).values({
      email: body.email.trim().toLowerCase(),
      company: body.company || null,
      useCase: body.useCase || null,
    });
    return c.json({ success: true, message: 'Access request submitted' });
  },
);

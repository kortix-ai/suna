import { createRoute, z } from '@hono/zod-openapi';
import { accessRequests } from '@kortix/db';
import { EffectiveBrandingSchema } from '../accounts/core/app';
import { instanceBranding } from '../accounts/instance-branding';
import { errors, json, makeOpenApiApp } from '../openapi';
import { ssoEnforcedForEmail } from '../repositories/sso';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { db } from '../shared/db';
import { createCheckEmailRateLimitMiddleware } from '../middleware/rate-limit';

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

// KRTX-3504: this endpoint is public, so its answer must not depend on whether
// the address already has an account — that was an account-existence oracle an
// anonymous caller could sweep against the user base. The answer therefore
// splits only on instance/domain policy, never on account history, and comes
// with no `mode` when the address is simply eligible:
//   { allowed: true }        — every address that may hold an account here
//   { allowed: false, mode:"closed" } — signups closed, address not allowlisted
//   { allowed: true,  mode:"sso" }    — the domain's org enforces SSO-only
//                                       sign-in (the password/email-code paths
//                                       refuse; the headless routes refuse too)
// Eligibility is re-enforced at account creation (web actions, headless
// /auth/signup), and the sign-in door exists for every address: GoTrue answers
// an unknown address exactly like a wrong password. A web client that gets no
// `mode` renders its neutral/adaptive step and signs the visitor in through
// the sign-up path, which falls back to sign-in when the account exists.
// `mode` values 'signin'/'signup' remain in the enum for older deployments;
// a client may still receive them from an API predating this change.
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
        z.object({ allowed: z.boolean(), mode: z.enum(['signin', 'signup', 'closed', 'sso']).optional() }),
        'Whether the email may sign up, and which auth-flow mode applies; `mode` is absent while the address is simply eligible (no account-history signal)',
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
    // Eligibility, not account history: an address that holds an account and
    // one that may create one get the identical body.
    if (canSignUp(email)) return c.json({ allowed: true });
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

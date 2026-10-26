/** The public connect form (read the link, submit the app's credentials) and Shopify's OAuth callback. */
import { createHash } from 'node:crypto';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context, Next } from 'hono';
import { errors, json, lenientBody } from '../../openapi';
import { requestClientKey } from '../../middleware/client-ip';
import { enforceRateLimit } from '../../middleware/rate-limit';
import { TokenBucketRateLimiter } from '../../shared/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../../shared/rate-limit-audit';
import type { ConnectorRouterDeps } from '../router';
import { featureNotSupportedResponse } from './shared';

const TokenParams = z.object({ token: z.string() });

const CapabilitySchema = z.enum(['ok', 'blocked', 'missing_scope', 'error']);
const ShopifyAccessSchema = z.object({
  shop: z.object({ name: z.string().nullable(), domain: z.string().nullable(), currency: z.string().nullable() }),
  catalog: CapabilitySchema,
  orders: CapabilitySchema,
  customers: CapabilitySchema,
  inventory: CapabilitySchema,
});

const AppFormInfoSchema = z
  .object({
    app: z.string(),
    name: z.string(),
    connector: z.string(),
    flow: z.enum(['oauth', 'client_credentials']),
    connected: z.boolean(),
    connected_as: z.string().nullable(),
    expires_at: z.string(),
    shop: z.string().nullable().optional(),
    shared_app: z.boolean().optional(),
    scopes: z.array(z.string()).optional(),
    redirect_uri: z.string().optional(),
    access: ShopifyAccessSchema.nullable().optional(),
  })
  .openapi('ConnectorAppFormInfo');

const AppFormResultSchema = z
  .object({
    connected: z.boolean(),
    connected_as: z.string().optional(),
    success_redirect_uri: z.string().optional(),
    authorize_url: z.string().optional(),
  })
  .openapi('ConnectorAppFormResult');

// `kaf_...` is the wire prefix minted in composio-own-app.ts. Anything else is
// keyed on the client IP, so garbage tokens cannot each claim a fresh bucket.
const TOKEN_LIKE = /^kaf_[A-Za-z0-9_-]{16,4096}$/;
// replica-local: limit × API replicas (shared/rate-limit.ts).
const appFormLimiter = new TokenBucketRateLimiter('connector_app_form');

async function limitPerLink(c: Context, next: Next) {
  const raw = c.req.param('token');
  const key = raw && TOKEN_LIKE.test(raw) ? raw : `ip:${requestClientKey(c)}`;
  const denied = await enforceRateLimit(
    c,
    appFormLimiter,
    key,
    { limit: 20, windowMs: 60_000 },
    {
      action: RATE_LIMIT_EXCEEDED_ACTION,
      resourceType: 'connector_app_form',
      // Never the raw token: it is a live capability.
      resourceId: raw ? `kaf:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}` : null,
      metadata: { limiter: 'connector_app_form' },
    },
  );
  if (denied) return denied;
  await next();
}

async function limitCallbackPerIp(c: Context, next: Next) {
  const denied = await enforceRateLimit(
    c,
    appFormLimiter,
    `shopify-callback:${requestClientKey(c)}`,
    { limit: 30, windowMs: 60_000 },
    {
      action: RATE_LIMIT_EXCEEDED_ACTION,
      resourceType: 'connector_shopify_callback',
      resourceId: null,
      metadata: { limiter: 'connector_shopify_callback' },
    },
  );
  if (denied) return denied;
  await next();
}

export function registerAppFormRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.use('/app-form/:token', limitPerLink);
  app.use('/shopify/callback', limitCallbackPerIp);

  // Shopify redirects the merchant's browser here after approval. No user
  // auth: the one-use state, Shopify's HMAC and the store name authenticate it.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/shopify/callback',
      tags: ['connector'],
      summary: "Shopify OAuth callback (no user auth; state + Shopify's HMAC)",
      request: {
        query: z.object({
          code: z.string().optional(),
          hmac: z.string().optional(),
          shop: z.string().optional(),
          state: z.string().optional(),
          timestamp: z.string().optional(),
          host: z.string().optional(),
        }),
      },
      responses: {
        302: { description: 'Back to the Kortix connect form, with `connected=1` or `error=<code>`' },
        ...errors(400, 501),
      },
    }),
    async (c) => {
      if (!deps.shopifyCallback) return featureNotSupportedResponse(c, 'connector_shopify');
      const outcome = await deps.shopifyCallback(c.req.url);
      if (outcome.status === 302) return c.redirect(outcome.location, 302);
      return c.text(outcome.body, 400);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/app-form/{token}',
      tags: ['connector'],
      summary: 'Read an own-app connect link (no user auth; the token is the capability)',
      request: { params: TokenParams },
      responses: {
        200: json(AppFormInfoSchema, 'The app and connector the link connects'),
        ...errors(404, 409, 410, 501),
      },
    }),
    async (c) => {
      if (!deps.appForm) return featureNotSupportedResponse(c, 'connector_app_form');
      const { token } = c.req.valid('param');
      return c.json(await deps.appForm.info(token), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/app-form/{token}',
      tags: ['connector'],
      summary: "Connect with the app's credentials (no user auth; the token is the capability)",
      request: {
        params: TokenParams,
        body: {
          content: {
            'application/json': {
              schema: lenientBody({
                store: z.string().optional().openapi({ description: "The store's myshopify.com name, host, or admin URL." }),
                client_id: z.string().optional().openapi({ description: "The app's Client ID. Omit to use the deployment's shared Shopify app." }),
                client_secret: z.string().optional().openapi({ description: "The app's Client secret." }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(AppFormResultSchema, 'Connected, or (`connected: false`) the Shopify authorize URL to open'),
        ...errors(400, 404, 409, 410, 422, 501, 502),
      },
    }),
    async (c) => {
      if (!deps.appForm) return featureNotSupportedResponse(c, 'connector_app_form');
      const { token } = c.req.valid('param');
      return c.json(await deps.appForm.submit(token, c.req.valid('json')), 200);
    },
  );
}

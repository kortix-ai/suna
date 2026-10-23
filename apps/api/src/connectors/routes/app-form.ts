/** The public own-app connect form: read the link, then connect with the app's credentials. */
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

const AppFormInfoSchema = z
  .object({
    app: z.string(),
    name: z.string(),
    connector: z.string(),
    connected: z.boolean(),
    connected_as: z.string().nullable(),
    expires_at: z.string(),
  })
  .openapi('ConnectorAppFormInfo');

const AppFormResultSchema = z
  .object({
    connected: z.literal(true),
    connected_as: z.string(),
    success_redirect_uri: z.string().optional(),
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

export function registerAppFormRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  app.use('/app-form/:token', limitPerLink);

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
                client_id: z.string().optional().openapi({ description: "The app's Client ID." }),
                client_secret: z.string().optional().openapi({ description: "The app's Client secret." }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(AppFormResultSchema, 'Connected'),
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

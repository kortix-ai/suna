import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { isUuid } from '../../shared/validate';
import { forgetUserJwtLiveness } from '../../shared/jwt-liveness';
import { listSignedInDevices, signOutDevice } from '../../repositories/auth-devices';
import { accountsRouter, OkSchema } from './app';

const SignedInDeviceSchema = z
  .object({
    session_id: z.string(),
    user_agent: z.string().nullable(),
    ip: z.string().nullable(),
    signed_in_at: z.string(),
    last_active_at: z.string(),
    current: z.boolean(),
  })
  .openapi('SignedInDevice');

// A device is a browser sign-in, so only a browser session may read or end
// one: a PAT or an agent token has no device of its own and must not be able
// to sign its owner out.
const BROWSER_ONLY = { error: 'Signed-in devices need a browser session.' };

// Registered before /:accountId so the static `me` segment is not shadowed.
export function registerDeviceRoutes(): void {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/me/devices',
      tags: ['accounts'],
      summary: "List the caller's signed-in devices",
      ...auth,
      responses: {
        200: json(z.object({ devices: z.array(SignedInDeviceSchema) }), 'Live sign-ins, most recently active first'),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      if (c.get('authType') !== 'supabase') return c.json(BROWSER_ONLY, 403);
      const current = c.get('sessionId') as string | undefined;
      const rows = await listSignedInDevices(c.get('userId') as string);
      return c.json({ devices: rows.map((r) => ({ ...r, current: r.session_id === current })) });
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/me/devices/{sessionId}',
      tags: ['accounts'],
      summary: 'Sign one other device out',
      ...auth,
      request: { params: z.object({ sessionId: z.string() }) },
      responses: {
        200: json(OkSchema, 'The device is signed out'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c) => {
      if (c.get('authType') !== 'supabase') return c.json(BROWSER_ONLY, 403);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid device id.' }, 400);
      if (sessionId === c.get('sessionId')) {
        return c.json({ error: 'This is the current device. Sign out instead.' }, 400);
      }
      const userId = c.get('userId') as string;
      const ok = await signOutDevice(userId, sessionId);
      if (!ok) return c.json({ error: 'Device not found.' }, 404);
      // The liveness cache keys tokens, not sessions, so it cannot drop only the
      // signed-out device: drop the user's entries and let the next request of
      // every device ask GoTrue again. Without this a cached bearer of the
      // signed-out device keeps working until SUPABASE_JWT_LIVENESS_TTL_MS.
      forgetUserJwtLiveness(userId);
      return c.json({ ok: true });
    },
  );
}

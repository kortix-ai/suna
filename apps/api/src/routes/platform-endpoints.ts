import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { getPlatformRole } from '../shared/platform-roles';

export function registerPlatformEndpoints(app: OpenAPIHono) {
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user-roles',
    tags: ['system'],
    summary: 'The caller’s platform role (admin gate)',
    ...auth,
    middleware: [supabaseAuth] as const,
    responses: {
      200: json(
        z.object({ isAdmin: z.boolean(), role: z.string().nullable() }).openapi('UserRoles'),
        'Platform role',
      ),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const accountId = c.get('userId') as string;
    const role = await getPlatformRole(accountId);
    const isAdmin = role === 'admin' || role === 'super_admin';

    return c.json({ isAdmin, role });
  },
);
}

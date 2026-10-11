import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { MobileClientPolicySchema } from '@kortix/api-contract';
import { config } from '../config';
import { json } from '../openapi';

export function registerClientRoutes(app: OpenAPIHono) {
  // Public: the mobile app reads its release policy before the user signs in.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/clients/mobile',
      tags: ['system'],
      summary: 'Mobile release policy: minimum supported app version and store links (public)',
      responses: { 200: json(MobileClientPolicySchema.openapi('MobileClientPolicy'), 'Mobile release policy') },
    }),
    (c) => {
      // The app reads it on every launch; one minute of cache bounds the audit rows.
      c.header('Cache-Control', 'public, max-age=60');
      return c.json({
        minimum_version: config.MOBILE_MIN_VERSION || null,
        store_url_ios: config.MOBILE_STORE_URL_IOS || null,
        store_url_android: config.MOBILE_STORE_URL_ANDROID || null,
      }, 200);
    },
  );
}
